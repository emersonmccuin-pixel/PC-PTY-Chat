// Section 25 — agent system tables (post-Phase-E bare names).
//
// Kept in a separate file from `schema.ts` so the agent-system concern stays
// grep-able. Tables are bare-named — the legacy v1 set was renamed to
// `*_v1_archive` by migration 0015 (Phase D, Session 11).
//
// Conventions match schema.ts: ULID PKs as `text`, timestamps as `integer`
// epoch ms, JSON blobs via `text({ mode: 'json' })`, foreign keys declared via
// `.references(...)`.

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  AgentInboxDriver,
  AgentInboxEventKind,
  AgentInboxStatus,
  AgentRunFailureCause,
  AgentRunStatus,
  PendingAskKind,
  PendingAskOption,
  PendingAskStatus,
  ULID,
} from '@pc/domain';

import { projects } from './schema.ts';

/**
 * Persisted dispatch record. Mirrors the in-memory AgentRunRecord 1:1 —
 * intermediate states (`queued | spawning | running | paused`) are persisted
 * alongside the terminal states (`completed | failed | cancelled`).
 *
 * Continuation lineage via `continues` (self-FK). Each `pc_continue_agent`
 * dispatch creates a new row whose `cc_session_id` matches the parent's.
 * Walking `continues` backwards reconstructs the chain.
 *
 * `pod_revision_at_dispatch` + `pod_revision_at_resume` enable drift
 * detection. If they differ, the orchestrator can surface "the pod changed
 * between dispatch and resume" to the user.
 */
export const agentRuns = sqliteTable(
  'agent_runs',
  {
    id: text('id').primaryKey().$type<ULID>(),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id),
    /** PC session-id of the dispatcher (orchestrator or parent agent). */
    dispatcherSessionId: text('dispatcher_session_id').notNull(),
    /** CC's provider session-id (UUID). Continuations share this with parent. */
    ccSessionId: text('cc_session_id').notNull(),
    podName: text('pod_name').notNull(),
    /** Updated-at hash of the pod row at dispatch time. Drift-detection input. */
    podRevisionAtDispatch: text('pod_revision_at_dispatch'),
    /** Updated-at hash at resume time. NULL until resumed. */
    podRevisionAtResume: text('pod_revision_at_resume'),
    status: text('status').notNull().$type<AgentRunStatus>(),
    /** Self-FK to parent run id for continuations. NULL for original
     *  dispatches. */
    continues: text('continues').$type<ULID | null>(),
    parentInvokeDepth: integer('parent_invoke_depth').notNull().default(0),
    parentWorkItemId: text('parent_work_item_id').$type<ULID | null>(),
    /** Verbatim initial input. NULL on resumes carrying no new input. */
    input: text('input'),
    /** Final assistant text. NULL until terminal-completed. */
    result: text('result'),
    failureCause: text('failure_cause').$type<AgentRunFailureCause | null>(),
    failureReason: text('failure_reason'),
    queuedAt: integer('queued_at').notNull(),
    spawnedAt: integer('spawned_at'),
    readyAt: integer('ready_at'),
    completedAt: integer('completed_at'),
    /** Monotonic write counter — incremented on every status transition.
     *  WS deltas carry this so the frontend can discard stale deliveries. */
    rev: integer('rev').notNull().default(0),
  },
  (t) => [
    index('agent_runs_session_queued_idx').on(t.dispatcherSessionId, t.queuedAt),
    index('agent_runs_continues_idx').on(t.continues),
    index('agent_runs_project_status_idx').on(t.projectId, t.status),
    index('agent_runs_cc_session_idx').on(t.ccSessionId),
  ],
);

/**
 * One row per pause event. Survives the CC child process exiting (CC exits
 * cleanly on pause — JSONL state is preserved on disk; PC's `agent_runs`
 * status flips to `'paused'`).
 *
 * Status enforces "answer-once": the route layer transitions `open → answered`
 * (or `open → cancelled`) atomically via UPDATE WHERE status='open'.
 */
export const pendingAsks = sqliteTable(
  'pending_asks',
  {
    id: text('id').primaryKey().$type<ULID>(),
    agentRunId: text('agent_run_id')
      .notNull()
      .$type<ULID>()
      .references(() => agentRuns.id),
    /** Denormalised CC provider session-id; survives the agent_run row being
     *  archived. */
    ccSessionId: text('cc_session_id').notNull(),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id),
    parentWorkItemId: text('parent_work_item_id').$type<ULID | null>(),
    kind: text('kind').notNull().$type<PendingAskKind>(),
    promptBody: text('prompt_body').notNull(),
    context: text('context'),
    options: text('options', { mode: 'json' }).$type<PendingAskOption[] | null>(),
    status: text('status').notNull().default('open').$type<PendingAskStatus>(),
    answerBody: text('answer_body'),
    answeredBy: text('answered_by').$type<'orchestrator' | 'user' | null>(),
    createdAt: integer('created_at').notNull(),
    answeredAt: integer('answered_at'),
    cancelledAt: integer('cancelled_at'),
  },
  (t) => [
    index('pending_asks_project_status_idx').on(t.projectId, t.status),
    index('pending_asks_agent_run_idx').on(t.agentRunId),
    index('pending_asks_cc_session_idx').on(t.ccSessionId),
  ],
);

/**
 * Durability layer of the hybrid delivery transport. Every outbound agent →
 * recipient event lands here as a row before any best-effort channel push.
 */
export const agentInbox = sqliteTable(
  'agent_inbox',
  {
    id: text('id').primaryKey().$type<ULID>(),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id),
    /** PC session-id of the recipient surface. */
    pcSessionId: text('pc_session_id').notNull(),
    kind: text('kind').notNull().$type<AgentInboxEventKind>(),
    body: text('body').notNull(),
    status: text('status').notNull().default('pending').$type<AgentInboxStatus>(),
    driver: text('driver').$type<AgentInboxDriver | null>(),
    createdAt: integer('created_at').notNull(),
    deliveredAt: integer('delivered_at'),
  },
  (t) => [
    index('agent_inbox_project_session_status_idx').on(
      t.projectId,
      t.pcSessionId,
      t.status,
    ),
    index('agent_inbox_session_created_idx').on(t.pcSessionId, t.createdAt),
  ],
);

/**
 * Observational audit. One row per successful delivery — never written for
 * still-pending rows.
 */
export const agentDeliveryAudit = sqliteTable(
  'agent_delivery_audit',
  {
    id: text('id').primaryKey().$type<ULID>(),
    inboxId: text('inbox_id')
      .notNull()
      .$type<ULID>()
      .references(() => agentInbox.id),
    driver: text('driver').notNull().$type<AgentInboxDriver>(),
    deliveredAt: integer('delivered_at').notNull(),
    /** Wall-clock ms between inbox creation and delivery flip. */
    latencyMs: integer('latency_ms').notNull(),
  },
  (t) => [
    index('agent_delivery_audit_inbox_idx').on(t.inboxId),
  ],
);
