// Section 25 — AgentRun construction + registration helper.
//
// The orchestration layer the HTTP routes call through. Sits on top of:
//
//   - `continueAgent` (mints the `agent_runs` row + computes pod revision
//     for continuation dispatches).
//   - `AgentRun` + `AgentRunRegistry` wrappers from @pc/runtime.
//   - `preparePodSpawn` (pod materialisation via the shared `materializePod`).
//   - `getActiveRunRegistry` (process-wide indexed lookup the pause/resume
//     layer queries).
//   - `enqueueAndPush` (hybrid delivery for terminal envelopes).
//
// Responsibilities:
//
//   - `dispatchFreshAgent`: validates the pod exists, materialises it, mints
//     fresh agent_run_id + cc_provider_session_id (UUID), inserts an
//     `agent_runs` row with `status: 'queued'` (the AgentRunRegistry decides
//     whether the queue is full or the run goes straight to spawning),
//     constructs the AgentRun, registers it with active-runs, wires terminal
//     persistence + channel-event emission, calls `run.start()`.
//
//   - `dispatchContinueAgent`: validates the parent run + JSONL retention
//     guard + concurrent-continuation guard (`continueAgent` plan does this),
//     materialises the pod (same name as parent), constructs the AgentRun in
//     mode='resume' with the parent's cc_provider_session_id, wires terminal
//     handlers + start.
//
// Production callers: the two HTTP routes
// (`/api/projects/:projectId/agents/:name/invoke` and
// `/api/projects/:projectId/agent-runs/:runId/continue`).

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  computePodRevision,
  resolveAgentForDispatch,
  getProjectById,
  getWorkItem,
  insertAgentRunRow,
  markAgentRunTerminal,
  newId,
  setAssignedAgentRunId,
  updateAgentRunStatus,
} from '@pc/db';
import type {
  AgentFailedPayload,
  AgentInboxEventKind,
  AgentRunFailureCause,
  ExpectedOutput,
  ULID,
} from '@pc/domain';
import { AgentRun, AgentRunRegistry } from '@pc/runtime';
import type { AgentRunRecord } from '@pc/runtime';

import {
  buildAgentCompletedBody,
  buildAgentFailedBody,
  buildAgentQueuedStartedBody,
  type VerificationBlock,
} from './agent-event-header.ts';
import { preparePodSpawn, type PodSpawnPrep } from './pod-spawn.ts';
import type { ChannelServer } from './channel-server.ts';

import { getActiveRunRegistry, type ActiveRunRegistry } from './agent-active-runs.ts';
import { getAgentHostClient } from '../agent-host/connect-host.ts';
import { enqueueAndPush } from './agent-delivery.ts';
import { continueAgent, type ContinueAgentResult } from './pause-resume.ts';
import {
  runVerificationOnTerminal,
  type VerificationDeps,
  type VerificationOutcome,
} from './agent-verification.ts';

/** Process-wide cap-and-queue registry shared by every dispatch. Lives in
 *  the runtime layer; we hold one singleton in this module so every
 *  route+spawn agrees on the active count. Tests inject their own via the
 *  deps argument on the helpers below. */
let runRegistrySingleton: AgentRunRegistry | null = null;
function getRunRegistry(): AgentRunRegistry {
  if (!runRegistrySingleton) runRegistrySingleton = new AgentRunRegistry();
  return runRegistrySingleton;
}

/** Test-only override. Pass `null` to revert to a fresh singleton on next
 *  read. */
export function setRunRegistryForTest(reg: AgentRunRegistry | null): void {
  runRegistrySingleton = reg;
}

export interface DispatchFreshAgentInput {
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
  /** Section 26.4 — work-item-as-contract. When supplied, the dispatch is
   *  the agent's assigned contract: the materialiser appends a "## Your
   *  assignment" section to the rendered .md with `pc_get_work_item({id})`
   *  + the active `expected_output` JSON. Also sets `PC_AGENT_WORK_ITEM_ID`
   *  on the spawn env. Caller (orchestrator) creates the work item via
   *  `pc_create_agent_work_item`, then passes the returned ULID here. */
  workItemId?: ULID | null;
  /** Caller's nesting depth + 1. The orchestrator dispatches at depth 1; an
   *  agent dispatched by that one runs at depth 2. */
  invokeDepth: number;
  /** Project slug — embedded in delivery envelopes so the orchestrator can
   *  pin a channel POST back to its source project. */
  slug: string;
}

export interface DispatchContinueAgentInput {
  projectId: ULID;
  worktreeDir: string;
  /** Parent run id to continue. Same scope rules as Session 8's
   *  `continueAgent` — parent must be terminal completed/failed, JSONL
   *  must still be on disk, no other continuation in flight. */
  parentAgentRunId: ULID;
  input: string;
  /** Caller's PC session-id. Used for ownership check against the parent
   *  run's `dispatcher_session_id` BEFORE we plan the continuation. */
  dispatcherSessionId: string;
  /** Section 26.4 — work-item-as-contract carries through continuations too.
   *  When supplied, the resumed dispatch re-emits the assignment header so
   *  the continued agent sees the same (or a swapped-in) contract. NULL =
   *  carry the parent run's `parent_work_item_id` as the assignment if it
   *  had one. */
  workItemId?: ULID | null;
  /** Project slug — embedded in delivery envelopes. */
  slug: string;
}

export interface DispatchAgentDeps {
  channelServer: ChannelServer;
  /** Inject for tests. Defaults to the process-wide singletons. */
  runRegistry?: AgentRunRegistry;
  activeRunRegistry?: ActiveRunRegistry;
  /** Override the per-run scratch dir. Defaults to `<PC_DATA_DIR>/projects/
   *  <projectId>/agent-runs-v2/<runId>`. */
  scratchDirFor?: (projectId: ULID, agentRunId: ULID) => string;
  /** Section 26.5 — inject the verification runner for tests. Production
   *  uses `runVerificationOnTerminal` with worktree-bound `PredicateExecutors`. */
  verifyOnTerminal?: typeof runVerificationOnTerminal;
  /** Section 26.5 — passthrough deps for the production verification runner
   *  (mostly the `executorsFor` test seam). Tests usually inject
   *  `verifyOnTerminal` directly instead. */
  verificationDeps?: VerificationDeps;
  /** Test seam: AgentRun factory. Production = `new AgentRun(...)`. */
  agentRunFactory?: typeof defaultAgentRunFactory;
  /** Session 10 / Phase D — WS broadcast hook. Carries:
   *   - `{ type: 'agent-run-changed', record }` on state transition + terminal
   *     (Activity Panel adapter shim — v1-shape `AgentRunRecord`).
   *   - `{ type: 'agent-jsonl-event', runId, event }` per JSONL event
   *     (Activity Panel live-transcript modal — filtered by runId).
   *  Production wires this to apps/server's `broadcastTo(projectId, env)`.
   *  Tests can leave it undefined (no-op). */
  broadcast?: (env: { type: string; [key: string]: unknown }) => void;
  now?: () => number;
}

export interface DispatchAgentSuccess {
  ok: true;
  agentRunId: ULID;
  ccSessionId: string;
  podName: string;
  /** Run record snapshot immediately after `start()` — state is `queued` or
   *  `spawning` depending on cap. */
  initialState: 'queued' | 'spawning';
  startedAt: number;
}

export type DispatchAgentFailure =
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
      cause: ContinueAgentResult extends { ok: false; cause: infer C } ? C : never;
      error: string;
    };

export type DispatchAgentResult = DispatchAgentSuccess | DispatchAgentFailure;

// ─────────────────────────────── FRESH DISPATCH ──────────────────────────────

/** Validate, materialise, persist, construct, register, start. Returns a
 *  cause-tagged failure if any pre-spawn step fails; only the post-start
 *  failures funnel through the agent_runs_v2 row's terminal state. */
export function dispatchFreshAgent(
  input: DispatchFreshAgentInput,
  deps: DispatchAgentDeps,
): DispatchAgentResult {
  const now = (deps.now ?? Date.now)();

  // Fail fast on unknown agent — pre-row-insert so the orchestrator can
  // distinguish "you asked for a nonexistent pod" from "the pod ran and
  // failed." Resolution prefers a project-scoped pod with this name, falls
  // back to global. (Section 22.1 — stabilization fix.)
  const podRow = resolveAgentForDispatch(input.agentName, input.projectId);
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

  // Section 26.4 — resolve the work-item-as-contract assignment if supplied.
  // The materialiser writes a "## Your assignment" section into the rendered
  // .md when this is non-null; the orchestrator created the work item before
  // dispatching so we just look it up here. Hard-fail on unknown/archived ids
  // — the orchestrator can't dispatch against a phantom contract.
  let workItem: { workItemId: ULID; expectedOutput: ExpectedOutput } | null = null;
  if (input.workItemId) {
    const wi = getWorkItem(input.workItemId);
    if (!wi) {
      return {
        ok: false,
        cause: 'pod-materialisation-failed',
        error: `workItemId "${input.workItemId}" not found or archived`,
      };
    }
    if (!wi.expectedOutput) {
      return {
        ok: false,
        cause: 'pod-materialisation-failed',
        error: `workItem "${input.workItemId}" has no expected_output — was it created via pc_create_agent_work_item?`,
      };
    }
    workItem = { workItemId: input.workItemId, expectedOutput: wi.expectedOutput };
  }

  let podPrep: PodSpawnPrep | null = null;
  try {
    podPrep = preparePodSpawn({
      agentName: input.agentName,
      projectId: input.projectId,
      worktreeDir: input.worktreeDir,
      scratchDir,
      filterMcpToReferencedTools: true,
      workItem: workItem ?? undefined,
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

  // Pod-revision must match the row we actually resolved — when the dispatch
  // resolved a project-scoped pod, the revision query must scope to that
  // project too. (Section 22.1 fix: previously always passed null → drift if a
  // project pod was edited.)
  const podRevisionAtDispatch = computePodRevision({
    podName: input.agentName,
    projectId: podPrep.podScope === 'project' ? podPrep.podProjectId : null,
  });

  // When a contract WI is supplied, store it on the agent_runs row's
  // `parent_work_item_id` slot — that field is the bidirectional link 26.5
  // will use to find the WI on terminal eval. Falls back to the dispatcher-
  // lineage `parentWorkItemId` for legacy callers that didn't pass a contract.
  const parentWorkItemForRow: ULID | null =
    (workItem?.workItemId as ULID | undefined) ?? input.parentWorkItemId ?? null;

  // Insert the row BEFORE constructing the AgentRun. If the wrapper throws
  // during construction (shouldn't, but defensively), we still have a row to
  // reconcile-orphan at the next boot.
  insertAgentRunRow({
    id: agentRunId,
    projectId: input.projectId,
    podName: input.agentName,
    dispatcherSessionId: input.dispatcherSessionId,
    ccSessionId,
    status: 'queued',
    input: input.input,
    parentWorkItemId: parentWorkItemForRow,
    parentInvokeDepth: input.invokeDepth,
    continues: null,
    podRevisionAtDispatch,
    queuedAt: now,
  });

  // Section 26.6 — point the contract WI at the run that's about to produce
  // its report. Reject (`pc_reject_work_item`) reads this to know which run
  // to wake with feedback. Best-effort: skip silently if the WI vanished.
  if (workItem?.workItemId) {
    setAssignedAgentRunId(workItem.workItemId, agentRunId);
  }

  const run = constructAndStart({
    input: { ...input, parentWorkItemId: parentWorkItemForRow },
    podName: input.agentName,
    agentRunId,
    ccSessionId,
    podPrep,
    podRevisionAtDispatch,
    mode: 'fresh',
    initialInput: input.input,
    continuesParent: null,
    workItemId: workItem?.workItemId ?? null,
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
 *  `continueAgent`) handles all the guards — parent terminal, JSONL on
 *  disk, no concurrent continuation, project exists. */
export function dispatchContinueAgent(
  input: DispatchContinueAgentInput,
  deps: DispatchAgentDeps,
): DispatchAgentResult {
  const now = (deps.now ?? Date.now)();

  const plan = continueAgent(
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
    } as DispatchAgentFailure;
  }

  // The plan already inserted the agent_runs_v2 row with status='queued'.
  // Now materialise the pod + construct + register + start.
  const scratchDirFn = deps.scratchDirFor ?? defaultScratchDirFor;
  const scratchDir = scratchDirFn(input.projectId, plan.plan.agentRunId);

  try {
    mkdirSync(scratchDir, { recursive: true });
  } catch (err) {
    markAgentRunTerminal({
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

  // Section 26.4 — resolve the contract WI for the continuation. Caller's
  // explicit `workItemId` wins; otherwise carry the parent run's contract
  // forward so the resumed conversation stays anchored to the same WI.
  const continueWorkItemId: ULID | null =
    (input.workItemId as ULID | undefined) ?? plan.plan.parentWorkItemId ?? null;
  let continueWorkItem: { workItemId: ULID; expectedOutput: ExpectedOutput } | null = null;
  if (continueWorkItemId) {
    const wi = getWorkItem(continueWorkItemId);
    if (wi?.expectedOutput) {
      continueWorkItem = { workItemId: continueWorkItemId, expectedOutput: wi.expectedOutput };
    }
    // Soft-fail on archived/unknown — continuations shouldn't break just because
    // the original WI was archived. The resumed agent still has prior context.
  }

  let podPrep: PodSpawnPrep | null = null;
  try {
    podPrep = preparePodSpawn({
      agentName: plan.plan.podName,
      projectId: input.projectId,
      worktreeDir: input.worktreeDir,
      scratchDir,
      filterMcpToReferencedTools: true,
      workItem: continueWorkItem ?? undefined,
    });
  } catch (err) {
    markAgentRunTerminal({
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
    markAgentRunTerminal({
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

  // Section 26.6 — re-point the contract WI at the continuation run so a
  // subsequent reject wakes the latest producer, not the parent. Skips
  // silently if the WI was archived/unknown above.
  if (continueWorkItemId) {
    setAssignedAgentRunId(continueWorkItemId, plan.plan.agentRunId);
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
    workItemId: continueWorkItemId,
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
  input: DispatchFreshAgentInput;
  podName: string;
  agentRunId: ULID;
  ccSessionId: string;
  podPrep: PodSpawnPrep;
  podRevisionAtDispatch: string | null;
  mode: 'fresh' | 'resume';
  initialInput: string;
  continuesParent: ULID | null;
  /** Section 26.4 — the agent's contract WI, if any. Surfaced in the spawn
   *  env via `PC_AGENT_WORK_ITEM_ID` so MCP tools called by the agent (e.g.
   *  `pc_attach_to_work_item`, eventual body/status updaters) can resolve
   *  the assignment without re-parsing the materialised .md. */
  workItemId: ULID | null;
  deps: DispatchAgentDeps;
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
  if (args.workItemId) {
    // Section 26.4 — assignment env var. The materialised .md already names
    // the work item, but MCP tools running inside the agent (attachments,
    // body updates, etc.) read this env var to know which contract they're
    // operating against without re-parsing the prompt.
    baseEnv.PC_AGENT_WORK_ITEM_ID = args.workItemId;
  }

  const run = factory({
    agentRunId: args.agentRunId,
    ccProviderSessionId: args.ccSessionId,
    podDefinition: { name: args.podPrep.agentCliName, logicalName: args.podName },
    worktreePath: args.input.worktreeDir,
    env: baseEnv,
    initialInput: args.mode === 'fresh' ? args.initialInput : args.initialInput,
    mode: args.mode,
    continues: args.continuesParent ?? undefined,
    mcpConfigPath: args.podPrep.mcpConfigPath,
    settingsPath: args.podPrep.settingsPath,
    settingSources: args.podPrep.settingSources,
    pluginDirs: [args.podPrep.pluginDir],
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
    extra: { result?: string; failureCause?: AgentRunFailureCause | null; endedAt?: number } = {},
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
      updateAgentRunStatus({
        id: args.agentRunId,
        status: 'spawning',
        spawnedAt: Date.now(),
      });
      broadcastStateChanged('spawning');
    } else if (next === 'running') {
      updateAgentRunStatus({
        id: args.agentRunId,
        status: 'running',
        readyAt: Date.now(),
      });
      broadcastStateChanged('running');
    } else if (next === 'paused') {
      broadcastStateChanged('paused');
    }
  });

  // Phase D — Activity Panel live-transcript modal subscribes to
  // `agent-jsonl-event` envelopes filtered by runId. Fan every JSONL event
  // out via the broadcast dep so the panel sees the same surface v1 produced.
  run.on('jsonl-event', (event: unknown) => {
    if (!args.deps.broadcast) return;
    try {
      args.deps.broadcast({
        type: 'agent-jsonl-event',
        runId: args.agentRunId,
        event,
      });
    } catch {
      /* best-effort */
    }
  });

  // Phase D — emit `agent-queued-started` channel envelope to the dispatcher
  // when a previously-queued dispatch actually fires. Rides the hybrid
  // transport (inbox + best-effort channel) so post-restart catch-up still
  // works.
  run.on('queued-started', () => {
    const startedAt = Date.now();
    enqueueAndPush(args.deps.channelServer, {
      projectId: args.input.projectId,
      pcSessionId: args.input.dispatcherSessionId,
      kind: 'agent-queued-started' as AgentInboxEventKind,
      slug: args.input.slug,
      source: 'agent',
      body: buildAgentQueuedStartedBody({
        runId: args.agentRunId,
        sessionId: args.ccSessionId,
        agentName: args.podName,
        parentWorkItemId: args.input.parentWorkItemId ?? null,
        queuedAt: startedAt,
        startedAt,
      }),
      sender: 'pc',
    });
  });

  // Terminal handling: persist row + run tier-1 verification (Section 26.5) +
  // emit channel envelope to dispatcher + emit Activity Panel envelope.
  //
  // Verification is async — `bash_exit_zero` predicates run real child
  // processes with a 30s cap. The async work is fire-and-forget from the
  // listener's perspective; we use `void handleTerminal(...)` so the
  // EventEmitter callback stays sync and uncaught rejections are surfaced
  // through `.catch`.
  run.once(
    'terminal',
    (info: { status: 'completed' | 'failed' | 'cancelled'; cause?: string; result?: string }) => {
      void handleTerminal(info).catch((err) => {
        // Tier-1 verification or the channel-event emit threw. Both are
        // best-effort downstream of the terminal row write; log loudly so
        // future logs surface the case but don't crash the process.
        // eslint-disable-next-line no-console
        console.error(
          `[agent-run-factory] terminal handler failed for run ${args.agentRunId}:`,
          err,
        );
      });
    },
  );

  async function handleTerminal(info: {
    status: 'completed' | 'failed' | 'cancelled';
    cause?: string;
    result?: string;
  }): Promise<void> {
    const completedAt = Date.now();
    const failureCause: AgentRunFailureCause | null =
      info.status === 'completed' ? null : (info.cause as AgentRunFailureCause) ?? null;
    markAgentRunTerminal({
      id: args.agentRunId,
      status: info.status,
      result: info.status === 'completed' ? info.result ?? '' : null,
      failureCause,
      failureReason: info.status === 'completed' ? null : describeFailure(failureCause),
      completedAt,
    });

    // Pod-materialised session runtime files are disposable now that the
    // agent has exited. Removing them before verification keeps the worktree
    // free of run-scoped junk while the verification pass runs. The worktree
    // itself + any files the agent wrote stay intact for `files_exist` /
    // `bash_exit_zero` predicates.
    args.podPrep.cleanup();

    // Section 26.5 — run tier-1 verification when the dispatch was a
    // contract dispatch. `runVerificationOnTerminal` returns null when no
    // verification ran (non-contract, missing WI, cancelled) — the channel
    // envelope then ships without a verification block.
    const verifier = args.deps.verifyOnTerminal ?? runVerificationOnTerminal;
    const project = getProjectById(args.input.projectId);
    let outcome: VerificationOutcome | null = null;
    if (args.workItemId && project) {
      outcome = await verifier(
        {
          workItemId: args.workItemId,
          terminalStatus: info.status,
          failureReason: info.status === 'completed' ? null : describeFailure(failureCause),
          projectFolderPath: project.folderPath,
          worktreeDir: args.input.worktreeDir,
          project,
        },
        args.deps.verificationDeps ?? {},
      );
    }
    const verification: VerificationBlock | null = outcome
      ? {
          workItemId: outcome.workItemId,
          status: outcome.verificationStatus,
          tier: outcome.verificationTier,
          notes: outcome.notes,
        }
      : null;

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
      verification,
    });
    broadcastStateChanged(info.status, {
      result: info.result,
      failureCause,
      endedAt: completedAt,
    });
  }

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
  failureCause: AgentRunFailureCause | null;
  /** Section 26.5 — contract-WI verification outcome (null when the dispatch
   *  was not a contract dispatch). The builder appends `[workItemId: ...]`
   *  / `[verification: ...]` / `[verificationTier: ...]` / optional
   *  `[verificationNotes: ...]` tags on the channel envelope. */
  verification: VerificationBlock | null;
}

function emitTerminalEnvelope(args: EmitTerminalArgs): void {
  const kind: AgentInboxEventKind =
    args.terminalStatus === 'completed' ? 'agent-completed' : 'agent-failed';
  const body =
    args.terminalStatus === 'completed'
      ? buildAgentCompletedBody({
          runId: args.runId,
          sessionId: args.ccSessionId,
          agentName: args.podName,
          parentWorkItemId: args.parentWorkItemId,
          result: args.result,
          verification: args.verification,
        })
      : buildAgentFailedBody({
          runId: args.runId,
          sessionId: args.ccSessionId,
          agentName: args.podName,
          parentWorkItemId: args.parentWorkItemId,
          reason: describeFailure(args.failureCause) ?? args.terminalStatus,
          cause: agentFailureCauseToPayload(args.failureCause, args.terminalStatus),
          verification: args.verification,
        });
  enqueueAndPush(args.channelServer, {
    projectId: args.projectId,
    pcSessionId: args.dispatcherSessionId,
    kind,
    slug: args.slug,
    source: 'agent',
    body,
    sender: 'pc',
  });
}

/** Map v2's `AgentRunFailureCause` to the channel-event payload's
 *  `cause` field. The orchestrator pod prompt parses these to pick a
 *  next-step suggestion (retry / drop / hand-write); preserve the v1 enum
 *  shape so the parser doesn't need to change. */
function agentFailureCauseToPayload(
  cause: AgentRunFailureCause | null,
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

function describeFailure(cause: AgentRunFailureCause | null): string | null {
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
    registry: AgentRunRegistry;
  },
): AgentRun {
  const { registry, ...runInput } = input;
  // When the out-of-process host is connected (PC_AGENT_HOST=1), route the PTY
  // through a RemoteSpawn over the control channel instead of an in-process
  // LowLevelSpawn — the AgentRun state machine is identical either way (the
  // SpawnLike seam). Falls back to in-process if the host isn't up yet.
  const hostClient = getAgentHostClient();
  if (hostClient) {
    return new AgentRun(runInput, {
      registry,
      spawnFactory: (llsInput) => hostClient.createSpawn(llsInput),
    });
  }
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
