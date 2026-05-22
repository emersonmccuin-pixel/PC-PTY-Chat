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
//   spawn → (queued →)? spawning → ready → running → (paused → running)* → completed | failed | cancelled
//
// Section 18.7 — `queued` is the optional first state when the global
// concurrent cap (`agentDispatch.maxConcurrent`) is full at dispatch. The
// FIFO queue drains its head whenever a non-terminal run reaches terminal.
// Cancelled-while-queued just flips to `cancelled` and the queue's
// `processQueue` skips the stale entry next pass.
//
// Failure causes:
//   - 'timeout' (wall-clock cap)
//   - 'idle-timeout' (no JSONL event for N seconds)
//   - 'spawn-failed' (PtySession constructor or pod-prep threw)
//   - 'spawn-exit' (process exited before reaching a terminal turn-end)
//   - 'cancelled' (cancel() called)

import { EventEmitter } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { defaultLibraryDir } from './agent-library.ts';

import {
  getAgentByName,
  getGlobalSettings,
  listWaitingPendingAsksForSession,
  newId,
} from '@pc/db';
import { clampMaxConcurrent, type ULID } from '@pc/domain';
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
const DEFAULT_MAX_CONCURRENT = 5;

/** 18.B-mcp-race — minimal warmup prompt sent on first ready. CC's MCP child
 *  (pc-rig under `npx -y tsx ...`) takes 1–3s to register tools; the first
 *  user turn fires before that finishes, so the model sees a partial tool
 *  surface (built-ins only). Subsequent turns re-bind tools and pick up the
 *  MCP entries. The warmup burns the race: one cheap turn so the real input
 *  ships against a fully-bound tool surface. Disable by passing
 *  `warmupPrompt: null` in `AgentRunManagerDeps` (tests + emergency knob). */
const DEFAULT_WARMUP_PROMPT = 'Reply with only the word OK.';

/** 16b.4.5 — maximum nested `pc_invoke_agent` depth. Orchestrator dispatches
 *  at depth 1; an agent dispatched by that one runs at depth 2; etc. At depth
 *  5, further nesting is rejected with `cause: 'depth-cap'` so a runaway
 *  chain can't burn the subscription. */
export const AGENT_INVOKE_DEPTH_CAP = 5;

/** Pure-function depth check. Caller passes the *parent's* depth (0 for the
 *  orchestrator, otherwise the value read from `PC_AGENT_INVOKE_DEPTH`); the
 *  helper returns the child's depth on success or a `depth-cap` rejection
 *  when the cap would be exceeded. Negative inputs and NaN clamp to 0 so a
 *  malformed env var doesn't silently allow unbounded nesting. */
export function checkInvokeDepth(
  parentInvokeDepth: number,
):
  | { ok: true; childDepth: number }
  | { ok: false; cause: 'depth-cap'; error: string } {
  const safeParent =
    Number.isFinite(parentInvokeDepth) && parentInvokeDepth > 0
      ? Math.floor(parentInvokeDepth)
      : 0;
  const childDepth = safeParent + 1;
  if (childDepth > AGENT_INVOKE_DEPTH_CAP) {
    return {
      ok: false,
      cause: 'depth-cap',
      error: `pc_invoke_agent rejected: parent depth ${safeParent} would push child to ${childDepth}, exceeding cap ${AGENT_INVOKE_DEPTH_CAP}`,
    };
  }
  return { ok: true, childDepth };
}

export type AgentRunStatus =
  | 'queued'
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
  /** Section 18.5a — CC sessionId of the orchestrator that dispatched this
   *  agent. Terminal channel events route back to THIS session (not just
   *  "the project's most-recent registrant" as pre-18.5a). Required —
   *  every legitimate caller of `pc_invoke_agent` is an orchestrator that
   *  knows its own sessionId via `PC_SESSION_ID`. */
  dispatcherSessionId: string;
  /** Whether the caller requested an inline result (`true`) or a fire-and-
   *  forget dispatch that emits a terminal channel event (`false`). The
   *  manager only consults this when emitting terminal events — sync vs.
   *  async dispatch shape is the route handler's concern. */
  wait: boolean;
  /** Absolute path to the project worktree the agent was spawned in.
   *  Surfaced for the Activity Panel's live-transcript modal header
   *  (16b.8.3) so the user can see *where* the agent is running. */
  worktreeDir: string;
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
  /** Section 18.5a — CC sessionId of the orchestrator dispatching this
   *  agent. Required: terminal channel events route back to this session.
   *  The route handler reads `dispatcherSessionId` from the MCP tool's
   *  HTTP body, which the pc-rig MCP server forwards from `PC_SESSION_ID`. */
  dispatcherSessionId: string;
  /** Absolute path to the project's worktree (cwd for the spawn). */
  worktreeDir: string;
  parentWorkItemId?: ULID | null;
  /** 16b.4.5 — this child's nesting depth. Orchestrator-initiated spawns
   *  pass 1; subsequent `pc_invoke_agent` calls increment. Set on the
   *  child's `PC_AGENT_INVOKE_DEPTH` env var so its own `pc_invoke_agent`
   *  invocations can forward as `parentInvokeDepth`. Defaults to 1 when
   *  omitted (most callers route through `checkInvokeDepth` first). */
  invokeDepth?: number;
  idleTimeoutMs?: number;
  wallClockTimeoutMs?: number;
  readyTimeoutMs?: number;
}

export interface AgentRunSpawnResult {
  runId: ULID;
  sessionId: string;
  /** When the dispatch landed. For under-cap spawns this is also the real
   *  spawn-start time. For queued dispatches it's the queue-entry time;
   *  the actual spawn-start time arrives later via `record.startedAt` once
   *  the queue drains (manager updates the record + emits `run-changed`). */
  startedAt: number;
  completion: AgentRunCompletion;
  /** Section 18.7 — true when the global concurrent cap was full at
   *  dispatch and the run was enqueued. The completion Promise still
   *  resolves on terminal — but the spawn happens whenever the queue
   *  drains, not immediately. */
  queued: boolean;
  /** Section 18.7 — 1-based queue position at dispatch time (1 = head of
   *  queue, will spawn next). Null when not queued. Position is a
   *  snapshot, not a live counter — by the time the orchestrator surfaces
   *  it to the user, the real position may have decreased as runs ahead
   *  drained. */
  position: number | null;
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
  /** Section 18.7 — read the global cap on concurrent non-terminal runs.
   *  Defaults to reading `agentDispatch.maxConcurrent` from the DB-backed
   *  global settings (with the `clampMaxConcurrent` clamp) and falling
   *  back to 5 on any DB error. Tests pass a constant for deterministic
   *  cap behaviour. */
  getMaxConcurrent?: () => number;
  /** 18.B-mcp-race — warmup prompt sent on first ready, before the real
   *  initial input. `undefined` → use `DEFAULT_WARMUP_PROMPT`. `null` →
   *  disable warmup entirely (tests + emergency override; the legacy
   *  "send initialInput immediately on ready" path is restored). The
   *  warmup turn is visible in the JSONL transcript and the live-
   *  transcript modal, but is otherwise transparent to callers. */
  warmupPrompt?: string | null;
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
  /** 18.B-mcp-race — true once the warmup turn has been sent. The real
   *  `initialInput` is held back until the warmup's `jsonl-turn-end` lands
   *  so the model's tool surface re-binds against a connected pc-rig. On
   *  the resume path warmupSent is initialised true (MCP tools are already
   *  bound from the prior session). When the manager runs with
   *  `warmupPrompt: null`, the constructor presets this to true so the
   *  ready-state handler falls through to the legacy "send initialInput
   *  immediately" path. */
  warmupSent: boolean;
  resolveCompletion: ((rec: AgentRunRecord) => void) | null;
  /** Section 18.6 — timestamp of the first non-system JSONL event from this
   *  run's underlying CC process. Confirms the agent booted, read the prompt,
   *  and the model is engaged. Null until the first such event lands. */
  firstJsonlAt: number | null;
  /** Section 18.6 — pending `waitForFirstJsonl` resolvers. Flushed when
   *  `firstJsonlAt` is first set. */
  firstJsonlResolvers: Array<() => void>;
  /** Section 18.7 — when this run entered the queue (status='queued').
   *  Null for runs that started under cap. Carried into the
   *  `agent-queued-started` event when the queue drains so the orchestrator
   *  can surface "waited ~Xs" to the user. */
  queuedAt: number | null;
  /** Section 18.7 — prepared sessionOpts stashed at pre-flight time. The
   *  under-cap path consumes them immediately via `finishSpawn`; the queued
   *  path stashes them on the record + consumes when the queue drains. */
  pendingSessionOpts: PtySessionOptions | null;
}

/** AgentRunManager is an EventEmitter — Section 16b.8.1 + 16b.8.3.
 *
 * Events:
 *   - `run-changed` — fires once per meaningful state transition (spawning
 *      → running, → paused, → running, → completed | failed | cancelled),
 *      plus once at end of `spawn()` so the initial `spawning` record is
 *      observable. Payload is the `AgentRunRecord` snapshot (no internal
 *      timer / session refs). Server `index.ts` subscribes and rebroadcasts
 *      to project WS subscribers as `{ type: 'agent-run-changed', record }`.
 *   - `run-jsonl-event` — Section 16b.8.3. Fires for every `jsonl-event`
 *      emitted by the run's PtySession, tagged with `{ runId, projectId,
 *      event }`. Server `index.ts` subscribes + rebroadcasts to project WS
 *      subscribers as `{ type: 'agent-jsonl-event', runId, event }`. Feeds
 *      the Activity Panel's live-transcript modal. Terminal-state runs stop
 *      forwarding (the session's `jsonl-event` listener is gated on
 *      `isTerminal(rec.status)` upstream).
 */
export class AgentRunManager extends EventEmitter {
  private runs = new Map<ULID, InternalRun>();
  /** Section 18.7 — FIFO queue of runIds parked because the global
   *  concurrent cap was full at dispatch. Drained from the head whenever a
   *  non-terminal run reaches terminal (`complete` / `failWithCause`). Stale
   *  entries (cancelled-while-queued) are skipped in `processQueue` rather
   *  than removed eagerly, so cancel doesn't pay an O(N) array splice. */
  private queue: ULID[] = [];

  /** 18.B-mcp-race — resolved warmup prompt. `null` disables warmup; any
   *  string (including the default) enables it. Resolved once at
   *  construction so per-spawn paths don't re-check `deps`. */
  private warmupPrompt: string | null;

  constructor(private deps: AgentRunManagerDeps = {}) {
    super();
    this.warmupPrompt =
      deps.warmupPrompt === undefined ? DEFAULT_WARMUP_PROMPT : deps.warmupPrompt;
  }

  /** Look up an active or terminal run by id. */
  get(runId: ULID): AgentRunRecord | null {
    return this.runs.get(runId) ?? null;
  }

  /** Snapshot the currently-tracked runs for a project. Includes terminal
   *  rows still in the map; callers filter as needed (the Activity Panel
   *  filters to non-terminal). */
  listForProject(projectId: ULID): AgentRunRecord[] {
    const out: AgentRunRecord[] = [];
    for (const r of this.runs.values()) if (r.projectId === projectId) out.push(this.snapshot(r));
    return out;
  }

  /** Single emit site so the snapshot stays canonical. */
  private emitRunChanged(rec: InternalRun): void {
    this.emit('run-changed', this.snapshot(rec));
  }

  /** Mint a runId + sessionId, materialise the pod, spawn the agent, and
   *  hand back a Promise that resolves on terminal. Throws synchronously
   *  only on pod-resolution failure for an unknown agent name; any post-
   *  spawn failure surfaces via `completion`. */
  spawn(input: AgentRunSpawnInput): AgentRunSpawnResult {
    const runId = newId() as ULID;
    const sessionId = randomUUID();
    const startedAt = Date.now();

    // B4 (2026-05-21) — fail-fast on unknown agent names. Without this,
    // `--agent <unknown>` falls through to CC's default coding-assistant
    // prompt + full tool surface and the dispatch returns whatever that
    // CC happens to say — looks like `agent-completed` to the caller, with
    // no indication the requested agent never existed. Resolution checks
    // (in priority order): pod row → project flat-file → global flat-file.
    const agentSource = resolveAgentSource(input.agentName, input.worktreeDir);
    if (!agentSource) {
      const rec = this.makeRecord({
        runId,
        sessionId,
        agentName: input.agentName,
        projectId: input.projectId,
        parentWorkItemId: input.parentWorkItemId ?? null,
        dispatcherSessionId: input.dispatcherSessionId,
        wait: input.wait,
        startedAt,
        scratchDir: '',
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
        'unknown-agent',
        `no agent named "${input.agentName}" found in pod registry, in <worktree>/.claude/agents/${input.agentName}.md, or in the global library at ~/.project-companion/agents/${input.agentName}.md`,
      );
      return { runId, sessionId, startedAt, completion, queued: false, position: null };
    }

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
        dispatcherSessionId: input.dispatcherSessionId,
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
      return { runId, sessionId, startedAt, completion, queued: false, position: null };
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
        filterMcpToReferencedTools: true,
      });
    } catch (err) {
      const rec = this.makeRecord({
        runId,
        sessionId,
        agentName: input.agentName,
        projectId: input.projectId,
        parentWorkItemId: input.parentWorkItemId ?? null,
        dispatcherSessionId: input.dispatcherSessionId,
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
      return { runId, sessionId, startedAt, completion, queued: false, position: null };
    }

    // B7 (2026-05-21) — when the agent resolves only via the global library
    // (`~/.project-companion/agents/<name>.md`), copy the .md into the
    // worktree so CC's `--agent` flag finds it. Cleanup removes the copy
    // on terminal so the worktree stays clean. Skipped when the worktree
    // already has a same-named file (= project override or pod-materialised
    // file from above).
    let globalMaterializeCleanup: (() => void) | null = null;
    if (agentSource === 'global-flat-file') {
      try {
        globalMaterializeCleanup = materializeGlobalFlatFileAgent(input.agentName, input.worktreeDir);
      } catch (err) {
        const rec = this.makeRecord({
          runId,
          sessionId,
          agentName: input.agentName,
          projectId: input.projectId,
          parentWorkItemId: input.parentWorkItemId ?? null,
          dispatcherSessionId: input.dispatcherSessionId,
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
          `global agent materialisation failed for "${input.agentName}": ${(err as Error).message}`,
        );
        return { runId, sessionId, startedAt, completion, queued: false, position: null };
      }
    }

    const rec = this.makeRecord({
      runId,
      sessionId,
      agentName: input.agentName,
      projectId: input.projectId,
      parentWorkItemId: input.parentWorkItemId ?? null,
      dispatcherSessionId: input.dispatcherSessionId,
      wait: input.wait,
      startedAt,
      scratchDir,
      worktreeDir: input.worktreeDir,
      initialInput: input.input,
      idleTimeoutMs: input.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      wallClockTimeoutMs: input.wallClockTimeoutMs ?? DEFAULT_WALL_CLOCK_TIMEOUT_MS,
      readyTimeoutMs: input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    });
    // Chain pod-cleanup + global-materialize-cleanup so both run on terminal.
    const podCleanup = podPrep?.cleanup ?? null;
    rec.podCleanup =
      podCleanup && globalMaterializeCleanup
        ? () => {
            try { podCleanup(); } catch { /* best-effort */ }
            try { globalMaterializeCleanup!(); } catch { /* best-effort */ }
          }
        : podCleanup ?? globalMaterializeCleanup;
    const completion = this.installCompletionPromise(rec);

    const jsonlPath = (this.deps.resolveJsonlPath ?? defaultResolveJsonlPath)(
      input.worktreeDir,
      sessionId,
    );

    rec.pendingSessionOpts = {
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
        // Section 18.5a — pass the dispatching orchestrator's sessionId so the
        // agent's pc-rig MCP child can forward it on pause emits (pc_ask_*
        // routes use it as the recipientSessionId for the channel push).
        PC_DISPATCHER_SESSION_ID: input.dispatcherSessionId,
        ...(input.parentWorkItemId ? { PC_AGENT_PARENT_WORK_ITEM_ID: input.parentWorkItemId } : {}),
        PC_PROJECT_ID: input.projectId,
        PC_AGENT_INVOKE_DEPTH: String(
          Number.isFinite(input.invokeDepth) && (input.invokeDepth ?? 0) > 0
            ? Math.floor(input.invokeDepth as number)
            : 1,
        ),
      },
    };

    // Section 18.7 — cap check happens BEFORE inserting into `this.runs`, so
    // the count excludes the run we're about to dispatch (otherwise the
    // default `status: 'spawning'` from `makeRecord` would always make the
    // count include the current dispatch and bump every first-after-cap run
    // into the queue erroneously). Pre-flight side effects (scratchDir, pod
    // materialisation, global flat-file copy) already ran — they live in the
    // worktree until cleanup-on-terminal regardless of whether we spawn now
    // or later. podCleanup is wired even for queued runs so cancel-while-
    // queued still removes the materialised files.
    const cap = this.getCapValue();
    const atCap = this.countRunningOrPaused() >= cap;
    if (atCap) {
      rec.status = 'queued';
      rec.queuedAt = startedAt;
    }
    this.runs.set(runId, rec);
    if (atCap) {
      this.queue.push(runId);
      this.emitRunChanged(rec);
      return {
        runId,
        sessionId,
        startedAt,
        completion,
        queued: true,
        position: this.queue.length,
      };
    }

    this.finishSpawn(rec);
    return { runId, sessionId, startedAt, completion, queued: false, position: null };
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
    // 18.B-mcp-race — the resumed CC re-attaches to a session whose MCP tool
    // surface was bound during the prior turn. Skip warmup so we don't burn
    // an extra LLM call (and don't double-respond to the pending answer).
    rec.warmupSent = true;
    this.attachToSession(rec, session);
    this.armIdleTimer(rec);
    this.emitRunChanged(rec); // paused → running transition
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

  /** Section 18.6 — resolves when the run's first non-system JSONL event
   *  arrives. Callers (the `pc_invoke_agent` HTTP route) race this against
   *  an external ack timer. Resolves immediately if the first event already
   *  landed. Resolves on terminal too so racing callers don't dangle when a
   *  spawn fails before any event lands — post-resolve, callers check
   *  `getFirstJsonlAt(runId)` to disambiguate acked vs. terminal-without-ack. */
  waitForFirstJsonl(runId: ULID): Promise<void> {
    const rec = this.runs.get(runId);
    if (!rec) return Promise.resolve();
    if (rec.firstJsonlAt !== null) return Promise.resolve();
    if (this.isTerminal(rec.status)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      rec.firstJsonlResolvers.push(resolve);
    });
  }

  /** Section 18.6 — timestamp the run's first non-system JSONL event landed,
   *  or null if no such event has arrived (spawn still booting, spawn failed
   *  before any event, or run never existed). The `pc_invoke_agent` route
   *  reads this after `waitForFirstJsonl` resolves to decide the response's
   *  `acked` field. */
  getFirstJsonlAt(runId: ULID): number | null {
    const rec = this.runs.get(runId);
    return rec?.firstJsonlAt ?? null;
  }

  private flushFirstJsonlResolvers(rec: InternalRun): void {
    if (rec.firstJsonlResolvers.length === 0) return;
    const resolvers = rec.firstJsonlResolvers;
    rec.firstJsonlResolvers = [];
    for (const r of resolvers) {
      try {
        r();
      } catch {
        /* best-effort */
      }
    }
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
    dispatcherSessionId: string;
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
      dispatcherSessionId: args.dispatcherSessionId,
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
      // 18.B-mcp-race — pre-set when warmup is disabled so the ready-state
      // handler falls through to the legacy send-initialInput path.
      warmupSent: this.warmupPrompt === null,
      resolveCompletion: null,
      firstJsonlAt: null,
      firstJsonlResolvers: [],
      queuedAt: null,
      pendingSessionOpts: null,
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
      if (state === 'ready' && !rec.warmupSent && this.warmupPrompt !== null) {
        // 18.B-mcp-race — CC's MCP child (pc-rig under `npx -y tsx ...`)
        // hasn't finished registering tools at the welcome banner. Send a
        // warmup turn so the second turn (the real initialInput) re-binds
        // the model's tool surface against connected MCP servers. Status
        // stays 'spawning' through the warmup so callers can't see a
        // transient 'running' that's actually pre-real-prompt.
        rec.warmupSent = true;
        try {
          session.send(this.warmupPrompt);
        } catch (err) {
          this.fail(rec, 'spawn-failed', `send warmup failed: ${(err as Error).message}`);
        }
      } else if (state === 'ready' && !rec.initialInputSent) {
        // Legacy path: warmup disabled (tests + emergency knob). Send the
        // real initialInput immediately on ready.
        rec.initialInputSent = true;
        rec.status = 'running';
        this.emitRunChanged(rec); // spawning → running
        try {
          session.send(rec.initialInput);
        } catch (err) {
          this.fail(rec, 'spawn-failed', `send initialInput failed: ${(err as Error).message}`);
        }
      } else if (state === 'ready' && rec.status === 'spawning') {
        // attachResumedSession case: initial input was the prior turn's
        // answer-write, not the spawn input. Just flip running.
        rec.status = 'running';
        this.emitRunChanged(rec);
      }
    });

    session.on('jsonl-event', (ev: JsonlEvent) => {
      if (this.isTerminal(rec.status)) return;
      this.armIdleTimer(rec); // reset on every event

      // 18.B-mcp-race — warmup's turn-end is our cue to send the real
      // initialInput. By now CC has bound the model's tool surface against
      // a connected pc-rig (the warmup turn forced a tools_changed pass).
      // Suppress all downstream handlers for this event: it isn't the
      // agent's real first event (no ack), it isn't a terminal turn (no
      // complete/pause), and we don't want it in firstJsonlAt math.
      if (
        rec.warmupSent &&
        !rec.initialInputSent &&
        ev.kind === 'jsonl-turn-end'
      ) {
        rec.initialInputSent = true;
        rec.status = 'running';
        this.emitRunChanged(rec); // spawning → running
        try {
          rec.session?.send(rec.initialInput);
        } catch (err) {
          this.fail(rec, 'spawn-failed', `send initialInput failed: ${(err as Error).message}`);
        }
        return;
      }

      // Section 18.6 — the first non-system JSONL event from this run is the
      // ack signal. Confirms CC booted, read the prompt, and the model is
      // engaged. Async-dispatch routes await it via `waitForFirstJsonl`.
      // 18.B-mcp-race — gated on initialInputSent so the warmup turn's
      // events don't accidentally fulfil the ack contract.
      if (
        rec.initialInputSent &&
        rec.firstJsonlAt === null &&
        ev.kind !== 'jsonl-system'
      ) {
        rec.firstJsonlAt = Date.now();
        this.flushFirstJsonlResolvers(rec);
      }
      // 16b.8.3 — forward every event for the live-transcript modal.
      // Emits before the turn-end branch so the closing `jsonl-turn-end`
      // also lands in the modal.
      this.emit('run-jsonl-event', { runId: rec.runId, projectId: rec.projectId, event: ev });
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
      // naturally), keep record alive for resume. Pause detection is
      // session-state-driven; doesn't care whether the closing assistant
      // message had text or was thinking-only.
      this.clearIdleTimer(rec);
      rec.status = 'paused';
      try {
        rec.session?.kill();
      } catch {
        /* best-effort */
      }
      this.emitRunChanged(rec);
      return;
    }
    // B1 (2026-05-20) — Opus 4.7 emits TWO consecutive `stop_reason: end_turn`
    // assistant messages on one logical turn when interleaved thinking is on:
    // a thinking-only message (no text content blocks) followed by a text-only
    // message. The tailer correctly fires one `jsonl-turn-end` per assistant
    // message; treating the first one as terminal kills the session before
    // the actual reply lands, leaving `result` empty + the modal blank. Fix:
    // empty `text` from a non-paused run means the assistant produced no text
    // content (thinking-only); keep the idle timer armed and wait for the
    // next jsonl-turn-end. Reference: [[cc-interleaved-thinking-dual-end-turn]].
    if (!text) {
      return;
    }
    // Text-bearing end_turn + no pending pauses → terminal complete.
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
    this.flushFirstJsonlResolvers(rec);
    this.emitRunChanged(rec);
    rec.resolveCompletion?.(this.snapshot(rec));
    // Section 18.7 — this run freed a cap slot. Drain queue head if any.
    this.processQueue();
  }

  private fail(rec: InternalRun, cause: AgentRunFailureCause, reason: string): void {
    this.failWithCause(rec, cause, reason);
  }

  private failWithCause(rec: InternalRun, cause: AgentRunFailureCause, reason: string): void {
    if (this.isTerminal(rec.status)) return;
    // Section 18.7 — record whether this run was holding a cap slot before
    // terminal. Queued runs don't occupy a slot; their cancel doesn't free
    // one, so we skip the queue drain in that case. (Queued runs are still
    // dropped from the queue via the `processQueue` stale-skip guard the
    // next time it runs.)
    const wasHoldingSlot =
      rec.status === 'spawning' || rec.status === 'running' || rec.status === 'paused';
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
    this.flushFirstJsonlResolvers(rec);
    this.emitRunChanged(rec);
    rec.resolveCompletion?.(this.snapshot(rec));
    if (wasHoldingSlot) this.processQueue();
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

  // ── Section 18.7: cap + queue ────────────────────────────────────────

  /** Resolve the global cap. Test override > live DB read > 5 fallback. */
  private getCapValue(): number {
    if (this.deps.getMaxConcurrent) {
      try {
        return clampMaxConcurrent(this.deps.getMaxConcurrent());
      } catch {
        return DEFAULT_MAX_CONCURRENT;
      }
    }
    try {
      const stored = getGlobalSettings();
      const raw = stored?.agentDispatch?.maxConcurrent;
      return typeof raw === 'number' ? clampMaxConcurrent(raw) : DEFAULT_MAX_CONCURRENT;
    } catch {
      return DEFAULT_MAX_CONCURRENT;
    }
  }

  /** How many tracked runs currently occupy a cap slot. `paused` counts —
   *  a paused agent will respawn when its pending-ask answer lands, and we
   *  don't want a wave of resumes to bust the cap. Queued / completed /
   *  failed / cancelled don't count. */
  private countRunningOrPaused(): number {
    let n = 0;
    for (const r of this.runs.values()) {
      if (r.status === 'spawning' || r.status === 'running' || r.status === 'paused') n++;
    }
    return n;
  }

  /** Drain the queue head into real spawns while we're under cap. Stale
   *  entries (cancelled-while-queued) are silently skipped. */
  private processQueue(): void {
    while (this.queue.length > 0 && this.countRunningOrPaused() < this.getCapValue()) {
      const nextId = this.queue.shift()!;
      const rec = this.runs.get(nextId);
      if (!rec || rec.status !== 'queued') continue;
      this.dequeueAndStart(rec);
    }
  }

  /** Transition `queued` → `spawning`, emit the queued-started event for
   *  the messaging system, hand off to `finishSpawn`. Refreshes
   *  `rec.startedAt` to actual spawn time so the wall-clock cap doesn't
   *  count the time the run spent in the queue. */
  private dequeueAndStart(rec: InternalRun): void {
    const queuedAt = rec.queuedAt ?? rec.startedAt;
    rec.status = 'spawning';
    rec.startedAt = Date.now();
    this.emitRunChanged(rec);
    this.emit('agent-queued-started', {
      runId: rec.runId,
      sessionId: rec.sessionId,
      agentName: rec.agentName,
      projectId: rec.projectId,
      dispatcherSessionId: rec.dispatcherSessionId,
      parentWorkItemId: rec.parentWorkItemId,
      queuedAt,
      startedAt: rec.startedAt,
    });
    this.finishSpawn(rec);
  }

  /** Consume the stashed sessionOpts, create the underlying session,
   *  attach listeners, arm timers, emit. Called once per run, either
   *  immediately from `spawn` (under-cap path) or from `dequeueAndStart`
   *  (queued path). */
  private finishSpawn(rec: InternalRun): void {
    const sessionOpts = rec.pendingSessionOpts;
    rec.pendingSessionOpts = null;
    if (!sessionOpts) {
      // Defensive — shouldn't happen. Fail loudly so we don't silently hang
      // the dispatch.
      this.fail(rec, 'spawn-failed', 'finishSpawn called without pendingSessionOpts');
      return;
    }
    let session: AgentSessionLike;
    try {
      session = (this.deps.createSession ?? defaultCreateSession)(sessionOpts);
    } catch (err) {
      this.fail(rec, 'spawn-failed', `pty spawn failed: ${(err as Error).message}`);
      return;
    }
    this.attachToSession(rec, session);
    this.armWallClockTimer(rec);
    this.armIdleTimer(rec);
    // 16b.8.1 — surface the freshly-spawned record so the Activity Panel
    // card appears immediately (before the PTY reaches `ready`).
    this.emitRunChanged(rec);
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
      dispatcherSessionId: rec.dispatcherSessionId,
      wait: rec.wait,
      worktreeDir: rec.worktreeDir,
      startedAt: rec.startedAt,
      status: rec.status,
      result: rec.result,
      failureReason: rec.failureReason,
      failureCause: rec.failureCause,
      endedAt: rec.endedAt,
    };
  }
}

export type AgentSource = 'pod' | 'project-flat-file' | 'global-flat-file' | null;

/** Resolve an agent name to a source. Three places to look, in priority order:
 *   1. `pod` — live global pod row in the DB (canonical post-17a). Post-17e.2
 *      this is the only source `listResolvedAgents` surfaces; the stock 5
 *      (researcher / writer / planner / reviewer / extractor) are all seeded
 *      here at boot via `stock-pod-seed.ts`.
 *   2. `project-flat-file` — `<worktree>/.claude/agents/<name>.md` (legacy
 *      per-project override path; orphaned post-17e.2, kept until 17e.4).
 *   3. `global-flat-file` — `~/.project-companion/agents/<name>.md` (legacy
 *      AgentLibrary path; orphaned post-17e.2, kept until 17e.4 cleanup).
 *      The spawn path still materialises any leftover flat-file into
 *      `<cwd>/.claude/agents/` so CC's `--agent` flag can find it.
 *
 *  Returns null when none match — caller fails the spawn with
 *  `cause: 'unknown-agent'`. Per-project pod overlays land in 17c; the
 *  flat-file branches go away in 17e.4. */
export function resolveAgentSource(agentName: string, worktreeDir: string): AgentSource {
  if (getAgentByName({ name: agentName, scope: 'global' })) return 'pod';
  if (existsSync(resolve(worktreeDir, '.claude', 'agents', `${agentName}.md`))) return 'project-flat-file';
  if (existsSync(resolve(defaultLibraryDir(), `${agentName}.md`))) return 'global-flat-file';
  return null;
}

/** B7 (2026-05-21) — materialize a flat-file global agent into the worktree's
 *  `.claude/agents/` directory so CC's `--agent` flag can find it. Returns a
 *  cleanup that removes the in-worktree copy on terminal. No-op (returns a
 *  no-op cleanup) if a same-named file already exists in the worktree, which
 *  preserves any project override the user has authored. */
function materializeGlobalFlatFileAgent(agentName: string, worktreeDir: string): () => void {
  const destDir = resolve(worktreeDir, '.claude', 'agents');
  const destPath = resolve(destDir, `${agentName}.md`);
  if (existsSync(destPath)) {
    return () => {
      /* user-owned file; don't touch on cleanup */
    };
  }
  const srcPath = resolve(defaultLibraryDir(), `${agentName}.md`);
  mkdirSync(destDir, { recursive: true });
  copyFileSync(srcPath, destPath);
  return () => {
    try {
      unlinkSync(destPath);
    } catch {
      /* best-effort: tolerate missing file (e.g. someone deleted between spawn + cleanup) */
    }
  };
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
