import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  AgentDeliveryDriver,
  AgentEffort,
  AgentInboxEventKind,
  AgentInboxStatus,
  AgentModel,
  AgentOutputDestination,
  FieldSchemaType,
  GlobalSettings,
  NodeOutput,
  PendingAskKind,
  PendingAskOption,
  PendingAskStatus,
  PodAuditActor,
  PodAuditField,
  PodKnowledgeKind,
  PodMcpServerConfig,
  PodScope,
  ProviderId,
  SessionEndedReason,
  SessionStatus,
  Stage,
  ULID,
  WorkItemHistoryEntry,
  WorkItemStatus,
  WorkItemType,
  WorkflowRunStatus,
  WorkflowRunTrigger,
  WorktreeStatus,
} from '@pc/domain';

/**
 * v2 trunk schema (sqlite migration). 7 tables — projects, work_items,
 * workflows, workflow_runs, worktrees, orchestrator_sessions, settings_global.
 *
 * Conventions (mirror v1):
 * - ULIDs as `text` PKs.
 * - Timestamps as `integer` epoch ms (numbers in TS).
 * - JSON blobs via `text({ mode: 'json' })`.
 * - Soft delete = nullable `deleted_at` (where the table needs it).
 */

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey().$type<ULID>(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    settings: text('settings', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`)
      .$type<Record<string, unknown>>(),
    stages: text('stages', { mode: 'json' }).notNull().$type<Stage[]>(),
    folderPath: text('folder_path').notNull().default(''),
    gitRemote: text('git_remote'),
    /** 5+.4 (D87). Sort key for the LeftRail Projects list. New projects are
     *  appended at `max(position) + 1`; drag-reorder rewrites every row's
     *  position in a single transaction. */
    position: integer('position').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    uniqueIndex('projects_slug_idx').on(t.slug).where(sql`deleted_at IS NULL`),
    index('projects_position_idx').on(t.position),
  ],
);

export const workItems = sqliteTable(
  'work_items',
  {
    id: text('id').primaryKey().$type<ULID>(),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id),
    /** Self-FK; app-enforced. */
    parentId: text('parent_id').$type<ULID | null>(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /** Stage slug from `projects.stages` JSON; no FK. */
    stageId: text('stage_id').notNull(),
    status: text('status').notNull().default('pending').$type<WorkItemStatus>(),
    statusReason: text('status_reason'),
    /** Built-in fixed-set type ('task' | 'bug' | 'feature' | 'spike'). Default 'task'.
     *  Filed by `pc_log_bug` when value is 'bug'. */
    type: text('type').notNull().default('task').$type<WorkItemType>(),
    fields: text('fields', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`)
      .$type<Record<string, unknown>>(),
    /** Append-only event log (move + update entries). v2-only. */
    history: text('history', { mode: 'json' })
      .notNull()
      .default(sql`'[]'`)
      .$type<WorkItemHistoryEntry[]>(),
    /** Sort key within (parentId, stageId). Stable across moves. */
    position: integer('position').notNull().default(0),
    /** Optimistic-concurrency counter. */
    version: integer('version').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    index('work_items_project_idx').on(t.projectId),
    index('work_items_stage_idx').on(t.projectId, t.stageId),
  ],
);

/**
 * Scaffolded for the file-backed workflow registry to land in here later.
 * Today the runtime still loads YAMLs from `workspace/.project-companion/workflows/`
 * via the `@pc/workflows` registry; this table is empty until the sync hook is
 * wired in a follow-up sub-slice.
 */
export const workflows = sqliteTable(
  'workflows',
  {
    /** Slug from the YAML's `id:` field. String, not ULID — author-readable. */
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id),
    name: text('name').notNull(),
    yaml: text('yaml').notNull(),
    yamlHash: text('yaml_hash').notNull(),
    /** Parsed DAG (the @pc/domain `Workflow` shape, JSON-encoded). */
    parsedDefinition: text('parsed_definition', { mode: 'json' }),
    status: text('status', { enum: ['active', 'invalid'] }).notNull().default('active'),
    parseError: text('parse_error'),
    sourceFilename: text('source_filename').notNull().default(''),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [index('workflows_project_idx').on(t.projectId)],
);

export const workflowRuns = sqliteTable(
  'workflow_runs',
  {
    id: text('id').primaryKey().$type<ULID>(),
    /** Workflow slug. No FK — runtime uses the file-backed registry; the workflows
     *  table is scaffolded but not yet synced. */
    workflowId: text('workflow_id').notNull(),
    /** Denormalised for the run viewer. */
    workflowName: text('workflow_name').notNull(),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id),
    workItemId: text('work_item_id').$type<ULID | null>(),
    parentRunId: text('parent_run_id').$type<ULID | null>(),
    /** Node id (string slug) in the parent that spawned this run. */
    parentNodeId: text('parent_node_id'),
    /** stage_id slug if trigger='on_enter'. */
    stageId: text('stage_id'),
    trigger: text('trigger').notNull().$type<WorkflowRunTrigger>(),
    triggeredBySessionId: text('triggered_by_session_id').$type<ULID | null>(),
    status: text('status').notNull().default('pending').$type<WorkflowRunStatus>(),
    workflowYamlSnapshot: text('workflow_yaml_snapshot').notNull(),
    worktreePath: text('worktree_path'),
    inputs: text('inputs', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`)
      .$type<Record<string, unknown>>(),
    outputs: text('outputs', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`)
      .$type<Record<string, unknown>>(),
    /** Per-node status + output map, keyed by node id. */
    nodeOutputs: text('node_outputs', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`)
      .$type<Record<string, NodeOutput>>(),
    metadata: text('metadata', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`)
      .$type<Record<string, unknown>>(),
    lastReason: text('last_reason'),
    createdAt: integer('created_at').notNull(),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
    lastActivityAt: integer('last_activity_at'),
  },
  (t) => [
    index('workflow_runs_project_idx').on(t.projectId),
    index('workflow_runs_status_idx').on(t.status),
    index('workflow_runs_workflow_idx').on(t.workflowId),
    index('workflow_runs_parent_idx').on(t.parentRunId),
    index('workflow_runs_work_item_idx').on(t.workItemId),
  ],
);

/** Section 6.6 — activity-panel "Failed recently" region. The 4e Runs tab
 *  remains the canonical run history; this table only records per-row
 *  dismissals so a user can clear a failure off the at-a-glance list. */
export const failedRunDismissals = sqliteTable(
  'failed_run_dismissals',
  {
    runId: text('run_id')
      .primaryKey()
      .$type<ULID>()
      .references(() => workflowRuns.id),
    dismissedAt: integer('dismissed_at').notNull(),
  },
);

export const worktrees = sqliteTable(
  'worktrees',
  {
    id: text('id').primaryKey().$type<ULID>(),
    /** Branch name == worktree dir name (`wi-<id>` or `run-<short>`). */
    name: text('name').notNull(),
    path: text('path').notNull(),
    workItemId: text('work_item_id').$type<ULID | null>(),
    workflowRunId: text('workflow_run_id').$type<ULID | null>(),
    status: text('status').notNull().default('active').$type<WorktreeStatus>(),
    createdAt: integer('created_at').notNull(),
    destroyedAt: integer('destroyed_at'),
  },
  (t) => [
    uniqueIndex('worktrees_name_active_idx').on(t.name).where(sql`status = 'active'`),
    uniqueIndex('worktrees_path_active_idx').on(t.path).where(sql`status = 'active'`),
  ],
);

export const orchestratorSessions = sqliteTable(
  'orchestrator_sessions',
  {
    id: text('id').primaryKey().$type<ULID>(),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id),
    provider: text('provider').notNull().$type<ProviderId>(),
    /** Provider's own session ID. Null until first `result` event. */
    providerSessionId: text('provider_session_id'),
    model: text('model'),
    title: text('title'),
    status: text('status', { enum: ['active', 'ended'] })
      .notNull()
      .default('active')
      .$type<SessionStatus>(),
    endedReason: text('ended_reason').$type<SessionEndedReason>(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    deletedAt: integer('deleted_at'),
    /** Absolute path of CC's per-session JSONL file. Discovered by the runtime
     *  after spawn (scans `~/.claude/projects/<encoded-cwd>/`). */
    jsonlPath: text('jsonl_path'),
    /** Line count of CC's JSONL we've consumed. Persisted for resume. */
    jsonlLineCursor: integer('jsonl_line_cursor').notNull().default(0),
  },
  (t) => [
    /** One active session per project (DB-enforced). */
    uniqueIndex('orch_sessions_active_per_project_idx')
      .on(t.projectId)
      .where(sql`status = 'active' AND deleted_at IS NULL`),
  ],
);

export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey().$type<ULID>(),
    workItemId: text('work_item_id')
      .notNull()
      .$type<ULID>()
      .references(() => workItems.id),
    /** Free-form kind tag — 'text' | 'markdown' | 'json' are the known set. */
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    /** Inline payload. No filesystem-path variant — content always lives in the DB. */
    content: text('content').notNull(),
    contentType: text('content_type'),
    /** Workflow run that produced this attachment, or null for chat/user-created. */
    runId: text('run_id').$type<ULID | null>(),
    createdBySessionId: text('created_by_session_id').$type<ULID | null>(),
    /** Provenance — who produced the attachment. 'user' = chat/UI/test;
     *  'agent' = workflow subagent via the pc_attach_to_work_item MCP tool. */
    source: text('source').notNull().default('user').$type<'agent' | 'user'>(),
    /** When source === 'agent', the agent name. Null for user-created rows. */
    agentName: text('agent_name'),
    /** Workflow node id within `runId`. Null when the attachment was not produced
     *  by a workflow node (chat or top-of-run). */
    nodeId: text('node_id'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('attachments_work_item_idx').on(t.workItemId)],
);

export const fieldSchemas = sqliteTable(
  'field_schemas',
  {
    id: text('id').primaryKey().$type<ULID>(),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id),
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: text('type').notNull().$type<FieldSchemaType>(),
    /** Options for `type === 'enum'`; ignored otherwise. */
    options: text('options', { mode: 'json' }).$type<string[] | null>(),
    /** Default applied on work-item create when the user didn't provide a value. */
    default: text('default', { mode: 'json' }).$type<unknown>(),
    required: integer('required', { mode: 'boolean' }).notNull().default(false),
    description: text('description'),
    /** Order within the editor (low → high). */
    order: integer('order').notNull().default(0),
  },
  (t) => [
    index('field_schemas_project_idx').on(t.projectId),
    uniqueIndex('field_schemas_project_key_idx').on(t.projectId, t.key),
  ],
);

export const settingsGlobal = sqliteTable('settings_global', {
  id: text('id').primaryKey(),
  values: text('values', { mode: 'json' })
    .notNull()
    .default(sql`'{}'`)
    .$type<GlobalSettings>(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * Section 17a — Agent pod tables.
 *
 * Five tables (`agents` + four content tables + `agent_audit`). Every content
 * table carries `scope` + `project_id` from v1 even though v1 is global-only,
 * so the 17c per-project overlay lands without a migration.
 *
 * Conventions:
 * - ULIDs as `text` PKs.
 * - `tools_json` / `config_json` are JSON-encoded via Drizzle's `{ mode: 'json' }`.
 * - Soft delete on `agents` (`deleted_at` nullable); content tables are hard-
 *   deleted alongside an `agent_audit` row.
 * - Foreign keys: child tables reference `agents.id`. No CASCADE — application
 *   layer handles teardown order to ensure audit rows survive.
 */

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey().$type<ULID>(),
    /** Kebab-case agent name (CC frontmatter `name:` field). Materialised
     *  to `<worktree>/.claude/agents/<name>.md` at spawn time. */
    name: text('name').notNull(),
    scope: text('scope').notNull().$type<PodScope>(),
    /** NULL when `scope === 'global'`; required when `scope === 'project'`.
     *  App-enforced; sqlite doesn't constrain by enum-of-scope. */
    projectId: text('project_id').$type<ULID | null>(),
    prompt: text('prompt').notNull().default(''),
    /** Allowlist of tool names. Wildcards (`mcp__server__*`) are EXPANDED at
     *  materialisation time — never stored expanded. Empty = allow all. */
    tools: text('tools_json', { mode: 'json' })
      .notNull()
      .default(sql`'[]'`)
      .$type<string[]>(),
    model: text('model').$type<AgentModel | null>(),
    effort: text('effort').$type<AgentEffort | null>(),
    maxTurns: integer('max_turns'),
    outputDestination: text('output_destination').$type<AgentOutputDestination | null>(),
    description: text('description').notNull().default(''),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    /** Unique global agent name (live rows only). */
    uniqueIndex('agents_global_name_idx')
      .on(t.name)
      .where(sql`scope = 'global' AND deleted_at IS NULL`),
    /** Unique per-project agent name (live rows only). 17c lands without
     *  migration once project-scoped rows start arriving. */
    uniqueIndex('agents_project_name_idx')
      .on(t.projectId, t.name)
      .where(sql`scope = 'project' AND deleted_at IS NULL`),
    index('agents_scope_project_idx').on(t.scope, t.projectId),
  ],
);

export const agentKnowledge = sqliteTable(
  'agent_knowledge',
  {
    id: text('id').primaryKey().$type<ULID>(),
    agentId: text('agent_id')
      .notNull()
      .$type<ULID>()
      .references(() => agents.id),
    scope: text('scope').notNull().$type<PodScope>(),
    projectId: text('project_id').$type<ULID | null>(),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('knowledge').$type<PodKnowledgeKind>(),
    content: text('content').notNull().default(''),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('agent_knowledge_agent_idx').on(t.agentId),
    index('agent_knowledge_scope_project_idx').on(t.scope, t.projectId),
    /** Unique knowledge-doc name per agent. Split into two partial indices
     *  because sqlite treats NULL as distinct in unique indices — a single
     *  composite index on `project_id` would let dup names slip through for
     *  global rows (where project_id is NULL). */
    uniqueIndex('agent_knowledge_global_name_idx')
      .on(t.agentId, t.name)
      .where(sql`scope = 'global'`),
    uniqueIndex('agent_knowledge_project_name_idx')
      .on(t.agentId, t.projectId, t.name)
      .where(sql`scope = 'project'`),
  ],
);

export const agentSecrets = sqliteTable(
  'agent_secrets',
  {
    id: text('id').primaryKey().$type<ULID>(),
    agentId: text('agent_id')
      .notNull()
      .$type<ULID>()
      .references(() => agents.id),
    scope: text('scope').notNull().$type<PodScope>(),
    projectId: text('project_id').$type<ULID | null>(),
    envVarName: text('env_var_name').notNull(),
    /** v1: plaintext. v2 swaps to `encrypted_value` (DPAPI). Warning banner
     *  in the Secrets tab keeps the user aware of the v1 limitation. */
    valuePlaintext: text('value_plaintext').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('agent_secrets_agent_idx').on(t.agentId),
    index('agent_secrets_scope_project_idx').on(t.scope, t.projectId),
    /** Per-scope partial uniqueness — sqlite NULL-distinct gotcha (see
     *  agent_knowledge note). */
    uniqueIndex('agent_secrets_global_env_idx')
      .on(t.agentId, t.envVarName)
      .where(sql`scope = 'global'`),
    uniqueIndex('agent_secrets_project_env_idx')
      .on(t.agentId, t.projectId, t.envVarName)
      .where(sql`scope = 'project'`),
  ],
);

export const agentMcpServers = sqliteTable(
  'agent_mcp_servers',
  {
    id: text('id').primaryKey().$type<ULID>(),
    agentId: text('agent_id')
      .notNull()
      .$type<ULID>()
      .references(() => agents.id),
    scope: text('scope').notNull().$type<PodScope>(),
    projectId: text('project_id').$type<ULID | null>(),
    /** Server name as it lands in the materialised `mcp.json`'s `mcpServers`
     *  map. Project overlay wins per-server-name (17c). */
    name: text('name').notNull(),
    config: text('config_json', { mode: 'json' }).notNull().$type<PodMcpServerConfig>(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('agent_mcp_servers_agent_idx').on(t.agentId),
    index('agent_mcp_servers_scope_project_idx').on(t.scope, t.projectId),
    /** Per-scope partial uniqueness — sqlite NULL-distinct gotcha (see
     *  agent_knowledge note). Project overlay wins per-server-name (17c). */
    uniqueIndex('agent_mcp_servers_global_name_idx')
      .on(t.agentId, t.name)
      .where(sql`scope = 'global'`),
    uniqueIndex('agent_mcp_servers_project_name_idx')
      .on(t.agentId, t.projectId, t.name)
      .where(sql`scope = 'project'`),
  ],
);

export const agentAudit = sqliteTable(
  'agent_audit',
  {
    id: text('id').primaryKey().$type<ULID>(),
    agentId: text('agent_id')
      .notNull()
      .$type<ULID>()
      .references(() => agents.id),
    /** Groups multi-field edits (orchestrator change-set touching prompt +
     *  knowledge in one transaction renders as one expandable History card).
     *  NULL for solo edits. */
    changeSetId: text('change_set_id').$type<ULID | null>(),
    actor: text('actor').notNull().$type<PodAuditActor>(),
    field: text('field').notNull().$type<PodAuditField>(),
    /** Disambiguator for list-shaped fields (knowledge row id, secret env-var
     *  name, mcp server name). NULL for scalar fields. */
    fieldRef: text('field_ref'),
    /** Always NULL for `secret` rows — secrets log event-only. */
    priorValue: text('prior_value'),
    newValue: text('new_value'),
    reason: text('reason'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('agent_audit_agent_idx').on(t.agentId),
    index('agent_audit_change_set_idx').on(t.changeSetId),
  ],
);

/**
 * Section 16b — Paused agent waits.
 *
 * One row per pause event (`pc_ask_orchestrator` / `pc_ask_user` /
 * `pc_request_approval`). `id` = `pendingAskId` minted PC-side per pause.
 * `session_id` is CC's session-id of the paused agent (one session can mint
 * many pending-ask rows across its lifetime). Status enforces the
 * "answer-once" guard against JSONL-replay re-delivery — the orchestrator
 * checks `status === 'waiting'` before calling `pc_answer_pending`.
 *
 * `agent_runs` (analogous tracking for invocations) intentionally NOT added
 * here — `pc_invoke_agent` does not pause, so its runtime state can stay
 * in-memory until the runtime impl in 16b.4 surfaces a persistence need.
 */
export const pendingAsks = sqliteTable(
  'pending_asks',
  {
    /** PC-minted ULID. Returned to the paused agent as the `pendingAskId`
     *  handle + passed by the orchestrator to `pc_answer_pending`. */
    id: text('id').primaryKey().$type<ULID>(),
    /** CC session-id of the paused agent. Used at resume time as
     *  `--resume <sessionId>`. */
    sessionId: text('session_id').notNull(),
    /** Pod-row name (`agents.name`). Joined to the live row at render time
     *  for display; stored denormalised so cancelled rows survive an agent
     *  rename. */
    agentName: text('agent_name').notNull(),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id),
    /** Tracked agent-run that owns this pause, NULL when not associated
     *  with a tracked run (16b.2 ships `pending_asks` without an
     *  `agent_runs` partner — runId is reserved for a future tracked
     *  surface). */
    runId: text('run_id').$type<ULID | null>(),
    /** Work-item the paused agent is operating on (carried from spawn
     *  context). Drives Activity Panel scoping + cross-project bell. */
    parentWorkItemId: text('parent_work_item_id').$type<ULID | null>(),
    kind: text('kind').notNull().$type<PendingAskKind>(),
    question: text('question').notNull(),
    context: text('context'),
    /** Multi-choice options for `approval` (always populated) and optional
     *  for `ask-user`. JSON-encoded list of `{ value, label }`. */
    options: text('options', { mode: 'json' }).$type<PendingAskOption[] | null>(),
    status: text('status').notNull().default('waiting').$type<PendingAskStatus>(),
    answer: text('answer'),
    answeredBy: text('answered_by').$type<'orchestrator' | 'user' | null>(),
    createdAt: integer('created_at').notNull(),
    answeredAt: integer('answered_at'),
    cancelledAt: integer('cancelled_at'),
  },
  (t) => [
    /** List-waiting query is the hot path (orchestrator boot-time "you
     *  have N agents waiting on you" surface + Activity Panel). */
    index('pending_asks_project_status_idx').on(t.projectId, t.status),
    index('pending_asks_session_idx').on(t.sessionId),
    index('pending_asks_work_item_idx').on(t.parentWorkItemId),
  ],
);

/**
 * Section 18 — Hybrid delivery transport (inbox + audit).
 *
 * `agent_inbox` is the durability layer of the hybrid: every agent →
 * orchestrator event lands here as a row before any best-effort channel push.
 * `agent_delivery_audit` is observational — one row per inbox row capturing
 * how the event eventually reached the orchestrator (autonomous channel
 * push wake-up vs UserPromptSubmit-hook prepend on the next user prompt).
 *
 * Inbox rows are drained by two paths:
 * 1. Auto-flush on bridge registration / live channel push — orchestrator
 *    wakes autonomously, row flips `pending → delivered`, audit row
 *    records `driver = 'autonomous'`.
 * 2. UserPromptSubmit hook drain — when channel didn't deliver in time,
 *    the hook prepends pending rows as preamble, marks them delivered,
 *    audit row records `driver = 'user-prompt'`.
 *
 * Cross-row guarantees: status flips are atomic; audit row is written in the
 * same transaction as the inbox status flip so observer queries never see
 * a delivered inbox row without its audit partner.
 */

export const agentInbox = sqliteTable(
  'agent_inbox',
  {
    id: text('id').primaryKey().$type<ULID>(),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id),
    /** CC sessionId of the orchestrator that should receive this event. */
    recipientSessionId: text('recipient_session_id').notNull(),
    eventKind: text('event_kind').notNull().$type<AgentInboxEventKind>(),
    /** Pre-rendered `<channel>...</channel>` body, ready to splice into a
     *  prompt or push via channel. Authored at enqueue time so the drain
     *  paths don't re-render. */
    payloadBody: text('payload_body').notNull(),
    status: text('status').notNull().default('pending').$type<AgentInboxStatus>(),
    createdAt: integer('created_at').notNull(),
    /** null until status flips to `delivered`. */
    deliveredAt: integer('delivered_at'),
  },
  (t) => [
    /** Hot read: "what's pending for this orchestrator session?" — drained
     *  by both auto-flush on bridge register and UserPromptSubmit hook. */
    index('agent_inbox_project_session_status_idx').on(
      t.projectId,
      t.recipientSessionId,
      t.status,
    ),
    /** Ordered drain: rows surface oldest-first for both transports. */
    index('agent_inbox_session_created_idx').on(t.recipientSessionId, t.createdAt),
  ],
);

export const agentDeliveryAudit = sqliteTable(
  'agent_delivery_audit',
  {
    id: text('id').primaryKey().$type<ULID>(),
    inboxId: text('inbox_id')
      .notNull()
      .$type<ULID>()
      .references(() => agentInbox.id),
    /** null when channel push was skipped (e.g. transport disabled via the
     *  emergency kill switch in `PC_DELIVERY_TRANSPORT`). */
    channelPushAttemptedAt: integer('channel_push_attempted_at'),
    /** 0/1 when attempted; null when not attempted. */
    channelPushSucceeded: integer('channel_push_succeeded', { mode: 'boolean' }),
    /** null when channel push delivered autonomously and the hook never had
     *  to drain this row. */
    hookDrainedAt: integer('hook_drained_at'),
    driver: text('driver').notNull().default('unknown').$type<AgentDeliveryDriver>(),
  },
  (t) => [index('agent_delivery_audit_inbox_idx').on(t.inboxId)],
);
