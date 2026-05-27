// AgentRun — dispatched worker lifecycle wrapper.
//
// One AgentRun = one dispatched work unit (researcher, planner, writer,
// reviewer, extractor, agent-designer-when-dispatched, future specialists).
// State machine per design §4.1:
//
//   queued → spawning → running ⇌ paused → completed | failed | cancelled
//
// Owns: cap admission via AgentRunRegistry, LowLevelSpawn lifecycle, all
// timeout enforcement, terminal-state determination, and the AgentRunRecord
// that Session 7 will persist.
//
// Does NOT own: persistence (Session 7), MCP tool wiring (Session 9),
// pause-detection from JSONL (Session 7/8 — pause is externally signaled
// here via _markPaused). The wrapper exposes the state machine; the
// HTTP/MCP layers wire it to PC's surfaces.

import { EventEmitter } from 'node:events';
import type { JsonlEvent } from './jsonl-tailer.ts';
import {
  AgentRunRegistry,
  type AdmissionTicket,
} from './agent-run-registry.ts';
import {
  LowLevelSpawn,
  type LowLevelSpawnInput,
  type PodDescriptor,
  type SpawnState,
} from './low-level-spawn.ts';
import type { ReadyTimestamps } from './ready-gate.ts';
import type { SendResult } from './send-protocol.ts';

export type AgentRunState =
  | 'queued'
  | 'spawning'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentRunFailureCause =
  | 'spawn-stuck'
  | 'idle-timeout'
  | 'wall-clock-timeout'
  | 'ready-timeout'
  | 'spawn-error'
  | 'send-failed'
  | 'unexpected-exit'
  | 'cancel-while-queued'
  | 'cancelled';

export interface AgentRunRecord {
  agentRunId: string;
  ccProviderSessionId: string;
  podName: string;
  state: AgentRunState;
  cause?: AgentRunFailureCause;
  result?: string;
  createdAt: number;
  queuedAt?: number;
  spawningAt?: number;
  readyAt?: number;
  runningAt?: number;
  pausedAt?: number;
  terminalAt?: number;
  /** Set when this run resumes via pc_continue_agent (Session 8 wiring). */
  continues?: string;
  /** Set when an external observer signals a pause via _markPaused. */
  pendingAskId?: string;
}

/** Minimal interface LowLevelSpawn satisfies — lets tests inject a fake. */
export interface SpawnLike extends EventEmitter {
  start(): void;
  awaitReady(): Promise<ReadyTimestamps>;
  send(body: string, echoTimeoutMs?: number): Promise<SendResult>;
  notifyMcpHandshake(): void;
  interrupt(): void;
  kill(graceMs?: number): void;
  getState(): SpawnState;
  getJsonlPath(): string | null;
}

export type SpawnFactory = (input: LowLevelSpawnInput) => SpawnLike;

export interface AgentRunInput {
  agentRunId: string;
  ccProviderSessionId: string;
  podDefinition: PodDescriptor;
  worktreePath: string;
  env: Record<string, string | undefined>;
  /** Pasted as first user turn on fresh spawn (echo-ack). Ignored on resume. */
  initialInput?: string;
  /** Default 'fresh'. 'resume' is used by Session 8's continuation primitive
   *  and by the pause/resume answer-delivery flow. */
  mode?: 'fresh' | 'resume';
  /** Continuation lineage. Set by pc_continue_agent (Session 8 wiring). */
  continues?: string;
  mcpConfigPath?: string;
  settingsPath?: string;
  settingSources?: string;
  pluginDirs?: readonly string[];
  claudeExe?: string;
  transcriptPath?: string;
  // Timeouts (all configurable; defaults per design §4.1):
  /** Catastrophic spawn-failure cap. Default 120_000 (2× handshake). */
  spawnStuckMs?: number;
  /** Reset on every JSONL event. Default 300_000 (5min). */
  idleMs?: number;
  /** Hard ceiling per dispatch; persists through paused. Default 7_200_000 (2h). */
  wallClockMs?: number;
  /** Passed through to LowLevelSpawn. Default 60_000. */
  handshakeTimeoutMs?: number;
  /** Passed through to LowLevelSpawn. Default 60_000. */
  readyTimeoutMs?: number;
  /** Wait this long after kill before declaring cancelled, to catch late
   *  success (Section 18 V-4 lesson on Windows kill-isn't-synchronous).
   *  Default 5_000. */
  cancelGraceMs?: number;
}

export interface AgentRunDeps {
  registry: AgentRunRegistry;
  /** Default = production factory: `(input) => new LowLevelSpawn(input)`. */
  spawnFactory?: SpawnFactory;
  /** Default = `Date.now`. Tests inject a fake. */
  now?: () => number;
}

const DEFAULTS = {
  spawnStuckMs: 120_000,
  idleMs: 300_000,
  wallClockMs: 7_200_000,
  handshakeTimeoutMs: 60_000,
  readyTimeoutMs: 60_000,
  cancelGraceMs: 5_000,
};

const defaultSpawnFactory: SpawnFactory = (input) => new LowLevelSpawn(input);

/**
 * Lifecycle wrapper for one dispatched agent run.
 *
 * Usage:
 *   const run = new AgentRun(input, { registry, spawnFactory });
 *   run.on('state', (next, prev) => ...);
 *   run.on('terminal', ({ status, cause, result }) => ...);
 *   run.on('jsonl-event', (ev) => ...);
 *   run.start();   // begins the lifecycle
 *   run.cancel();  // any time before terminal
 */
export class AgentRun extends EventEmitter {
  private state: AgentRunState = 'queued';
  private record: AgentRunRecord;
  private ticket: AdmissionTicket;
  private spawn: SpawnLike | null = null;
  private started = false;
  private cancelling = false;
  private lastAssistantText: string | null = null;
  private readonly deps: Required<AgentRunDeps>;
  private readonly timeouts: typeof DEFAULTS;

  private timers: {
    spawnStuck?: NodeJS.Timeout;
    idle?: NodeJS.Timeout;
    wallClock?: NodeJS.Timeout;
    cancelGrace?: NodeJS.Timeout;
  } = {};

  constructor(
    private readonly input: AgentRunInput,
    deps: AgentRunDeps,
  ) {
    super();
    this.deps = {
      registry: deps.registry,
      spawnFactory: deps.spawnFactory ?? defaultSpawnFactory,
      now: deps.now ?? (() => Date.now()),
    };
    this.timeouts = {
      spawnStuckMs: input.spawnStuckMs ?? DEFAULTS.spawnStuckMs,
      idleMs: input.idleMs ?? DEFAULTS.idleMs,
      wallClockMs: input.wallClockMs ?? DEFAULTS.wallClockMs,
      handshakeTimeoutMs:
        input.handshakeTimeoutMs ?? DEFAULTS.handshakeTimeoutMs,
      readyTimeoutMs: input.readyTimeoutMs ?? DEFAULTS.readyTimeoutMs,
      cancelGraceMs: input.cancelGraceMs ?? DEFAULTS.cancelGraceMs,
    };
    this.record = {
      agentRunId: input.agentRunId,
      ccProviderSessionId: input.ccProviderSessionId,
      podName: input.podDefinition.logicalName ?? input.podDefinition.name,
      state: 'queued',
      createdAt: this.deps.now(),
      queuedAt: this.deps.now(),
      continues: input.continues,
    };
    this.ticket = this.deps.registry.admit();
  }

  /** Begin the lifecycle. Idempotent at the type level — calling twice
   *  throws. */
  start(): void {
    if (this.started) throw new Error('AgentRun.start() called twice');
    this.started = true;
    // Run the async lifecycle; any unhandled error funnels to a terminal
    // failed state so the cap-slot can't leak.
    this.runLifecycle().catch((err) => {
      this.toTerminal('failed', 'spawn-error', stringify(err));
    });
  }

  /** Trigger transition to a terminal state. State-aware:
   *   - queued        → withdraw from queue; transition to cancelled
   *   - spawning      → kill spawn; wait cancel-grace; transition
   *   - running       → kill spawn; wait cancel-grace for late-success
   *   - paused        → cancel pending ask; transition
   *   - any terminal  → no-op
   */
  cancel(): void {
    if (this.isTerminal()) return;
    if (this.cancelling) return;
    this.cancelling = true;

    if (this.state === 'queued') {
      this.ticket.abort();
      // The lifecycle's `await ticket.granted` will reject and route through
      // the cancel-while-queued terminal path.
      return;
    }

    // Once cancellation starts, lifecycle timeout timers should not race the
    // cancel-grace owner into a failed terminal state.
    this.clearSpawnStuck();
    this.clearIdleTimer();
    this.clearWallClock();

    // spawning / running / paused -> kill and wait grace
    if (this.spawn) {
      try {
        this.spawn.kill();
      } catch {
        /* already dead */
      }
    }
    this.armCancelGrace();
  }

  /** External signal: an observer (Session 8's MCP route or Session 7's
   *  tailer pause-detector) has detected a pause. Transition running→paused.
   *  No-op if state isn't 'running'. */
  _markPaused(askId: string): void {
    if (this.state !== 'running') return;
    this.record.pendingAskId = askId;
    this.record.pausedAt = this.deps.now();
    this.clearIdleTimer();
    this.setState('paused');
    this.emit('paused', askId);
  }

  /** External signal: the answer arrived. Session 8 wires this to spawn a
   *  resume LowLevelSpawn with the answer as initialInput. For Session 6
   *  scope this just transitions paused→spawning and re-arms the lifecycle.
   *
   *  The wrapper takes a fresh SpawnLike from the factory (resume mode)
   *  and walks it through the same ready-gate → running flow. */
  _resumeWithAnswer(answer: string): void {
    if (this.state !== 'paused') return;
    if (this.cancelling) return;
    this.record.pendingAskId = undefined;
    this.setState('spawning');
    this.record.spawningAt = this.deps.now();
    this.armSpawnStuck();
    this.runSpawnPhase('resume', answer).catch((err) => {
      this.toTerminal('failed', 'spawn-error', stringify(err));
    });
  }

  /** Direct MCP handshake notification — Session 18's
   *  /api/internal/mcp-handshake route calls this. Idempotent. */
  notifyMcpHandshake(): void {
    this.spawn?.notifyMcpHandshake();
  }

  getState(): AgentRunState {
    return this.state;
  }

  getRecord(): AgentRunRecord {
    return { ...this.record };
  }

  isTerminal(): boolean {
    return (
      this.state === 'completed' ||
      this.state === 'failed' ||
      this.state === 'cancelled'
    );
  }

  // -- internals ------------------------------------------------------

  private async runLifecycle(): Promise<void> {
    // Phase 1: queued → wait for admission
    try {
      await this.ticket.granted;
    } catch {
      // Ticket aborted — only happens via cancel() while queued.
      this.toTerminal('cancelled', 'cancel-while-queued');
      return;
    }

    if (this.state !== 'queued') return; // raced — shouldn't normally happen

    this.emit('queued-started');

    this.setState('spawning');
    this.record.spawningAt = this.deps.now();
    this.armSpawnStuck();
    this.armWallClock();

    const mode: 'fresh' | 'resume' = this.input.mode ?? 'fresh';
    await this.runSpawnPhase(mode, this.input.initialInput);
  }

  /** Walks the spawn → ready → running phase. Shared by initial dispatch
   *  AND resume-with-answer. Stops at running; the rest of the lifecycle
   *  is event-driven from spawn events. */
  private async runSpawnPhase(
    mode: 'fresh' | 'resume',
    inputBody: string | undefined,
  ): Promise<void> {
    // Build the LowLevelSpawn input. Caller (Session 9 wiring) is expected
    // to have already materialized the pod + rewritten `.mcp.json`; here
    // we just hand the descriptor through.
    const llsInput: LowLevelSpawnInput = {
      podDefinition: this.input.podDefinition,
      worktreePath: this.input.worktreePath,
      env: this.input.env,
      ccProviderSessionId: this.input.ccProviderSessionId,
      mode,
      // initialInput is delivered explicitly via echo-ack after the gate
      // opens; we don't pass it to LowLevelSpawn (LowLevelSpawn doesn't
      // auto-send either — kept here as a no-op pass-through field).
      mcpConfigPath: this.input.mcpConfigPath,
      settingsPath: this.input.settingsPath,
      settingSources: this.input.settingSources,
      pluginDirs: this.input.pluginDirs,
      claudeExe: this.input.claudeExe,
      transcriptPath: this.input.transcriptPath,
      handshakeTimeoutMs: this.timeouts.handshakeTimeoutMs,
      readyTimeoutMs: this.timeouts.readyTimeoutMs,
    };
    const spawn = this.deps.spawnFactory(llsInput);
    this.spawn = spawn;

    spawn.on('jsonl-event', (ev: JsonlEvent) => this.onJsonlEvent(ev));
    spawn.on('exit', (code, signal) => this.onSpawnExit(code, signal));
    spawn.on('state', (s: SpawnState) => this.emit('spawn-state', s));
    spawn.on('chunk', (text: string) => this.emit('chunk', text));
    spawn.on('ready', (ts: ReadyTimestamps) => this.emit('ready', ts));

    spawn.start();

    try {
      await spawn.awaitReady();
    } catch (err) {
      if (this.cancelling) {
        // Cancel path is handling its own terminal; no-op here. Cancel-grace
        // window will fire completeCancel().
        return;
      }
      this.toTerminal('failed', 'ready-timeout', stringify(err));
      return;
    }

    this.clearSpawnStuck();
    this.record.readyAt = this.deps.now();

    if (this.cancelling || this.isTerminal()) return;

    this.setState('running');
    this.record.runningAt = this.deps.now();
    this.armIdleTimer();

    if (inputBody !== undefined && inputBody.length > 0) {
      try {
        const sendResult = await spawn.send(inputBody);
        if (sendResult !== 'ok') {
          this.toTerminal('failed', 'send-failed', `send: ${sendResult}`);
          return;
        }
      } catch (err) {
        this.toTerminal('failed', 'send-failed', stringify(err));
        return;
      }
    }

    // From here, lifecycle is event-driven via onJsonlEvent / onSpawnExit /
    // cancel / _markPaused.
  }

  private onJsonlEvent(ev: JsonlEvent): void {
    this.emit('jsonl-event', ev);
    if (this.state === 'running') {
      // Reset idle on activity.
      this.resetIdleTimer();
    }
    // Capture last assistant text for the completed-state result field.
    const text = extractAssistantText(ev);
    if (text !== null) this.lastAssistantText = text;
    // Turn-end signal (the OR rule per design §7.1).
    if (isTurnEnd(ev) && this.state === 'running') {
      // Normal completion path. ALSO the late-success path during cancel-
      // grace: state is still 'running' (we don't transition during grace),
      // so a turn-end landing in the grace window after kill() honors as
      // completion per the Section 18 V-4 lesson — Windows kill() isn't
      // synchronous, so reporting cancelled while the run actually finished
      // is a regression we explicitly tolerate this race for.
      this.toTerminal(
        'completed',
        undefined,
        this.lastAssistantText ?? '',
      );
    }
  }

  private onSpawnExit(_code: number | null, _signal: number | null): void {
    // Pause is the only state where a clean exit is expected. In any other
    // non-terminal state, a spawn exit is unexpected → failed.
    if (this.isTerminal()) return;
    if (this.state === 'paused') return; // CC exits cleanly when paused
    if (this.cancelling) return; // cancel-grace owns the terminal call
    this.toTerminal('failed', 'unexpected-exit');
  }

  private setState(next: AgentRunState): void {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.record.state = next;
    this.emit('state', next, prev);
  }

  private toTerminal(
    next: 'completed' | 'failed' | 'cancelled',
    cause?: AgentRunFailureCause,
    result?: string,
  ): void {
    if (this.isTerminal()) return;
    this.clearAllTimers();
    this.record.cause = cause;
    this.record.result = next === 'completed' ? (result ?? '') : undefined;
    this.record.terminalAt = this.deps.now();
    this.setState(next);
    // Release the cap-slot. Idempotent — release / abort both safe here.
    this.ticket.release();
    // Terminal means this dispatched worker is done. CC returns to a prompt
    // after a normal turn-end, so explicitly kill the PTY here too; otherwise
    // completed agents can leave idle node.exe/claude.exe children behind.
    if (this.spawn) {
      try {
        this.spawn.kill();
      } catch {
        /* already dead */
      }
    }
    this.emit('terminal', {
      status: next,
      cause,
      result: this.record.result,
    });
  }

  private armSpawnStuck(): void {
    this.clearSpawnStuck();
    this.timers.spawnStuck = setTimeout(() => {
      if (this.state === 'spawning') {
        this.toTerminal('failed', 'spawn-stuck');
        if (this.spawn) {
          try {
            this.spawn.kill();
          } catch {
            /* already dead */
          }
        }
      }
    }, this.timeouts.spawnStuckMs);
  }
  private clearSpawnStuck(): void {
    if (this.timers.spawnStuck) {
      clearTimeout(this.timers.spawnStuck);
      this.timers.spawnStuck = undefined;
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.timers.idle = setTimeout(() => {
      if (this.state === 'running') {
        this.toTerminal('failed', 'idle-timeout');
        if (this.spawn) {
          try {
            this.spawn.kill();
          } catch {
            /* already dead */
          }
        }
      }
    }, this.timeouts.idleMs);
  }
  private resetIdleTimer(): void {
    if (this.timers.idle) this.armIdleTimer();
  }
  private clearIdleTimer(): void {
    if (this.timers.idle) {
      clearTimeout(this.timers.idle);
      this.timers.idle = undefined;
    }
  }

  private armWallClock(): void {
    if (this.timers.wallClock) return; // arm once; persists through paused
    this.timers.wallClock = setTimeout(() => {
      if (!this.isTerminal()) {
        this.toTerminal('failed', 'wall-clock-timeout');
        if (this.spawn) {
          try {
            this.spawn.kill();
          } catch {
            /* already dead */
          }
        }
      }
    }, this.timeouts.wallClockMs);
  }
  private clearWallClock(): void {
    if (this.timers.wallClock) {
      clearTimeout(this.timers.wallClock);
      this.timers.wallClock = undefined;
    }
  }

  private armCancelGrace(): void {
    this.clearCancelGrace();
    this.timers.cancelGrace = setTimeout(() => {
      this.completeCancel();
    }, this.timeouts.cancelGraceMs);
  }
  private clearCancelGrace(): void {
    if (this.timers.cancelGrace) {
      clearTimeout(this.timers.cancelGrace);
      this.timers.cancelGrace = undefined;
    }
  }

  /** End of cancel-grace window. If the spawn produced a late turn-end
   *  (Section 18 V-4 lesson — Windows kill isn't synchronous), the
   *  onJsonlEvent path will have already transitioned to completed; this
   *  function only fires the cancelled terminal if we're not yet done. */
  private completeCancel(): void {
    if (this.isTerminal()) return;
    this.toTerminal('cancelled', 'cancelled');
  }

  private clearAllTimers(): void {
    this.clearSpawnStuck();
    this.clearIdleTimer();
    this.clearWallClock();
    this.clearCancelGrace();
  }
}

// -- helpers ----------------------------------------------------------

function stringify(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Extract the assistant's text from a JSONL event. Handles both the v1
 *  JsonlTailer event shape (`{ kind: 'jsonl-turn-end', text, stopReason }`)
 *  AND the v2 AgentRunJsonlTailer / fake-event shape that carries a raw `row`
 *  field. Returns null when neither shape applies. */
function extractAssistantText(ev: JsonlEvent): string | null {
  // v1/v2 typed shape — `jsonl-turn-end` carries the assistant text directly
  // on the event.
  if ((ev as { kind?: unknown }).kind === 'jsonl-turn-end') {
    const t = (ev as { text?: unknown }).text;
    return typeof t === 'string' && t.length > 0 ? t : null;
  }
  // Raw-row fallback — Session 6 tests + future v2 tailer pass-throughs feed
  // events shaped as `{ row: <jsonl-line-as-object> }`.
  const row = (ev as { row?: unknown }).row ?? (ev as { entry?: unknown }).entry;
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (r.type !== 'assistant') return null;
  const msg = (r.message ?? r) as Record<string, unknown>;
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .filter(
        (c): c is { type: 'text'; text: string } =>
          typeof c === 'object' &&
          c !== null &&
          (c as { type?: unknown }).type === 'text' &&
          typeof (c as { text?: unknown }).text === 'string',
      )
      .map((c) => c.text)
      .join('');
    return text || null;
  }
  return null;
}

/** Turn-end signal — assistant row with stop_reason !== 'tool_use'. Detects
 *  both event shapes: the v1 JsonlTailer's `kind: 'jsonl-turn-end'` (the
 *  production tailer Session 5's LowLevelSpawn wires through) AND the
 *  raw-row shape used by Session 6's unit tests + Session 7's
 *  AgentRunJsonlTailer (which carries `row` alongside `kind`). */
function isTurnEnd(ev: JsonlEvent): boolean {
  // v1/v2 typed shape — the tailer itself decided this line ends the turn.
  // The tailer filters out `tool_use` stop reasons before emitting, so this
  // event kind is by-definition a real turn boundary.
  if ((ev as { kind?: unknown }).kind === 'jsonl-turn-end') {
    const stopReason = (ev as { stopReason?: unknown }).stopReason;
    if (stopReason === 'tool_use') return false;
    return true;
  }
  // Raw-row fallback (Session 6 fake events / future inline detection).
  const row = (ev as { row?: unknown }).row ?? (ev as { entry?: unknown }).entry;
  if (!row || typeof row !== 'object') return false;
  const r = row as Record<string, unknown>;
  if (r.type !== 'assistant') return false;
  const msg = (r.message ?? r) as Record<string, unknown>;
  const stopReason = msg.stop_reason ?? (r as Record<string, unknown>).stop_reason;
  if (stopReason === 'tool_use') return false;
  return stopReason === 'end_turn' || stopReason === 'stop_sequence' ||
         stopReason === 'max_tokens';
}
