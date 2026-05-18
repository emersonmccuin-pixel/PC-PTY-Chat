import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  FieldSchemaType,
  GlobalSettings,
  NodeOutput,
  ProviderId,
  SessionEndedReason,
  SessionStatus,
  Stage,
  ULID,
  WorkItemHistoryEntry,
  WorkItemStatus,
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
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [uniqueIndex('projects_slug_idx').on(t.slug).where(sql`deleted_at IS NULL`)],
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
