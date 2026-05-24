// InteractiveSession — long-running session lifecycle wrapper.
//
// Orchestrator, agent-designer modal, future interview surfaces — anywhere
// a human types input and the model responds across many turns. Compare
// to AgentRun (dispatched, one-shot, cap-bound, pause-able).
//
// State machine per design §4.2:
//
//   spawning → ready ⇌ running → exited
//
// (ready ↔ running cycles every turn: send() → running; turn-end → ready.)
//
// Differences vs AgentRun:
//   - No queue, no cap (one orchestrator + at most a couple interview
//     specialists; capping them would block the user mid-flow).
//   - No AgentRunRecord persistence concern — orchestrator's
//     OrchestratorSession row covers identity; transient sessions write
//     nothing persistent beyond on-disk JSONL.
//   - No pause primitive. `pc_ask_orchestrator` / `pc_ask_user` are
//     dispatched-only tools. AskUserQuestion goes through a separate
//     ask-intercept hook, not this wrapper.
//   - Resume semantics are session-level (Section 5++), via
//     mode='resume' on construction. There's no "answer-resume" flow here.

import { EventEmitter } from 'node:events';
import type { JsonlEvent } from './jsonl-tailer.ts';
import {
  LowLevelSpawn,
  type LowLevelSpawnInput,
  type PodDescriptor,
  type SpawnState,
} from './low-level-spawn.ts';
import type { ReadyTimestamps } from './ready-gate.ts';
import type { SendResult } from './send-protocol.ts';
import type { SpawnFactory, SpawnLike } from './agent-run.ts';

export type InteractiveSessionState =
  | 'spawning'
  | 'ready'
  | 'running'
  | 'exited';

export interface InteractiveSessionInput {
  pcSessionId: string;
  ccProviderSessionId: string;
  podDefinition: PodDescriptor;
  worktreePath: string;
  env: Record<string, string | undefined>;
  /** 'fresh' = mint a new conversation; 'resume' = continue an existing
   *  on-disk session by --resume <uuid>. */
  mode?: 'fresh' | 'resume';
  /** Body to send as the first user turn after the gate opens. Optional —
   *  many interactive sessions start idle and wait for the user to type. */
  initialInput?: string;
  mcpConfigPath?: string;
  claudeExe?: string;
  transcriptPath?: string;
  handshakeTimeoutMs?: number;
  readyTimeoutMs?: number;
}

export interface InteractiveSessionDeps {
  /** Default = production factory: `(input) => new LowLevelSpawn(input)`. */
  spawnFactory?: SpawnFactory;
  /** Default = `Date.now`. */
  now?: () => number;
}

const defaultSpawnFactory: SpawnFactory = (input: LowLevelSpawnInput) =>
  new LowLevelSpawn(input);

export class InteractiveSession extends EventEmitter {
  private state: InteractiveSessionState = 'spawning';
  private spawn: SpawnLike | null = null;
  private started = false;
  private closing = false;
  private readonly deps: Required<InteractiveSessionDeps>;
  private timestamps: {
    spawningAt?: number;
    readyAt?: number;
    exitedAt?: number;
  } = {};

  constructor(
    private readonly input: InteractiveSessionInput,
    deps: InteractiveSessionDeps = {},
  ) {
    super();
    this.deps = {
      spawnFactory: deps.spawnFactory ?? defaultSpawnFactory,
      now: deps.now ?? (() => Date.now()),
    };
  }

  /** Begin the lifecycle. Idempotent — throws on second call. */
  start(): void {
    if (this.started) throw new Error('InteractiveSession.start() called twice');
    this.started = true;
    this.timestamps.spawningAt = this.deps.now();
    this.runLifecycle().catch((err) => {
      this.emit('error', err);
      this.toExited();
    });
  }

  /** Send body to the running session. Only valid in 'ready' / 'running'.
   *  Returns the echo-ack result from the underlying spawn. */
  async send(body: string): Promise<SendResult> {
    if (!this.spawn) throw new Error('InteractiveSession: send before start');
    if (this.state === 'exited') return 'exited';
    if (this.state === 'spawning') {
      throw new Error('InteractiveSession: send before ready');
    }
    const result = await this.spawn.send(body);
    if (result === 'ok' && this.state === 'ready') {
      this.setState('running');
    }
    return result;
  }

  /** Send escape — CC's stop-streaming key. */
  interrupt(): void {
    this.spawn?.interrupt();
  }

  /** Close the session — kill the child and transition to exited.
   *  Idempotent. */
  close(): void {
    if (this.state === 'exited' || this.closing) return;
    this.closing = true;
    try {
      this.spawn?.kill();
    } catch {
      /* already dead */
    }
    // onSpawnExit will land via spawn's 'exit' event and call toExited.
    // Defensive: if the spawn never wired (e.g. closed before start completed)
    // transition synchronously.
    if (!this.spawn) this.toExited();
  }

  /** Pass-through for the /api/internal/mcp-handshake route. */
  notifyMcpHandshake(): void {
    this.spawn?.notifyMcpHandshake();
  }

  getState(): InteractiveSessionState {
    return this.state;
  }

  getJsonlPath(): string | null {
    return this.spawn?.getJsonlPath() ?? null;
  }

  // -- internals ------------------------------------------------------

  private async runLifecycle(): Promise<void> {
    const mode: 'fresh' | 'resume' = this.input.mode ?? 'fresh';
    const llsInput: LowLevelSpawnInput = {
      podDefinition: this.input.podDefinition,
      worktreePath: this.input.worktreePath,
      env: this.input.env,
      ccProviderSessionId: this.input.ccProviderSessionId,
      mode,
      mcpConfigPath: this.input.mcpConfigPath,
      claudeExe: this.input.claudeExe,
      transcriptPath: this.input.transcriptPath,
      handshakeTimeoutMs: this.input.handshakeTimeoutMs,
      readyTimeoutMs: this.input.readyTimeoutMs,
    };
    const spawn = this.deps.spawnFactory(llsInput);
    this.spawn = spawn;

    spawn.on('jsonl-event', (ev: JsonlEvent) => this.onJsonlEvent(ev));
    spawn.on('exit', () => this.toExited());
    spawn.on('state', (s: SpawnState) => this.emit('spawn-state', s));
    spawn.on('chunk', (text: string) => this.emit('chunk', text));
    spawn.on('ready', (ts: ReadyTimestamps) => this.emit('ready', ts));

    spawn.start();

    try {
      await spawn.awaitReady();
    } catch (err) {
      // Ready gate failed (timeout or pre-ready exit). If close() was already
      // called, exit will arrive separately; otherwise treat as exited.
      if (!this.closing) {
        this.emit('error', err);
      }
      this.toExited();
      return;
    }

    this.timestamps.readyAt = this.deps.now();
    if (this.closing || this.state === 'exited') return;
    this.setState('ready');

    if (this.input.initialInput && this.input.initialInput.length > 0) {
      try {
        const result = await spawn.send(this.input.initialInput);
        if (result === 'ok' && this.state === 'ready') {
          this.setState('running');
        }
      } catch (err) {
        this.emit('error', err);
      }
    }
  }

  private onJsonlEvent(ev: JsonlEvent): void {
    this.emit('jsonl-event', ev);
    if (isTurnEnd(ev) && this.state === 'running') {
      // Turn cycle complete; session goes back to ready awaiting next user input.
      this.setState('ready');
    }
  }

  private setState(next: InteractiveSessionState): void {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.emit('state', next, prev);
  }

  private toExited(): void {
    if (this.state === 'exited') return;
    this.timestamps.exitedAt = this.deps.now();
    this.setState('exited');
    this.emit('exited');
  }
}

function isTurnEnd(ev: JsonlEvent): boolean {
  const row = (ev as { row?: unknown }).row ?? (ev as { entry?: unknown }).entry;
  if (!row || typeof row !== 'object') return false;
  const r = row as Record<string, unknown>;
  if (r.type !== 'assistant') return false;
  const msg = (r.message ?? r) as Record<string, unknown>;
  const stopReason =
    msg.stop_reason ?? (r as Record<string, unknown>).stop_reason;
  if (stopReason === 'tool_use') return false;
  return (
    stopReason === 'end_turn' ||
    stopReason === 'stop_sequence' ||
    stopReason === 'max_tokens'
  );
}
