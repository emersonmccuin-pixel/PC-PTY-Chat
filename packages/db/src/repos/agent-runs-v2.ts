// Section 25 Session 8 — agent_runs_v2 repo.
//
// Lives alongside v1's `agent-runs.ts` during the parallel-build phase. v2
// persists the FULL state machine (queued | spawning | running | paused |
// completed | failed | cancelled) instead of v1's intermediate-states-stay-
// in-memory split. Restart-time reconciliation is now a SELECT * WHERE
// status IN ('queued','spawning','running','paused') — no in-memory state
// to lose.
//
// Continuation lineage via `continues` self-FK. `findActiveContinuationV2`
// guards `pc_continue_agent` against double-continuation of the same
// parent.

import { and, desc, eq, inArray } from 'drizzle-orm';

import type {
  AgentRunFailureCauseV2,
  AgentRunRowV2,
  AgentRunStatusV2,
  ULID,
} from '@pc/domain';

import { getDb } from '../connection.ts';
import { agentRunsV2 } from '../schema-v2.ts';

export interface InsertAgentRunRowV2Input {
  /** PC-minted ULID. Matches the AgentRun wrapper's `agentRunId`. */
  id: ULID;
  projectId: ULID;
  podName: string;
  dispatcherSessionId: string;
  ccSessionId: string;
  /** Initial status. Usually `'queued'` at admission time; a downstream
   *  caller flips it to `'spawning'` when the cap frees. */
  status: AgentRunStatusV2;
  input: string | null;
  parentWorkItemId?: ULID | null;
  parentInvokeDepth?: number;
  /** Null for original dispatches; FK to parent row for continuations. */
  continues?: ULID | null;
  /** Pod row's `updated_at` (or revision hash) at dispatch time. Stored for
   *  §6.4 drift detection on resume. Null when the materialiser didn't
   *  supply a revision. */
  podRevisionAtDispatch?: string | null;
  queuedAt: number;
}

/** Insert a fresh row. Status starts at the caller's choice (typically
 *  'queued'); subsequent transitions go through `updateAgentRunStatusV2` +
 *  `markAgentRunTerminalV2`. */
export function insertAgentRunRowV2(input: InsertAgentRunRowV2Input): AgentRunRowV2 {
  const row: AgentRunRowV2 = {
    id: input.id,
    projectId: input.projectId,
    dispatcherSessionId: input.dispatcherSessionId,
    ccSessionId: input.ccSessionId,
    podName: input.podName,
    podRevisionAtDispatch: input.podRevisionAtDispatch ?? null,
    podRevisionAtResume: null,
    status: input.status,
    continues: input.continues ?? null,
    parentInvokeDepth: input.parentInvokeDepth ?? 0,
    parentWorkItemId: input.parentWorkItemId ?? null,
    input: input.input,
    result: null,
    failureCause: null,
    failureReason: null,
    queuedAt: input.queuedAt,
    spawnedAt: null,
    readyAt: null,
    completedAt: null,
  };
  getDb().insert(agentRunsV2).values(row).run();
  return row;
}

export interface UpdateAgentRunStatusV2Input {
  id: ULID;
  status: AgentRunStatusV2;
  /** Set when transitioning into 'spawning' (or 'spawning' from 'paused' on
   *  resume — both paths re-arm the spawn timestamp). */
  spawnedAt?: number;
  /** Set when transitioning into 'running'. */
  readyAt?: number;
  /** Set on the resume path (paused → spawning). Captures pod-row revision
   *  at resume time for §6.4 drift detection. */
  podRevisionAtResume?: string | null;
}

/** Non-terminal status transition. Idempotent at the row level — caller is
 *  responsible for ordering. */
export function updateAgentRunStatusV2(input: UpdateAgentRunStatusV2Input): void {
  const patch: Partial<AgentRunRowV2> = { status: input.status };
  if (input.spawnedAt !== undefined) patch.spawnedAt = input.spawnedAt;
  if (input.readyAt !== undefined) patch.readyAt = input.readyAt;
  if (input.podRevisionAtResume !== undefined) {
    patch.podRevisionAtResume = input.podRevisionAtResume;
  }
  getDb().update(agentRunsV2).set(patch).where(eq(agentRunsV2.id, input.id)).run();
}

export interface MarkAgentRunTerminalV2Input {
  id: ULID;
  status: Extract<AgentRunStatusV2, 'completed' | 'failed' | 'cancelled'>;
  result: string | null;
  failureCause: AgentRunFailureCauseV2 | null;
  failureReason: string | null;
  completedAt: number;
}

/** Flip to a terminal status. Idempotent at the row level — repeated calls
 *  with the same terminal status are no-ops. */
export function markAgentRunTerminalV2(input: MarkAgentRunTerminalV2Input): void {
  getDb()
    .update(agentRunsV2)
    .set({
      status: input.status,
      result: input.result,
      failureCause: input.failureCause,
      failureReason: input.failureReason,
      completedAt: input.completedAt,
    })
    .where(eq(agentRunsV2.id, input.id))
    .run();
}

/** Point read by ULID. `pc_continue_agent` calls this to validate the
 *  parent exists + is in a continuable state. */
export function getAgentRunRowV2(id: ULID): AgentRunRowV2 | null {
  const row = getDb().select().from(agentRunsV2).where(eq(agentRunsV2.id, id)).get();
  return row ?? null;
}

export interface ListAgentRunsForSessionV2Options {
  podName?: string;
  status?: AgentRunStatusV2;
  /** 1-based cap on returned rows. */
  limit: number;
}

/** Hot path for `pc_list_my_runs`. Filter by (project, dispatcher session),
 *  optionally by pod name / status. Newest first. */
export function listAgentRunsForSessionV2(
  projectId: ULID,
  dispatcherSessionId: string,
  opts: ListAgentRunsForSessionV2Options,
): AgentRunRowV2[] {
  const filters = [
    eq(agentRunsV2.projectId, projectId),
    eq(agentRunsV2.dispatcherSessionId, dispatcherSessionId),
  ];
  if (opts.podName) filters.push(eq(agentRunsV2.podName, opts.podName));
  if (opts.status) filters.push(eq(agentRunsV2.status, opts.status));
  return getDb()
    .select()
    .from(agentRunsV2)
    .where(and(...filters))
    .orderBy(desc(agentRunsV2.queuedAt))
    .limit(opts.limit)
    .all();
}

/** Concurrent-continuation guard. Returns a non-terminal continuation row
 *  if one exists for `priorRunId`. `pc_continue_agent` rejects with 409
 *  when this comes back non-null. */
export function findActiveContinuationV2(priorRunId: ULID): AgentRunRowV2 | null {
  const row = getDb()
    .select()
    .from(agentRunsV2)
    .where(
      and(
        eq(agentRunsV2.continues, priorRunId),
        inArray(agentRunsV2.status, ['queued', 'spawning', 'running', 'paused']),
      ),
    )
    .get();
  return row ?? null;
}

/** Boot-time reconciliation sweep. Any row stuck in a non-terminal status
 *  when the server starts means the prior process died mid-flight. Flip
 *  them to `failed / server-restart` so subsequent queries don't treat
 *  them as live. Returns the count of rows affected. */
export function reconcileOrphanedRunningRunsV2(now: number): number {
  const res = getDb()
    .update(agentRunsV2)
    .set({
      status: 'failed',
      failureReason: 'server restarted before this run completed',
      failureCause: 'server-restart',
      completedAt: now,
    })
    .where(inArray(agentRunsV2.status, ['queued', 'spawning', 'running', 'paused']))
    .run();
  return res.changes;
}
