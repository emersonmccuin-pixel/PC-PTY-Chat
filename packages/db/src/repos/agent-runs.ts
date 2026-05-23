// Section 21 — Agent runs repo.
//
// AgentRunManager writes one row per `pc_invoke_agent` / `pc_continue_agent`
// dispatch (`insertAgentRunRow`), then updates it on terminal state
// (`markAgentRunTerminal`). Queried by `pc_list_my_runs` (filter by
// dispatcher session) + `pc_continue_agent` (lookup by id; ownership check;
// concurrent-continuation guard via `findActiveContinuation`).

import { and, desc, eq } from 'drizzle-orm';

import type {
  AgentRunFailureCause,
  AgentRunPersistedStatus,
  AgentRunRow,
  ULID,
} from '@pc/domain';

import { getDb } from '../connection.ts';
import { agentRuns } from '../schema.ts';

export interface InsertAgentRunRowInput {
  /** PC-minted ULID. Matches the AgentRunManager's in-memory `runId`. */
  id: ULID;
  projectId: ULID;
  agentName: string;
  dispatcherSessionId: string;
  sessionId: string;
  input: string;
  parentWorkItemId: ULID | null;
  parentInvokeDepth: number;
  /** Null for original dispatches; FK to parent row for continuations. */
  continues: ULID | null;
  dispatchedAt: number;
}

/** Insert at spawn time with `status = 'running'`. Caller is responsible
 *  for mint-and-write ordering — the row must exist before the spawn can
 *  reference it. */
export function insertAgentRunRow(input: InsertAgentRunRowInput): AgentRunRow {
  const row: AgentRunRow = {
    id: input.id,
    projectId: input.projectId,
    agentName: input.agentName,
    dispatcherSessionId: input.dispatcherSessionId,
    sessionId: input.sessionId,
    input: input.input,
    parentWorkItemId: input.parentWorkItemId,
    parentInvokeDepth: input.parentInvokeDepth,
    status: 'running',
    result: null,
    failureReason: null,
    failureCause: null,
    continues: input.continues,
    dispatchedAt: input.dispatchedAt,
    completedAt: null,
  };
  getDb().insert(agentRuns).values(row).run();
  return row;
}

export interface MarkAgentRunTerminalInput {
  id: ULID;
  status: Exclude<AgentRunPersistedStatus, 'running'>;
  result: string | null;
  failureReason: string | null;
  failureCause: AgentRunFailureCause | null;
  completedAt: number;
}

/** Update the row to a terminal state. Idempotent — repeated calls with
 *  the same terminal status are no-ops at the row level (the WHERE clause
 *  doesn't constrain on prior status; the manager is responsible for not
 *  double-firing). */
export function markAgentRunTerminal(input: MarkAgentRunTerminalInput): void {
  getDb()
    .update(agentRuns)
    .set({
      status: input.status,
      result: input.result,
      failureReason: input.failureReason,
      failureCause: input.failureCause,
      completedAt: input.completedAt,
    })
    .where(eq(agentRuns.id, input.id))
    .run();
}

/** Lookup for `pc_continue_agent` — fetch by id. Returns null when the
 *  row doesn't exist (caller surfaces a clear `run-not-found` error). */
export function getAgentRunRow(id: ULID): AgentRunRow | null {
  const row = getDb().select().from(agentRuns).where(eq(agentRuns.id, id)).get();
  return row ?? null;
}

export interface ListAgentRunsForSessionOptions {
  agentName?: string;
  status?: AgentRunPersistedStatus;
  /** 1-based cap on returned rows. Caller enforces the upper bound. */
  limit: number;
}

/** `pc_list_my_runs` hot path. Filter by dispatcher session, optionally
 *  by agent name / status, newest first. */
export function listAgentRunsForSession(
  dispatcherSessionId: string,
  opts: ListAgentRunsForSessionOptions,
): AgentRunRow[] {
  const filters = [eq(agentRuns.dispatcherSessionId, dispatcherSessionId)];
  if (opts.agentName) filters.push(eq(agentRuns.agentName, opts.agentName));
  if (opts.status) filters.push(eq(agentRuns.status, opts.status));
  return getDb()
    .select()
    .from(agentRuns)
    .where(and(...filters))
    .orderBy(desc(agentRuns.dispatchedAt))
    .limit(opts.limit)
    .all();
}

/** Concurrent-continuation guard — does this parent already have a
 *  non-terminal continuation in flight? `pc_continue_agent` calls this
 *  pre-spawn and rejects with a clear error when a row comes back. */
export function findActiveContinuation(priorRunId: ULID): AgentRunRow | null {
  const row = getDb()
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.continues, priorRunId), eq(agentRuns.status, 'running')))
    .get();
  return row ?? null;
}

/** Boot-time reconciliation sweep. Rows that outlive the AgentRunManager
 *  (server died mid-run) stay stuck in `running`; this flips them to
 *  `failed` with `failure_cause = 'server-restart'` so they're not
 *  treated as in-flight by subsequent queries. Returns the count of rows
 *  affected. */
export function reconcileOrphanedRunningRuns(now: number): number {
  const res = getDb()
    .update(agentRuns)
    .set({
      status: 'failed',
      failureReason: 'server restarted before this run completed',
      failureCause: 'server-restart',
      completedAt: now,
    })
    .where(eq(agentRuns.status, 'running'))
    .run();
  return res.changes;
}
