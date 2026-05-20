// Section 16b.4 — Agent-run lifecycle manager.
//
// One run record per `pc_invoke_agent` call, keyed by PC-minted `runId`.
// Holds the per-run PtySession, timers, status, accumulating result text,
// and the completion Promise that sync callers await + that the async
// dispatcher fires terminal channel events from.
//
// The novel piece vs. subagent-spawner: pause detection. When the agent
// calls `pc_ask_orchestrator`, its turn ends naturally (jsonl-turn-end
// fires). subagent-spawner would treat that as "done." Here we instead
// query `pending_asks` for the agent's sessionId at turn-end:
//   - waiting row present → status='paused', completion stays unresolved,
//     wall-clock timer keeps running, idle timer paused. Resume primitive
//     (16b.4.2) re-attaches a fresh PtySession when the orchestrator
//     answers.
//   - no waiting row → status='completed', resolve completion with the
//     accumulated last-assistant-text.
//
// Lifecycle:
//   spawn → spawning → ready → running → (paused → running)* → completed | failed | cancelled
//
// Failure causes:
//   - 'timeout' (wall-clock cap)
//   - 'idle-timeout' (no JSONL event for N seconds)
//   - 'spawn-failed' (PtySession constructor or pod-prep threw)
//   - 'spawn-exit' (process exited before reaching a terminal turn-end)
//   - 'cancelled' (cancel() called)

import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { listWaitingPendingAsksForSession, newId } from '@pc/db';
import type { ULID } from '@pc/domain';
import {
  encodeCwdForClaude,
  PtySession,
  type PtySessionOptions,
  type SessionState,
} from '@pc/runtime';
import type { JsonlEvent } from '@pc/runtime';

import { preparePodSpawn, type PodSpawnPrep } from './pod-spawn.ts';

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_WALL_CLOCK_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_READY_TIMEOUT_MS = 30_000;

export type AgentRunStatus =
  | 'spawning'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentRunFailureCause =
  | 'timeout'
  | 'idle-timeout'
  | 'spawn-failed'
  | 'spawn-exit'
  | 'cancelled'
  | 'unknown-agent';

export interface AgentRunRecord {
  runId: ULID;
  sessionId: string;
  agentName: string;
  projectId: ULID;
  parentWorkItemId: ULID | null;
  /** Whether the caller requested an inline result (`true`) or a fire-and-
   *  forget dispatch that emits a terminal channel event (`false`). The
   *  manager only consults this when emitting terminal events — sync vs.
   *  async dispatch shape is the route handler's concern. */
  wait: boolean;
  startedAt: number;
  status: AgentRunStatus;
  /** Accumulating last-assistant-text. Updated on every jsonl-turn-end so
   *  a paused run resuming + completing still carries the right final
   *  text. */
  result: string;
  failureReason: string | null;
  failureCause: AgentRunFailureCause | null;
  endedAt: number | null;
}

/** What sync callers await. Resolves once on terminal (completed / failed /
 *  cancelled). Never rejects — the record's status field carries the
 *  outcome. */
export type AgentRunCompletion = Promise<AgentRunRecord>;

export interface AgentRunSpawnInput {
  agentName: string;
  input: string;
  wait: boolean;
  projectId: ULID;
  /** Absolute path to the project's worktree (cwd for the spawn). */
  worktreeDir: string;
  parentWorkItemId?: ULID | null;
  idleTimeoutMs?: number;
  wallClockTimeoutMs?: number;
  readyTimeoutMs?: number;
}

export interface AgentRunSpawnResult {
  runId: ULID;
  sessionId: string;
  startedAt: number;
  completion: AgentRunCompletion;
}

/** Subset of PtySession the manager needs. Real PtySession satisfies it;
 *  tests supply a fake. */
export interface AgentSessionLike extends EventEmitter {
  send(text: string): void;
  kill(): void;
  getState(): SessionState;
}

export interface AgentRunManagerDeps {
  /** Factory for the underlying session. Defaults to `new PtySession(opts)`. */
  createSession?: (opts: PtySessionOptions) => AgentSessionLike;
  /** Where per-run scratch dirs land. Defaults to
   *  `<dataRoot>/projects/<projectId>/agent-runs/<runId>/`. */
  scratchDirFor?: (projectId: ULID, runId: ULID) => string;
  /** Resolve `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. */
  resolveJsonlPath?: (folderPath: string, sessionId: string) => string;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

interface InternalRun extends AgentRunRecord {
  session: AgentSessionLike | null;
  podCleanup: (() => void) | null;
  scratchDir: string;
  worktreeDir: string;
  initialInput: string;
  idleTimer: unknown;
  wallClockTimer: unknown;
  idleTimeoutMs: number;
  wallClockTimeoutMs: number;
  readyTimeoutMs: number;
  initialInputSent: boolean;
  resolveCompletion: ((rec: AgentRunRecord) => void) | null;
}

export class AgentRunManager {
  private runs = new Map<ULID, InternalRun>();

  constructor(private deps: AgentRunManagerDeps = {}) {}

  /** Look up an active or terminal run by id. */
  get(runId: ULID): AgentRunRecord | null {
    return this.runs.get(runId) ?? null;
  }

  /** Snapshot the currently-tracked runs for a project. */
  listForProject(projectId: ULID): AgentRunRecord[] {
    const out: AgentRunRecord[] = [];
    for (const r of this.runs.values()) if (r.projectId === projectId) out.push(r);
    return out;
  }

  /** Mint a runId + sessionId, materialise the pod, spawn the agent, and
   *  hand back a Promise that resolves on terminal. Throws synchronously
   *  only on pod-resolution failure for an unknown agent name; any post-
   *  spawn failure surfaces via `completion`. */
  spawn(input: AgentRunSpawnInput): AgentRunSpawnResult {
    const runId = newId() as ULID;
    const sessionId = randomUUID();
    const startedAt = Date.now();

    const scratchDir =
      (this.deps.scratchDirFor ?? defaultScratchDirFor)(input.projectId, runId);
    try {
      mkdirSync(scratchDir, { recursive: true });
    } catch (err) {
      const rec = this.makeRecord({
        runId,
        sessionId,
        agentName: input.agentName,
        projectId: input.projectId,
        parentWorkItemId: input.parentWorkItemId ?? null,
        wait: input.wait,
        startedAt,
        scratchDir,
        worktreeDir: input.worktreeDir,
        initialInput: input.input,
        idleTimeoutMs: input.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
        wallClockTimeoutMs: input.wallClockTimeoutMs ?? DEFAULT_WALL_CLOCK_TIMEOUT_MS,
        readyTimeoutMs: input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      });
      const completion = this.installCompletionPromise(rec);
      this.runs.set(runId, rec);
      this.fail(rec, 'spawn-failed', `scratchDir mkdir failed: ${(err as Error).message}`);
      return { runId, sessionId, startedAt, completion };
    }

    // Section 17a.5 — when a pod row exists, materialise it (writes the
    // `.claude/agents/<name>.md` + temp mcp.json into scratchDir). Returns
    // null when no pod row exists; the spawn falls back to the project's
    // flat-file `<project>/.claude/agents/<name>.md` + `<project>/.mcp.json`.
    // Symmetric with the workflow-runtime subagent path.
    let podPrep: PodSpawnPrep | null = null;
    try {
      podPrep = preparePodSpawn({
        agentName: input.agentName,
        worktreeDir: input.worktreeDir,
        scratchDir,
      });
    } catch (err) {
      const rec = this.makeRecord({
        runId,
        sessionId,
        agentName: input.agentName,
        projectId: input.projectId,
        parentWorkItemId: input.parentWorkItemId ?? null,
        wait: input.wait,
        startedAt,
        scratchDir,
        worktreeDir: input.worktreeDir,
        initialInput: input.input,
        idleTimeoutMs: input.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
        wallClockTimeoutMs: input.wallClockTimeoutMs ?? DEFAULT_WALL_CLOCK_TIMEOUT_MS,
        readyTimeoutMs: input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      });
      const completion = this.installCompletionPromise(rec);
      this.runs.set(runId, rec);
      this.fail(
        rec,
        'spawn-failed',
        `pod materialisation failed for "${input.agentName}": ${(err as Error).message}`,
      );
      return { runId, sessionId, startedAt, completion };
    }

    const rec = this.makeRecord({
      runId,
      sessionId,
      agentName: input.agentName,
      projectId: input.projectId,
      parentWorkItemId: input.parentWorkItemId ?? null,
      wait: input.wait,
      startedAt,
      scratchDir,
      worktreeDir: input.worktreeDir,
      initialInput: input.input,
      idleTimeoutMs: input.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      wallClockTimeoutMs: input.wallClockTimeoutMs ?? DEFAULT_WALL_CLOCK_TIMEOUT_MS,
      readyTimeoutMs: input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    });
    rec.podCleanup = podPrep?.cleanup ?? null;
    const completion = this.installCompletionPromise(rec);
    this.runs.set(runId, rec);

    const jsonlPath = (this.deps.resolveJsonlPath ?? defaultResolveJsonlPath)(
      input.worktreeDir,
      sessionId,
    );

    const sessionOpts: PtySessionOptions = {
      workspaceDir: input.worktreeDir,
      stopMarkerPath: resolve(scratchDir, 'stop-markers.txt'),
      eventsPath: resolve(scratchDir, 'events.jsonl'),
      transcriptPath: resolve(scratchDir, 'transcript.log'),
      claudeSessionId: sessionId,
      resume: false,
      jsonlPath,
      jsonlStartLine: 0,
      agentName: input.agentName,
      mcpConfigPath: podPrep?.mcpConfigPath,
      loadDevChannels: false,
      extraEnv: {
        ...(podPrep?.extraEnv ?? {}),
        PC_AGENT_NAME: input.agentName,
        PC_AGENT_SESSION_ID: sessionId,
        PC_AGENT_RUN_ID: runId,
        ...(input.parentWorkItemId ? { PC_AGENT_PARENT_WORK_ITEM_ID: input.parentWorkItemId } : {}),
        PC_PROJECT_ID: input.projectId,
      },
    };

    let session: AgentSessionLike;
    try {
      session = (this.deps.createSession ?? defaultCreateSession)(sessionOpts);
    } catch (err) {
      this.fail(rec, 'spawn-failed', `pty spawn failed: ${(err as Error).message}`);
      return { runId, sessionId, startedAt, completion };
    }

    this.attachToSession(rec, session);
    this.armWallClockTimer(rec);
    this.armIdleTimer(rec);

    return { runId, sessionId, startedAt, completion };
  }

  /** 16b.4.2 — wire a freshly-resumed PtySession into an existing run.
   *  Called by `respawnAgentWithAnswer` when the resumed agent matches a
   *  tracked runId (looked up via sessionId). Re-arms idle timer + jsonl
   *  listeners on the new session. Wall-clock continues from the original
   *  spawn — pause time counts against the cap. */
  attachResumedSession(runId: ULID, session: AgentSessionLike): boolean {
    const rec = this.runs.get(runId);
    if (!rec) return false;
    if (this.isTerminal(rec.status)) return false;
    rec.status = 'running';
    rec.initialInputSent = true; // resume's answer-write is the next user message
    this.attachToSession(rec, session);
    this.armIdleTimer(rec);
    return true;
  }

  /** Cancel an in-flight run. Kills the active session, flips status to
   *  cancelled, resolves the completion Promise. No-op if already
   *  terminal. */
  cancel(runId: ULID, reason = 'cancelled by user'): boolean {
    const rec = this.runs.get(runId);
    if (!rec || this.isTerminal(rec.status)) return false;
    this.failWithCause(rec, 'cancelled', reason);
    return true;
  }

  /** Look up the most-recent tracked run for a CC session id. Used by
   *  `respawnAgentWithAnswer` to find the runId to re-attach. */
  findRunIdBySession(sessionId: string): ULID | null {
    for (const r of this.runs.values()) {
      if (r.sessionId === sessionId && !this.isTerminal(r.status)) return r.runId;
    }
    return null;
  }

  private makeRecord(args: {
    runId: ULID;
    sessionId: string;
    agentName: string;
    projectId: ULID;
    parentWorkItemId: ULID | null;
    wait: boolean;
    startedAt: number;
    scratchDir: string;
    worktreeDir: string;
    initialInput: string;
    idleTimeoutMs: number;
    wallClockTimeoutMs: number;
    readyTimeoutMs: number;
  }): InternalRun {
    return {
      runId: args.runId,
      sessionId: args.sessionId,
      agentName: args.agentName,
      projectId: args.projectId,
      parentWorkItemId: args.parentWorkItemId,
      wait: args.wait,
      startedAt: args.startedAt,
      status: 'spawning',
      result: '',
      failureReason: null,
      failureCause: null,
      endedAt: null,
      session: null,
      podCleanup: null,
      scratchDir: args.scratchDir,
      worktreeDir: args.worktreeDir,
      initialInput: args.initialInput,
      idleTimer: null,
      wallClockTimer: null,
      idleTimeoutMs: args.idleTimeoutMs,
      wallClockTimeoutMs: args.wallClockTimeoutMs,
      readyTimeoutMs: args.readyTimeoutMs,
      initialInputSent: false,
      resolveCompletion: null,
    };
  }

  private installCompletionPromise(rec: InternalRun): AgentRunCompletion {
    return new Promise<AgentRunRecord>((res) => {
      rec.resolveCompletion = res;
    });
  }

  private attachToSession(rec: InternalRun, session: AgentSessionLike): void {
    rec.session = session;

    session.on('state', (state: SessionState) => {
      if (this.isTerminal(rec.status)) return;
      if (state === 'ready' && !rec.initialInputSent) {
        rec.initialInputSent = true;
        rec.status = 'running';
        try {
          session.send(rec.initialInput);
        } catch (err) {
          this.fail(rec, 'spawn-failed', `send initialInput failed: ${(err as Error).message}`);
        }
      } else if (state === 'ready' && rec.status === 'spawning') {
        // attachResumedSession case: initial input was the prior turn's
        // answer-write, not the spawn input. Just flip running.
        rec.status = 'running';
      }
    });

    session.on('jsonl-event', (ev: JsonlEvent) => {
      if (this.isTerminal(rec.status)) return;
      this.armIdleTimer(rec); // reset on every event
      if (ev.kind === 'jsonl-turn-end') {
        this.onTurnEnd(rec, ev.text);
      }
    });

    session.on('exit', (code: number | null, signal: string | null) => {
      if (this.isTerminal(rec.status)) {
        this.cleanupOnTerminal(rec);
        return;
      }
      if (rec.status === 'paused') {
        // Expected — agent ended its turn and the process closed naturally
        // after pc_ask_orchestrator. Resume will spawn a fresh session.
        // Drop the session reference but keep the record alive.
        rec.session = null;
        return;
      }
      this.fail(
        rec,
        'spawn-exit',
        `agent process exited before completing (code=${code ?? 'null'} signal=${signal ?? 'null'})`,
      );
    });
  }

  private onTurnEnd(rec: InternalRun, text: string): void {
    if (text) rec.result = text;
    const waiting = listWaitingPendingAsksForSession(rec.sessionId);
    if (waiting.length > 0) {
      // Paused — keep wall-clock running, stop idle timer (process exits
      // naturally), keep record alive for resume.
      this.clearIdleTimer(rec);
      rec.status = 'paused';
      try {
        rec.session?.kill();
      } catch {
        /* best-effort */
      }
      return;
    }
    // No outstanding pause → terminal complete.
    this.complete(rec);
  }

  private complete(rec: InternalRun): void {
    if (this.isTerminal(rec.status)) return;
    rec.status = 'completed';
    rec.endedAt = Date.now();
    this.clearTimers(rec);
    try {
      rec.session?.kill();
    } catch {
      /* best-effort */
    }
    this.cleanupOnTerminal(rec);
    rec.resolveCompletion?.(this.snapshot(rec));
  }

  private fail(rec: InternalRun, cause: AgentRunFailureCause, reason: string): void {
    this.failWithCause(rec, cause, reason);
  }

  private failWithCause(rec: InternalRun, cause: AgentRunFailureCause, reason: string): void {
    if (this.isTerminal(rec.status)) return;
    rec.status = cause === 'cancelled' ? 'cancelled' : 'failed';
    rec.failureCause = cause;
    rec.failureReason = reason;
    rec.endedAt = Date.now();
    this.clearTimers(rec);
    try {
      rec.session?.kill();
    } catch {
      /* best-effort */
    }
    this.cleanupOnTerminal(rec);
    rec.resolveCompletion?.(this.snapshot(rec));
  }

  private cleanupOnTerminal(rec: InternalRun): void {
    try {
      rec.podCleanup?.();
    } catch {
      /* best-effort */
    }
    rec.podCleanup = null;
    rec.session = null;
  }

  private armIdleTimer(rec: InternalRun): void {
    if (this.isTerminal(rec.status)) return;
    this.clearIdleTimer(rec);
    const setT = this.deps.setTimeout ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
    rec.idleTimer = setT(() => {
      this.fail(
        rec,
        'idle-timeout',
        `agent idle for ${Math.round(rec.idleTimeoutMs / 1000)}s — likely hung`,
      );
    }, rec.idleTimeoutMs);
  }

  private armWallClockTimer(rec: InternalRun): void {
    if (rec.wallClockTimer) return;
    const setT = this.deps.setTimeout ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
    rec.wallClockTimer = setT(() => {
      this.fail(
        rec,
        'timeout',
        `agent exceeded wall-clock cap of ${Math.round(rec.wallClockTimeoutMs / 1000)}s`,
      );
    }, rec.wallClockTimeoutMs);
  }

  private clearIdleTimer(rec: InternalRun): void {
    if (rec.idleTimer) {
      const clearT = this.deps.clearTimeout ?? ((h) => globalThis.clearTimeout(h as NodeJS.Timeout));
      clearT(rec.idleTimer);
      rec.idleTimer = null;
    }
  }

  private clearTimers(rec: InternalRun): void {
    this.clearIdleTimer(rec);
    if (rec.wallClockTimer) {
      const clearT = this.deps.clearTimeout ?? ((h) => globalThis.clearTimeout(h as NodeJS.Timeout));
      clearT(rec.wallClockTimer);
      rec.wallClockTimer = null;
    }
  }

  private isTerminal(s: AgentRunStatus): boolean {
    return s === 'completed' || s === 'failed' || s === 'cancelled';
  }

  /** Public-facing shape: hide the internal timer / session fields. */
  private snapshot(rec: InternalRun): AgentRunRecord {
    return {
      runId: rec.runId,
      sessionId: rec.sessionId,
      agentName: rec.agentName,
      projectId: rec.projectId,
      parentWorkItemId: rec.parentWorkItemId,
      wait: rec.wait,
      startedAt: rec.startedAt,
      status: rec.status,
      result: rec.result,
      failureReason: rec.failureReason,
      failureCause: rec.failureCause,
      endedAt: rec.endedAt,
    };
  }
}

function defaultCreateSession(opts: PtySessionOptions): AgentSessionLike {
  return new PtySession(opts) as unknown as AgentSessionLike;
}

function defaultScratchDirFor(projectId: ULID, runId: ULID): string {
  const root = process.env.PC_DATA_DIR ?? 'data';
  return resolve(root, 'projects', projectId, 'agent-runs', runId);
}

function defaultResolveJsonlPath(folderPath: string, sessionId: string): string {
  return resolve(
    homedir(),
    '.claude',
    'projects',
    encodeCwdForClaude(folderPath),
    `${sessionId}.jsonl`,
  );
}

/** Process-wide singleton. Wired into the server on boot; routes + the
 *  resume primitive both consume it. Tests construct their own
 *  `AgentRunManager` with stubbed deps. */
let singleton: AgentRunManager | null = null;

export function getAgentRunManager(): AgentRunManager {
  if (!singleton) singleton = new AgentRunManager();
  return singleton;
}

export function setAgentRunManager(mgr: AgentRunManager): void {
  singleton = mgr;
}
