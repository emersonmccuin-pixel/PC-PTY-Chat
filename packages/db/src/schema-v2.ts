// Section 25 — agent system v2 tables (Session 7).
//
// Lives alongside the v1 schema (`schema.ts`) during the parallel build phase
// (Phases A–C of the migration plan in design §15). At Phase D's clean swap,
// the v1 `agent_runs` / `pending_asks` / `agent_inbox` / `agent_delivery_audit`
// tables rename to `*_v1_archive` and the v2 tables drop their suffix.
//
// Why a separate file rather than additions in `schema.ts`:
// - Cutover (Phase D) is a clean rename + delete; segregation makes the diff
//   small + reviewable.
// - During the build, having a single file for v2 reduces the search radius
//   when something v2-specific needs an audit.
//
// Conventions match v1's schema.ts: ULID PKs as `text`, timestamps as
// `integer` epoch ms, JSON blobs via `text({ mode: 'json' })`, foreign keys
// declared via `.references(...)`.

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  AgentInboxDriverV2,
  AgentInboxEventKindV2,
  AgentInboxStatusV2,
  AgentRunFailureCauseV2,
  AgentRunStatusV2,
  PendingAskKindV2,
  PendingAskOption,
  PendingAskStatusV2,
  ULID,
} from '@pc/domain';

import { projects } from './schema.ts';

/**
 * Persisted dispatch record. Mirrors the in-memory AgentRunRecord 1:1 —
 * intermediate states (`queued | spawning | running | paused`) are persisted
 * alongside the terminal states (`completed | failed | cancelled`). Removes
 * v1's "intermediate-states-stay-in-memory" split that made restart
 * reconciliation awkward.
 *
 * Continuation lineage via `continues` (self-FK). Each `pc_continue_agent`
 * dispatch creates a new row whose `cc_session_id` matches the parent's.
 * Walking `continues` backwards reconstructs the chain.
 *
 * `pod_revision_at_dispatch` + `pod_revision_at_resume` enable §6.4 drift
 * detection. If they differ, the orchestrator can surface "the pod changed
 * between dispatch and resume" to the user.
 */
export const agentRunsV2 = sqliteTable(
  'agent_runs_v2',
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
    status: text('status').notNull().$type<AgentRunStatusV2>(),
    /** Self-FK to parent run id for continuations. NULL for original
     *  dispatches. */
    continues: text('continues').$type<ULID | null>(),
    parentInvokeDepth: integer('parent_invoke_depth').notNull().default(0),
    parentWorkItemId: text('parent_work_item_id').$type<ULID | null>(),
    /** Verbatim initial input. NULL on resumes carrying no new input. */
    input: text('input'),
    /** Final assistant text. NULL until terminal-completed. */
    result: text('result'),
    failureCause: text('failure_cause').$type<AgentRunFailureCauseV2 | null>(),
    failureReason: text('failure_reason'),
    queuedAt: integer('queued_at').notNull(),
    spawnedAt: integer('spawned_at'),
    readyAt: integer('ready_at'),
    completedAt: integer('completed_at'),
  },
  (t) => [
    /** `pc_list_my_runs` hot path: filter by dispatcher session, newest first. */
    index('agent_runs_v2_session_queued_idx').on(t.dispatcherSessionId, t.queuedAt),
    /** Continuation-chain navigation + concurrent-continuation guard. */
    index('agent_runs_v2_continues_idx').on(t.continues),
    /** Restart-time reconciliation sweep + project-scoped diagnostics. */
    index('agent_runs_v2_project_status_idx').on(t.projectId, t.status),
    /** `cc_session_id` lookup for resume / continuation. */
    index('agent_runs_v2_cc_session_idx').on(t.ccSessionId),
  ],
);

/**
 * One row per pause event. Survives the CC child process exiting (CC exits
 * cleanly on pause — JSONL state is preserved on disk; PC's `agent_runs_v2`
 * status flips to `'paused'`).
 *
 * Status enforces "answer-once": the route layer transitions `open → answered`
 * (or `open → cancelled`) atomically via UPDATE WHERE status='open'.
 */
export const pendingAsksV2 = sqliteTable(
  'pending_asks_v2',
  {
    id: text('id').primaryKey().$type<ULID>(),
    agentRunId: text('agent_run_id')
      .notNull()
      .$type<ULID>()
      .references(() => agentRunsV2.id),
    /** Denormalised CC provider session-id; survives the agent_run row being
     *  archived. */
    ccSessionId: text('cc_session_id').notNull(),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id),
    parentWorkItemId: text('parent_work_item_id').$type<ULID | null>(),
    kind: text('kind').notNull().$type<PendingAskKindV2>(),
    promptBody: text('prompt_body').notNull(),
    context: text('context'),
    options: text('options', { mode: 'json' }).$type<PendingAskOption[] | null>(),
    status: text('status').notNull().default('open').$type<PendingAskStatusV2>(),
    answerBody: text('answer_body'),
    answeredBy: text('answered_by').$type<'orchestrator' | 'user' | null>(),
    createdAt: integer('created_at').notNull(),
    answeredAt: integer('answered_at'),
    cancelledAt: integer('cancelled_at'),
  },
  (t) => [
    index('pending_asks_v2_project_status_idx').on(t.projectId, t.status),
    index('pending_asks_v2_agent_run_idx').on(t.agentRunId),
    index('pending_asks_v2_cc_session_idx').on(t.ccSessionId),
  ],
);

/**
 * Durability layer of the hybrid delivery transport (design §5). Every
 * outbound agent → recipient event lands here as a row before any
 * best-effort channel push. Drained by two paths:
 *
 *   1. Channel push success on enqueue OR auto-flush on bridge registration
 *      → status=delivered, driver='channel'.
 *   2. UserPromptSubmit hook (inbox-drain.cjs) → status=delivered,
 *      driver='user-prompt'.
 *
 * The `_v2` table is leaner than v1's `agent_inbox`:
 * - Renames `recipient_session_id` → `pc_session_id` (matches the design
 *   doc's identifier glossary § 1).
 * - Renames `event_kind` → `kind` (cleaner; matches design §5.4).
 * - Renames `payload_body` → `body`.
 * - Adds `driver` column directly on the inbox row (v1 stored it only on
 *   the audit row). Lets diagnostics queries answer "by what path did this
 *   row deliver" without joining audit.
 */
export const agentInboxV2 = sqliteTable(
  'agent_inbox_v2',
  {
    id: text('id').primaryKey().$type<ULID>(),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id),
    /** PC session-id of the recipient surface. */
    pcSessionId: text('pc_session_id').notNull(),
    kind: text('kind').notNull().$type<AgentInboxEventKindV2>(),
    body: text('body').notNull(),
    status: text('status').notNull().default('pending').$type<AgentInboxStatusV2>(),
    driver: text('driver').$type<AgentInboxDriverV2 | null>(),
    createdAt: integer('created_at').notNull(),
    deliveredAt: integer('delivered_at'),
  },
  (t) => [
    /** Hot read: drain query — pending rows for one session, oldest first. */
    index('agent_inbox_v2_project_session_status_idx').on(
      t.projectId,
      t.pcSessionId,
      t.status,
    ),
    index('agent_inbox_v2_session_created_idx').on(t.pcSessionId, t.createdAt),
  ],
);

/**
 * Observational audit. One row per successful delivery — never written for
 * still-pending rows. `latency_ms` is the wall-clock delta between
 * inbox-row creation and the delivery flip.
 *
 * v1's audit also recorded the channel-push *attempt* (succeeded:bool +
 * attemptedAt) even when no live registrant was present. v2 collapses that
 * to "audit on successful delivery only" — the inbox-row `status` already
 * tells us "did this ever deliver", and recording the attempt-without-success
 * added noise without diagnostic value (the hook drain path always fires
 * eventually as long as the row is pending).
 */
export const agentDeliveryAuditV2 = sqliteTable(
  'agent_delivery_audit_v2',
  {
    id: text('id').primaryKey().$type<ULID>(),
    inboxId: text('inbox_id')
      .notNull()
      .$type<ULID>()
      .references(() => agentInboxV2.id),
    driver: text('driver').notNull().$type<AgentInboxDriverV2>(),
    deliveredAt: integer('delivered_at').notNull(),
    /** Wall-clock ms between inbox creation and delivery flip. */
    latencyMs: integer('latency_ms').notNull(),
  },
  (t) => [
    /** Audit-by-inbox: one audit row per delivered inbox row, but unique
     *  isn't strictly enforced because a future retry path may write a
     *  second row. Index supports the diagnostics "trace this inbox row"
     *  query. */
    index('agent_delivery_audit_v2_inbox_idx').on(t.inboxId),
  ],
);
