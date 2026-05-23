// Section 25 Session 9 — AgentRun construction + registration helper.
//
// The orchestration layer the v2 HTTP routes call through. Sits on top of:
//
//   - Session 8's `continueAgentV2` (mints the agent_runs_v2 row + computes
//     pod revision for continuation dispatches).
//   - Session 6's `AgentRun` + `AgentRunRegistry` wrappers.
//   - Section 17's `preparePodSpawn` (pod materialisation; reused unchanged
//     from v1 — same shared `materializePod` under the hood).
//   - Session 8's `getActiveRunRegistry` (process-wide indexed lookup the
//     pause/resume layer queries).
//   - Session 7's `enqueueAndPushV2` (hybrid delivery for terminal envelopes).
//
// Responsibilities:
//
//   - `dispatchFreshAgentV2`: validates the pod exists, materialises it,
//     mints fresh agent_run_id + cc_provider_session_id (UUID), inserts an
//     agent_runs_v2 row with `status: 'queued'` (Section 6's AgentRunRegistry
//     decides whether the queue is full or the run goes straight to spawning),
//     constructs the AgentRun, registers it with active-runs, wires terminal
//     persistence + channel-event emission, calls `run.start()`.
//
//   - `dispatchContinueAgentV2`: validates the parent run + JSONL retention
//     guard + concurrent-continuation guard (Session 8's `continueAgentV2`
//     plan does this), materialises the pod (same name as parent), constructs
//     the AgentRun in mode='resume' with the parent's cc_provider_session_id,
//     wires terminal handlers + start.
//
// Production callers: the two v2 HTTP routes added in this session
// (`/api/projects/:projectId/agents/v2/:name/invoke` and
// `/api/projects/:projectId/agent-runs/v2/:runId/continue`).
//
// What's NOT here: tool catalog wiring, pod prompt updates, smoke test —
// those land in the same session as siblings of this module. Parallel-build
// invariant: nothing here references v1 paths. Calling `dispatchFreshAgentV2`
// has no effect on v1's `AgentRunManager`.

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  computePodRevision,
  getAgentByName,
  insertAgentRunRowV2,
  markAgentRunTerminalV2,
  newId,
  updateAgentRunStatusV2,
} from '@pc/db';
import type {
  AgentFailedPayload,
  AgentInboxEventKindV2,
  AgentRunFailureCauseV2,
  ULID,
} from '@pc/domain';
import { v2 as runtimeV2 } from '@pc/runtime';

import {
  buildAgentCompletedBody,
  buildAgentFailedBody,
} from '../agent-event-header.ts';
import { preparePodSpawn, type PodSpawnPrep } from '../pod-spawn.ts';
import type { ChannelServer } from '../channel-server.ts';

import { getActiveRunRegistry, type ActiveRunRegistry } from './active-runs.ts';
import { enqueueAndPushV2 } from './delivery.ts';
import { continueAgentV2, type ContinueAgentV2Result } from './pause-resume.ts';

type AgentRunRecord = runtimeV2.AgentRunRecord;

const { AgentRun, AgentRunRegistry } = runtimeV2;
type AgentRun = runtimeV2.AgentRun;

/** Process-wide cap-and-queue registry shared by every v2 dispatch. Lives in
 *  the runtime layer (Section 6); we hold one singleton in this module so
 *  every route+spawn agrees on the active count. Tests inject their own via
 *  the deps argument on the helpers below. */
let runRegistrySingleton: runtimeV2.AgentRunRegistry | null = null;
function getRunRegistry(): runtimeV2.AgentRunRegistry {
  if (!runRegistrySingleton) runRegistrySingleton = new AgentRunRegistry();
  return runRegistrySingleton;
}

/** Test-only override. Pass `null` to revert to a fresh singleton on next
 *  read. */
export function setRunRegistryForTest(reg: runtimeV2.AgentRunRegistry | null): void {
  runRegistrySingleton = reg;
}

export interface DispatchFreshAgentV2Input {
  projectId: ULID;
  /** Absolute path to the project's worktree. Becomes the spawn cwd + the
   *  worktree-bind root for the path-guard hook. */
  worktreeDir: string;
  agentName: string;
  /** First user message body. Echo-ack via bracketed paste after the gate. */
  input: string;
  /** PC session-id of the dispatcher (orchestrator's `PC_SESSION_ID`). */
  dispatcherSessionId: string;
  /** Optional work-item the dispatch is attached to. Forwarded to the agent
   *  via `PC_AGENT_PARENT_WORK_ITEM_ID`. */
  parentWorkItemId?: ULID | null;
  /** Caller's nesting depth + 1. The orchestrator dispatches at depth 1; an
   *  agent dispatched by that one runs at depth 2. */
  invokeDepth: number;
  /** Project slug — embedded in delivery envelopes so the orchestrator can
   *  pin a channel POST back to its source project. */
  slug: string;
}

export interface DispatchContinueAgentV2Input {
  projectId: ULID;
  worktreeDir: string;
  /** Parent run id to continue. Same scope rules as Session 8's
   *  `continueAgentV2` — parent must be terminal completed/failed, JSONL
   *  must still be on disk, no other continuation in flight. */
  parentAgentRunId: ULID;
  input: string;
  /** Caller's PC session-id. Used for ownership check against the parent
   *  run's `dispatcher_session_id` BEFORE we plan the continuation. */
  dispatcherSessionId: string;
  /** Project slug — embedded in delivery envelopes. */
  slug: string;
}

export interface DispatchAgentV2Deps {
  channelServer: ChannelServer;
  /** Inject for tests. Defaults to the process-wide singletons. */
  runRegistry?: runtimeV2.AgentRunRegistry;
  activeRunRegistry?: ActiveRunRegistry;
  /** Override the per-run scratch dir. Defaults to `<PC_DATA_DIR>/projects/
   *  <projectId>/agent-runs-v2/<runId>`. */
  scratchDirFor?: (projectId: ULID, agentRunId: ULID) => string;
  /** Test seam: AgentRun factory. Production = `new AgentRun(...)`. */
  agentRunFactory?: typeof defaultAgentRunFactory;
  /** Session 10 — WS broadcast hook for the Activity Panel adapter shim.
   *  Called on every state transition + terminal with the v2 row snapshot
   *  shimmed into a v1-shape `AgentRunRecord` envelope. Production wires
   *  this to apps/server's `broadcastTo(projectId, env)`; tests can leave
   *  it undefined (no-op). */
  broadcast?: (env: { type: 'agent-run-changed'; record: unknown }) => void;
  now?: () => number;
}

export interface DispatchAgentV2Success {
  ok: true;
  agentRunId: ULID;
  ccSessionId: string;
  podName: string;
  /** Run record snapshot immediately after `start()` — state is `queued` or
   *  `spawning` depending on cap. */
  initialState: 'queued' | 'spawning';
  startedAt: number;
}

export type DispatchAgentV2Failure =
  | {
      ok: false;
      cause: 'unknown-agent';
      error: string;
    }
  | {
      ok: false;
      cause: 'pod-materialisation-failed';
      error: string;
    }
  | {
      ok: false;
      cause: 'scratch-mkdir-failed';
      error: string;
    }
  | {
      ok: false;
      cause: ContinueAgentV2Result extends { ok: false; cause: infer C } ? C : never;
      error: string;
    };

export type DispatchAgentV2Result = DispatchAgentV2Success | DispatchAgentV2Failure;

// ─────────────────────────────── FRESH DISPATCH ──────────────────────────────

/** Validate, materialise, persist, construct, register, start. Returns a
 *  cause-tagged failure if any pre-spawn step fails; only the post-start
 *  failures funnel through the agent_runs_v2 row's terminal state. */
export function dispatchFreshAgentV2(
  input: DispatchFreshAgentV2Input,
  deps: DispatchAgentV2Deps,
): DispatchAgentV2Result {
  const now = (deps.now ?? Date.now)();

  // Fail fast on unknown agent — pre-row-insert so the orchestrator can
  // distinguish "you asked for a nonexistent pod" from "the pod ran and
  // failed."
  const podRow = getAgentByName({ name: input.agentName, scope: 'global' });
  if (!podRow) {
    return {
      ok: false,
      cause: 'unknown-agent',
      error: `no agent named "${input.agentName}" found in pod registry`,
    };
  }

  const agentRunId = newId() as ULID;
  const ccSessionId = randomUUID();
  const scratchDirFn = deps.scratchDirFor ?? defaultScratchDirFor;
  const scratchDir = scratchDirFn(input.projectId, agentRunId);

  try {
    mkdirSync(scratchDir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      cause: 'scratch-mkdir-failed',
      error: `scratchDir mkdir failed: ${(err as Error).message}`,
    };
  }

  let podPrep: PodSpawnPrep | null = null;
  try {
    podPrep = preparePodSpawn({
      agentName: input.agentName,
      worktreeDir: input.worktreeDir,
      scratchDir,
      filterMcpToReferencedTools: true,
    });
  } catch (err) {
    return {
      ok: false,
      cause: 'pod-materialisation-failed',
      error: `pod materialisation failed for "${input.agentName}": ${(err as Error).message}`,
    };
  }
  // Pre-row-validated above — a returned null here means a pod row exists in
  // the registry but `getPodForSpawn` rejected it (e.g. soft-deleted between
  // the validation read and the spawn read). Treat as unknown-agent.
  if (!podPrep) {
    return {
      ok: false,
      cause: 'unknown-agent',
      error: `pod "${input.agentName}" disappeared between validation and spawn`,
    };
  }

  const podRevisionAtDispatch = computePodRevision({
    podName: input.agentName,
    projectId: null,
  });

  // Insert the row BEFORE constructing the AgentRun. If the wrapper throws
  // during construction (shouldn't, but defensively), we still have a row to
  // reconcile-orphan at the next boot.
  insertAgentRunRowV2({
    id: agentRunId,
    projectId: input.projectId,
    podName: input.agentName,
    dispatcherSessionId: input.dispatcherSessionId,
    ccSessionId,
    status: 'queued',
    input: input.input,
    parentWorkItemId: input.parentWorkItemId ?? null,
    parentInvokeDepth: input.invokeDepth,
    continues: null,
    podRevisionAtDispatch,
    queuedAt: now,
  });

  const run = constructAndStart({
    input,
    podName: input.agentName,
    agentRunId,
    ccSessionId,
    podPrep,
    podRevisionAtDispatch,
    mode: 'fresh',
    initialInput: input.input,
    continuesParent: null,
    deps,
  });

  return {
    ok: true,
    agentRunId,
    ccSessionId,
    podName: input.agentName,
    initialState: run.getState() === 'spawning' ? 'spawning' : 'queued',
    startedAt: now,
  };
}

// ─────────────────────────────── CONTINUATION ────────────────────────────────

/** Plan + construct + register a continuation. The plan step (Session 8's
 *  `continueAgentV2`) handles all the guards — parent terminal, JSONL on
 *  disk, no concurrent continuation, project exists. */
export function dispatchContinueAgentV2(
  input: DispatchContinueAgentV2Input,
  deps: DispatchAgentV2Deps,
): DispatchAgentV2Result {
  const now = (deps.now ?? Date.now)();

  const plan = continueAgentV2(
    {
      parentAgentRunId: input.parentAgentRunId,
      input: input.input,
      now,
    },
    { now: deps.now },
  );
  if (!plan.ok) {
    return {
      ok: false,
      cause: plan.cause,
      error: plan.error,
    } as DispatchAgentV2Failure;
  }

  // The plan already inserted the agent_runs_v2 row with status='queued'.
  // Now materialise the pod + construct + register + start.
  const scratchDirFn = deps.scratchDirFor ?? defaultScratchDirFor;
  const scratchDir = scratchDirFn(input.projectId, plan.plan.agentRunId);

  try {
    mkdirSync(scratchDir, { recursive: true });
  } catch (err) {
    markAgentRunTerminalV2({
      id: plan.plan.agentRunId,
      status: 'failed',
      result: null,
      failureCause: 'spawn-error',
      failureReason: `scratchDir mkdir failed: ${(err as Error).message}`,
      completedAt: now,
    });
    return {
      ok: false,
      cause: 'scratch-mkdir-failed',
      error: `scratchDir mkdir failed: ${(err as Error).message}`,
    };
  }

  let podPrep: PodSpawnPrep | null = null;
  try {
    podPrep = preparePodSpawn({
      agentName: plan.plan.podName,
      worktreeDir: input.worktreeDir,
      scratchDir,
      filterMcpToReferencedTools: true,
    });
  } catch (err) {
    markAgentRunTerminalV2({
      id: plan.plan.agentRunId,
      status: 'failed',
      result: null,
      failureCause: 'spawn-error',
      failureReason: `pod materialisation failed: ${(err as Error).message}`,
      completedAt: now,
    });
    return {
      ok: false,
      cause: 'pod-materialisation-failed',
      error: `pod materialisation failed for "${plan.plan.podName}": ${(err as Error).message}`,
    };
  }
  if (!podPrep) {
    markAgentRunTerminalV2({
      id: plan.plan.agentRunId,
      status: 'failed',
      result: null,
      failureCause: 'spawn-error',
      failureReason: `pod "${plan.plan.podName}" no longer in registry`,
      completedAt: now,
    });
    return {
      ok: false,
      cause: 'unknown-agent',
      error: `pod "${plan.plan.podName}" no longer in registry`,
    };
  }

  const run = constructAndStart({
    input: {
      projectId: input.projectId,
      worktreeDir: input.worktreeDir,
      agentName: plan.plan.podName,
      input: input.input,
      dispatcherSessionId: plan.plan.dispatcherSessionId,
      parentWorkItemId: plan.plan.parentWorkItemId,
      invokeDepth: plan.plan.parentInvokeDepth,
      slug: input.slug,
    },
    podName: plan.plan.podName,
    agentRunId: plan.plan.agentRunId,
    ccSessionId: plan.plan.ccSessionId,
    podPrep,
    podRevisionAtDispatch: plan.plan.podRevisionAtDispatch,
    mode: 'resume',
    initialInput: input.input,
    continuesParent: input.parentAgentRunId,
    deps,
  });

  return {
    ok: true,
    agentRunId: plan.plan.agentRunId,
    ccSessionId: plan.plan.ccSessionId,
    podName: plan.plan.podName,
    initialState: run.getState() === 'spawning' ? 'spawning' : 'queued',
    startedAt: now,
  };
}

// ─────────────────────────────── CONSTRUCT + REGISTER ────────────────────────

interface ConstructAndStartArgs {
  input: DispatchFreshAgentV2Input;
  podName: string;
  agentRunId: ULID;
  ccSessionId: string;
  podPrep: PodSpawnPrep;
  podRevisionAtDispatch: string | null;
  mode: 'fresh' | 'resume';
  initialInput: string;
  continuesParent: ULID | null;
  deps: DispatchAgentV2Deps;
}

function constructAndStart(args: ConstructAndStartArgs): AgentRun {
  const reg = args.deps.runRegistry ?? getRunRegistry();
  const activeReg = args.deps.activeRunRegistry ?? getActiveRunRegistry();
  const factory = args.deps.agentRunFactory ?? defaultAgentRunFactory;

  // Env contract: dispatched agents get the agent-run env vars + the project
  // gate + the dispatcher session-id forwarded for routing pause emits back.
  // Parallel-build invariant: PC_AGENT_SESSION_ID still = ccSessionId (v1
  // contract preserved) so v1 tools called from the spawned agent also work.
  // Phase D rip target: design § 11.1 wants PC_AGENT_SESSION_ID = agent_run_id.
  const baseEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...args.podPrep.extraEnv,
    PC_AGENT_NAME: args.podName,
    PC_AGENT_SESSION_ID: args.ccSessionId,
    PC_AGENT_RUN_ID: args.agentRunId,
    PC_DISPATCHER_SESSION_ID: args.input.dispatcherSessionId,
    PC_PROJECT_ID: args.input.projectId,
    PC_AGENT_INVOKE_DEPTH: String(args.input.invokeDepth),
  };
  if (args.input.parentWorkItemId) {
    baseEnv.PC_AGENT_PARENT_WORK_ITEM_ID = args.input.parentWorkItemId;
  }

  const run = factory({
    agentRunId: args.agentRunId,
    ccProviderSessionId: args.ccSessionId,
    podDefinition: { name: args.podName },
    worktreePath: args.input.worktreeDir,
    env: baseEnv,
    initialInput: args.mode === 'fresh' ? args.initialInput : args.initialInput,
    mode: args.mode,
    continues: args.continuesParent ?? undefined,
    mcpConfigPath: args.podPrep.mcpConfigPath,
    // Forensic transcript per spawn — sits next to the materialised pod files
    // in the per-run scratch dir.
    transcriptPath: resolve(
      args.deps.scratchDirFor
        ? args.deps.scratchDirFor(args.input.projectId, args.agentRunId)
        : defaultScratchDirFor(args.input.projectId, args.agentRunId),
      'transcript.log',
    ),
    registry: reg,
  });

  // Register with the active-runs index so pause-resume can find the run by
  // id or by cc-session.
  activeReg.register({
    run,
    projectId: args.input.projectId,
    dispatcherSessionId: args.input.dispatcherSessionId,
    ccSessionId: args.ccSessionId,
    podName: args.podName,
    parentWorkItemId: args.input.parentWorkItemId ?? null,
    podRevisionAtDispatch: args.podRevisionAtDispatch,
  });

  // Session 10 — Activity Panel adapter shim. Build a v1-shape AgentRunRecord
  // envelope on every state transition + emit through the broadcast hook.
  // Provides the panel with feature parity for v2 dispatches.
  const startedAt = (args.deps.now ?? Date.now)();
  const broadcastStateChanged = (
    status: 'queued' | 'spawning' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled',
    extra: { result?: string; failureCause?: AgentRunFailureCauseV2 | null; endedAt?: number } = {},
  ): void => {
    if (!args.deps.broadcast) return;
    const record = {
      runId: args.agentRunId,
      sessionId: args.ccSessionId,
      agentName: args.podName,
      // Pod-row model lookup isn't load-bearing for the Activity Panel card;
      // mirror v1's pod-less-spawn fallback so the UI's model pill renders.
      model: 'opus',
      projectId: args.input.projectId,
      parentWorkItemId: args.input.parentWorkItemId ?? null,
      dispatcherSessionId: args.input.dispatcherSessionId,
      // v2 dispatches are always async on the wire — the wait=true sync path
      // was a v1 artifact for nested-agent chains. Match v1's record shape.
      wait: false,
      worktreeDir: args.input.worktreeDir,
      startedAt,
      status,
      result: extra.result ?? '',
      failureReason: extra.failureCause
        ? describeFailure(extra.failureCause) ?? null
        : null,
      failureCause: extra.failureCause ?? null,
      endedAt: extra.endedAt ?? null,
    };
    try {
      args.deps.broadcast({ type: 'agent-run-changed', record });
    } catch {
      /* best-effort */
    }
  };

  // Fire initial 'queued' envelope so the panel renders the card the moment
  // the row lands. State events from AgentRun only fire on TRANSITIONS, not
  // the initial state, so we emit explicitly here.
  broadcastStateChanged('queued');

  // Persist state-machine transitions. AgentRun emits `state(next, prev)` on
  // every move; we mirror queued→spawning/running/paused to the DB row +
  // broadcast a panel envelope.
  run.on('state', (next: string) => {
    if (next === 'spawning') {
      updateAgentRunStatusV2({
        id: args.agentRunId,
        status: 'spawning',
        spawnedAt: Date.now(),
      });
      broadcastStateChanged('spawning');
    } else if (next === 'running') {
      updateAgentRunStatusV2({
        id: args.agentRunId,
        status: 'running',
        readyAt: Date.now(),
      });
      broadcastStateChanged('running');
    } else if (next === 'paused') {
      broadcastStateChanged('paused');
    }
  });

  // Terminal handling: persist row + emit channel envelope to dispatcher +
  // emit Activity Panel envelope.
  run.once(
    'terminal',
    (info: { status: 'completed' | 'failed' | 'cancelled'; cause?: string; result?: string }) => {
      const completedAt = Date.now();
      const failureCause: AgentRunFailureCauseV2 | null =
        info.status === 'completed' ? null : (info.cause as AgentRunFailureCauseV2) ?? null;
      markAgentRunTerminalV2({
        id: args.agentRunId,
        status: info.status,
        result: info.status === 'completed' ? info.result ?? '' : null,
        failureCause,
        failureReason: info.status === 'completed' ? null : describeFailure(failureCause),
        completedAt,
      });
      args.podPrep.cleanup();
      emitTerminalEnvelope({
        channelServer: args.deps.channelServer,
        projectId: args.input.projectId,
        dispatcherSessionId: args.input.dispatcherSessionId,
        slug: args.input.slug,
        runId: args.agentRunId,
        ccSessionId: args.ccSessionId,
        podName: args.podName,
        parentWorkItemId: args.input.parentWorkItemId ?? null,
        terminalStatus: info.status,
        result: info.result ?? '',
        failureCause,
      });
      broadcastStateChanged(info.status, {
        result: info.result,
        failureCause,
        endedAt: completedAt,
      });
    },
  );

  run.start();
  return run;
}

// ─────────────────────────────── TERMINAL ENVELOPE ───────────────────────────

interface EmitTerminalArgs {
  channelServer: ChannelServer;
  projectId: ULID;
  dispatcherSessionId: string;
  slug: string;
  runId: ULID;
  ccSessionId: string;
  podName: string;
  parentWorkItemId: ULID | null;
  terminalStatus: 'completed' | 'failed' | 'cancelled';
  result: string;
  failureCause: AgentRunFailureCauseV2 | null;
}

function emitTerminalEnvelope(args: EmitTerminalArgs): void {
  const kind: AgentInboxEventKindV2 =
    args.terminalStatus === 'completed' ? 'agent-completed' : 'agent-failed';
  const body =
    args.terminalStatus === 'completed'
      ? buildAgentCompletedBody({
          runId: args.runId,
          sessionId: args.ccSessionId,
          agentName: args.podName,
          parentWorkItemId: args.parentWorkItemId,
          result: args.result,
        })
      : buildAgentFailedBody({
          runId: args.runId,
          sessionId: args.ccSessionId,
          agentName: args.podName,
          parentWorkItemId: args.parentWorkItemId,
          reason: describeFailure(args.failureCause) ?? args.terminalStatus,
          cause: agentFailureCauseToPayload(args.failureCause, args.terminalStatus),
        });
  enqueueAndPushV2(args.channelServer, {
    projectId: args.projectId,
    pcSessionId: args.dispatcherSessionId,
    kind,
    slug: args.slug,
    source: 'agent',
    body,
    sender: 'pc',
  });
}

/** Map v2's `AgentRunFailureCauseV2` to the channel-event payload's
 *  `cause` field. The orchestrator pod prompt parses these to pick a
 *  next-step suggestion (retry / drop / hand-write); preserve the v1 enum
 *  shape so the parser doesn't need to change. */
function agentFailureCauseToPayload(
  cause: AgentRunFailureCauseV2 | null,
  terminalStatus: 'completed' | 'failed' | 'cancelled',
): AgentFailedPayload['cause'] {
  if (terminalStatus === 'cancelled') return 'cancelled';
  switch (cause) {
    case 'wall-clock-timeout':
    case 'idle-timeout':
    case 'ready-timeout':
      return 'timeout';
    case 'cancelled':
    case 'cancel-while-queued':
      return 'cancelled';
    case 'spawn-stuck':
    case 'spawn-error':
    case 'send-failed':
    case 'unexpected-exit':
    case 'mcp-handshake-never':
    case 'kill-during-spawn':
    case 'server-restart':
      return 'spawn-failed';
    case null:
    default:
      return 'error';
  }
}

function describeFailure(cause: AgentRunFailureCauseV2 | null): string | null {
  if (!cause) return null;
  switch (cause) {
    case 'spawn-stuck':
      return 'agent never transitioned out of spawning within the spawn-stuck cap';
    case 'idle-timeout':
      return 'agent produced no output for the idle window';
    case 'wall-clock-timeout':
      return 'agent exceeded the wall-clock cap';
    case 'ready-timeout':
      return 'agent never reached ready within the ready-timeout window';
    case 'spawn-error':
      return 'agent spawn failed before becoming ready';
    case 'send-failed':
      return 'failed to deliver the initial input to the agent';
    case 'unexpected-exit':
      return 'agent process exited unexpectedly';
    case 'cancel-while-queued':
      return 'cancelled before the queue admitted the run';
    case 'cancelled':
      return 'run cancelled';
    case 'mcp-handshake-never':
      return 'agent MCP handshake never completed';
    case 'kill-during-spawn':
      return 'agent was killed during spawn';
    case 'server-restart':
      return 'server restarted before this run completed';
    default:
      return cause;
  }
}

// ─────────────────────────────── DEFAULT FACTORY ─────────────────────────────

function defaultAgentRunFactory(
  input: ConstructorParameters<typeof AgentRun>[0] & {
    registry: runtimeV2.AgentRunRegistry;
  },
): AgentRun {
  const { registry, ...runInput } = input;
  return new AgentRun(runInput, { registry });
}

function defaultScratchDirFor(projectId: ULID, agentRunId: ULID): string {
  const root = process.env.PC_DATA_DIR ?? 'data';
  return resolve(root, 'projects', projectId, 'agent-runs-v2', agentRunId);
}

// Tiny export shim so callers can construct a `Record` of the run's current
// snapshot without importing `AgentRun` directly.
export function snapshotAgentRun(run: AgentRun): AgentRunRecord {
  return run.getRecord();
}
