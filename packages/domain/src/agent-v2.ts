// Section 25 — agent system v2 domain types.
//
// Lives alongside v1 (`agent-run.ts` + `agent-comms.ts`) during the parallel
// build phase. After Phase D's clean swap, v1 dies and the `V2` suffixes drop.
//
// Differences from v1:
// - `AgentRunStatusV2` persists the full state machine (`queued | spawning |
//   running | paused | completed | failed | cancelled`) instead of v1's
//   intermediate-states-stay-in-memory split. The persisted status mirrors
//   AgentRun's in-memory state 1:1 — simpler reconciliation, no surprise
//   when restart-time sweeps see a `paused` row.
// - `AgentRunFailureCauseV2` adds `mcp-handshake-never` and
//   `kill-during-spawn` per design §8.1; drops v1's `concurrent-continuation`
//   (the route layer rejects with 409 before a row is inserted, so the
//   failure-cause taxonomy doesn't need to represent it).
// - `AgentInboxEventKindV2` splits `agent-asks-orchestrator` back into
//   `agent-asks-orchestrator` + `agent-asks-user` (Section 16b primitives)
//   and adds `agent-run-changed` + `agent-jsonl-event` per design §5.4.
// - `AgentInboxDriverV2` is `'channel' | 'user-prompt'`. No `'unknown'` or
//   `'autonomous'` — every audit row gets a definite driver (audit row is
//   written at flip time, not stubbed at enqueue).
// - `PendingAskKindV2` is the bare `'orchestrator' | 'user' | 'approval'`
//   (matches design §1's glossary; v1's `'ask-orchestrator' | 'ask-user'`
//   were verbose).

import type { ULID } from './ulid.ts';
import type { PendingAskOption } from './agent-comms.ts';

/** Full in-memory state machine, persisted 1:1. */
export type AgentRunStatusV2 =
  | 'queued'
  | 'spawning'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const AGENT_RUN_STATUSES_V2: readonly AgentRunStatusV2[] = [
  'queued',
  'spawning',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
];

/** Coarse failure taxonomy. The wrapper picks one at terminal-failed; the
 *  route layer never invents new ones (preserves the closed-world property). */
export type AgentRunFailureCauseV2 =
  | 'spawn-stuck'
  | 'idle-timeout'
  | 'wall-clock-timeout'
  | 'ready-timeout'
  | 'spawn-error'
  | 'send-failed'
  | 'unexpected-exit'
  | 'cancel-while-queued'
  | 'cancelled'
  | 'mcp-handshake-never'
  | 'kill-during-spawn'
  | 'server-restart';

export const AGENT_RUN_FAILURE_CAUSES_V2: readonly AgentRunFailureCauseV2[] = [
  'spawn-stuck',
  'idle-timeout',
  'wall-clock-timeout',
  'ready-timeout',
  'spawn-error',
  'send-failed',
  'unexpected-exit',
  'cancel-while-queued',
  'cancelled',
  'mcp-handshake-never',
  'kill-during-spawn',
  'server-restart',
];

/** One persisted agent_runs_v2 row. Mirrors AgentRunRecord but adds the
 *  drift-detection fields and explicit lifecycle timestamps. */
export interface AgentRunRowV2 {
  id: ULID;
  projectId: ULID;
  /** PC session-id (ULID) of the orchestrator (or other AgentRun) that
   *  dispatched this run. */
  dispatcherSessionId: string;
  /** CC's provider session-id. UUID. Reused via `--resume` on continuation. */
  ccSessionId: string;
  podName: string;
  /** Updated-at hash (or revision string) of the pod row at dispatch time.
   *  Used by §6.4 drift detection to flag continuations against an edited
   *  pod. NULL when the materialiser didn't supply a revision. */
  podRevisionAtDispatch: string | null;
  /** Updated-at hash of the pod row at resume time. Differs from
   *  `podRevisionAtDispatch` iff the pod was edited between dispatch and
   *  resume. NULL for non-resumed runs. */
  podRevisionAtResume: string | null;
  status: AgentRunStatusV2;
  /** Self-FK to parent run for continuations. */
  continues: ULID | null;
  parentInvokeDepth: number;
  parentWorkItemId: ULID | null;
  /** Verbatim initial input. NULL on resumes that carry no new input. */
  input: string | null;
  /** Final assistant text. NULL until terminal-completed. */
  result: string | null;
  failureCause: AgentRunFailureCauseV2 | null;
  failureReason: string | null;
  queuedAt: number;
  spawnedAt: number | null;
  readyAt: number | null;
  completedAt: number | null;
}

/** v2 pending-ask kind. Bare kinds matching design §1's identifier glossary. */
export type PendingAskKindV2 = 'orchestrator' | 'user' | 'approval';

export const PENDING_ASK_KINDS_V2: readonly PendingAskKindV2[] = [
  'orchestrator',
  'user',
  'approval',
];

export type PendingAskStatusV2 = 'open' | 'answered' | 'cancelled';

export const PENDING_ASK_STATUSES_V2: readonly PendingAskStatusV2[] = [
  'open',
  'answered',
  'cancelled',
];

export interface PendingAskRowV2 {
  id: ULID;
  agentRunId: ULID;
  /** Denormalised — survives agent_run row deletion / archival. */
  ccSessionId: string;
  projectId: ULID;
  parentWorkItemId: ULID | null;
  kind: PendingAskKindV2;
  promptBody: string;
  context: string | null;
  /** Multi-choice for `approval` (always populated) and optional for `user`. */
  options: PendingAskOption[] | null;
  status: PendingAskStatusV2;
  answerBody: string | null;
  answeredBy: 'orchestrator' | 'user' | null;
  createdAt: number;
  answeredAt: number | null;
  cancelledAt: number | null;
}

/** v2 inbox event-kind set. Full superset from design §5.4 — adds the two
 *  pause kinds back (orchestrator + user) and the two run-state kinds
 *  (changed + jsonl-event) that v1 didn't carry. */
export type AgentInboxEventKindV2 =
  | 'agent-asks-orchestrator'
  | 'agent-asks-user'
  | 'agent-approval-request'
  | 'agent-completed'
  | 'agent-failed'
  | 'agent-queued-started'
  | 'agent-run-changed'
  | 'agent-jsonl-event';

export const AGENT_INBOX_EVENT_KINDS_V2: readonly AgentInboxEventKindV2[] = [
  'agent-asks-orchestrator',
  'agent-asks-user',
  'agent-approval-request',
  'agent-completed',
  'agent-failed',
  'agent-queued-started',
  'agent-run-changed',
  'agent-jsonl-event',
];

export type AgentInboxStatusV2 = 'pending' | 'delivered';

export const AGENT_INBOX_STATUSES_V2: readonly AgentInboxStatusV2[] = [
  'pending',
  'delivered',
];

/** v2 delivery driver. No `'unknown'` — audit row is written at flip time
 *  with a definite driver, never stubbed at enqueue. */
export type AgentInboxDriverV2 = 'channel' | 'user-prompt';

export const AGENT_INBOX_DRIVERS_V2: readonly AgentInboxDriverV2[] = [
  'channel',
  'user-prompt',
];

export interface AgentInboxRowV2 {
  id: ULID;
  projectId: ULID;
  /** Recipient PC session-id (orchestrator's session or another AgentRun's
   *  dispatcher_session_id). */
  pcSessionId: string;
  kind: AgentInboxEventKindV2;
  body: string;
  status: AgentInboxStatusV2;
  driver: AgentInboxDriverV2 | null;
  createdAt: number;
  deliveredAt: number | null;
}

export interface AgentDeliveryAuditRowV2 {
  id: ULID;
  inboxId: ULID;
  driver: AgentInboxDriverV2;
  deliveredAt: number;
  /** Wall-clock ms between inbox-row creation and delivery. */
  latencyMs: number;
}
