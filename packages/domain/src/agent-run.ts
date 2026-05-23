// Section 21 — Persisted agent_runs row.
//
// Mirrors the AgentRunRecord shape held in-memory by AgentRunManager,
// but trimmed to what's load-bearing for restart resilience + the two
// Section-21 consumers (`pc_continue_agent`, `pc_list_my_runs`).
//
// `running` rows that outlive their AgentRunManager (server restart while
// a run was in flight) are orphaned in the DB. They surface as "stuck
// running" until reconciled. Reconciliation policy: on AgentRunManager
// boot, sweep `running` rows owned by no live process and flip them to
// `failed` with `failureCause = 'server-restart'`. (Implementation lives
// in the manager, not here — domain only types the shape.)
//
// Status is a STRICT SUBSET of the in-memory AgentRunStatus. We persist
// only spawn-time and terminal states; intermediate transitions
// (`spawning` → `paused` → `running`) stay in-memory.

import type { ULID } from './ulid.ts';

/** Persisted status for an agent run. Spawn-time insert uses `'running'`;
 *  terminal updates write one of `completed | failed | cancelled`. The
 *  in-memory `AgentRunStatus` (`spawning`, `paused`, `queued`) intentionally
 *  doesn't reach the DB — those states are transient and only meaningful
 *  while the AgentRunManager owns the live session. */
export type AgentRunPersistedStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export const AGENT_RUN_PERSISTED_STATUSES: readonly AgentRunPersistedStatus[] = [
  'running',
  'completed',
  'failed',
  'cancelled',
];

/** Coarse failure-cause taxonomy persisted alongside `status = 'failed'`.
 *  Mirrors the in-memory AgentRunFailureCause with two additions over the
 *  spawn / runtime causes: the boot-time reconciliation sweep stamps
 *  orphaned-running rows with `'server-restart'`, and Section 21's
 *  in-memory concurrent-continuation guard fails a same-tick second
 *  continuation attempt with `'concurrent-continuation'`. */
export type AgentRunFailureCause =
  | 'timeout'
  | 'idle-timeout'
  | 'spawn-failed'
  | 'spawn-exit'
  | 'spawn-stuck'
  | 'cancelled'
  | 'unknown-agent'
  | 'server-restart'
  | 'concurrent-continuation';

export const AGENT_RUN_FAILURE_CAUSES: readonly AgentRunFailureCause[] = [
  'timeout',
  'idle-timeout',
  'spawn-failed',
  'spawn-exit',
  'spawn-stuck',
  'cancelled',
  'unknown-agent',
  'server-restart',
  'concurrent-continuation',
];

/** One agent_runs row. The shape the repo returns and the route handlers
 *  surface. */
export interface AgentRunRow {
  /** PC-minted ULID. Matches the in-memory `AgentRunRecord.runId`. */
  id: ULID;
  projectId: ULID;
  agentName: string;
  /** PC session-id of the orchestrator that dispatched this run. Ownership
   *  check for `pc_continue_agent` — only the dispatcher can continue. */
  dispatcherSessionId: string;
  /** CC's provider session-id — minted via `--session-id` at original
   *  spawn, reused via `--resume` on continuation. */
  sessionId: string;
  /** Verbatim initial input the orchestrator passed to `pc_invoke_agent`
   *  (or `pc_continue_agent` for continuation rows). Surfaces in
   *  `pc_list_my_runs` summaries (first ~80 chars). Stored in full so
   *  summary-length policy can change without lossy backfill. */
  input: string;
  parentWorkItemId: ULID | null;
  parentInvokeDepth: number;
  status: AgentRunPersistedStatus;
  /** Final assistant text. Null until terminal `completed`. */
  result: string | null;
  failureReason: string | null;
  failureCause: AgentRunFailureCause | null;
  /** Section 21 — when this row is a continuation, points at the prior
   *  run's id. Null for original dispatches. New AgentRunRow per
   *  continuation; lineage chains via this column. */
  continues: ULID | null;
  dispatchedAt: number;
  completedAt: number | null;
}
