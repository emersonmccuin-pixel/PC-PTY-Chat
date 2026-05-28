// Per-project MCP server. Spawned by each project's claude.exe via its
// .mcp.json. Tools are scoped to PC_PROJECT_ID — set by the per-project config
// at substitution time. All work-item / workflow / worktree calls shim through
// to apps/server's project-scoped HTTP API so dispatch logic stays in one place.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AGENT_MANAGEMENT_TOOLS,
  APPROVE_WORK_ITEM_TOOL,
  ATTACH_TO_WORK_ITEM_TOOL,
  CREATE_AGENT_WORK_ITEM_TOOL,
  CREATE_WORK_ITEM_TOOL,
  GET_WORK_ITEM_TOOL,
  LIST_AGENTS_TOOL,
  LIST_WORK_ITEMS_TOOL,
  MOVE_WORK_ITEM_TOOL,
  REJECT_WORK_ITEM_TOOL,
  UPDATE_WORK_ITEM_TOOL,
  createToolContext,
  handleAgentTool,
  handleWorkItemTool,
} from './tools/index.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// packages/mcp/src/server.ts → trunk root is three levels up. Used as the
// fallback data dir; PC_DATA_DIR override wins.
const ROOT = resolve(__dirname, '..', '..', '..');
const DATA = process.env.PC_DATA_DIR ? resolve(process.env.PC_DATA_DIR) : resolve(ROOT, 'data');
const PROJECT_ID = process.env.PC_PROJECT_ID ?? '';
const SERVER_PORT = Number(process.env.PC_SERVER_PORT ?? 4040);
// Section 22 — set by agent-run-manager for dispatched-agent spawns. Absent
// for orchestrator + agent-designer paths (those set PC_SESSION_ID instead;
// they don't suffer the spawn-time race so we skip the handshake POST).
const AGENT_SESSION_ID = process.env.PC_AGENT_SESSION_ID ?? '';

// Per-project log + heartbeat — keep each project's MCP signals isolated.
const PROJECT_DATA = PROJECT_ID ? resolve(DATA, 'projects', PROJECT_ID) : DATA;
const LOG = resolve(PROJECT_DATA, 'mcp-log.jsonl');
const STATUS = resolve(PROJECT_DATA, 'mcp-status.json');

/** Section 36 — derived export consumed by apps/server's
 *  `pod-tool-catalog.ts` for `mcp__pc-rig__*` wildcard expansion. Replaces
 *  the hand-maintained flat array that previously had to be kept in sync
 *  with TOOLS (the catalog-drift trap). `TOOLS` below is the sole source. */
export const TOOLS = [
  {
    name: 'pc_log',
    description:
      'Append a line to data/mcp-log.jsonl. Use when the user asks you to log via MCP.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'message body to append' },
      },
      required: ['message'],
    },
  },
  {
    name: 'pc_create_worktree',
    description:
      'Create a git worktree as a sibling of the workspace dir. Branch name = worktree name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'worktree + branch name (alnum, dash, dot, underscore only)',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'pc_list_worktrees',
    description: 'List all git worktrees attached to the workspace repo.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pc_destroy_worktree',
    description:
      'Remove a worktree. Pass either an absolute path or the bare name (resolved under ../worktrees/).',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'worktree name or absolute path' },
        force: { type: 'boolean', description: 'pass --force to git worktree remove' },
      },
      required: ['target'],
    },
  },
  CREATE_WORK_ITEM_TOOL,
  CREATE_AGENT_WORK_ITEM_TOOL,
  APPROVE_WORK_ITEM_TOOL,
  REJECT_WORK_ITEM_TOOL,
  {
    name: 'pc_create_quick_task',
    description:
      "Capture an atomic todo on the pinned cross-project Quick Tasks surface. Use for 'remember to ping Pat', 'review John's PTO', 'renew the domain Friday' — short, user-facing tasks that aren't worth a full work item on a regular project. Lands in the Quick Tasks project's intake stage. `taggedProjectId` is optional: pass the current project's id when the task obviously belongs to it (the user sees a 'tagged HR Ops' chip on the row); omit for personal/no-project tasks. NOT for agent contracts — quick tasks aren't dispatched, they're done by the human. Use pc_create_agent_work_item for agent-bound work.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'short scannable title' },
        body: { type: 'string', description: 'optional free-form notes / context' },
        taggedProjectId: {
          type: 'string',
          description:
            "optional project id (ULID) the task belongs to. Soft pointer; not a hard FK. Omit / null for untagged.",
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'pc_list_quick_tasks',
    description:
      "List quick tasks. Filters: `status` ('open' default | 'complete' | 'all'), `taggedProjectId` (ULID for matching; empty string for untagged-only; omit for any). Returns the array of WorkItems in (position, createdAt) order.",
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['open', 'complete', 'all'],
          description: "default 'open' (pending + in-progress).",
        },
        taggedProjectId: {
          type: 'string',
          description: "filter by tag. ULID matches that project; empty string filters to untagged-only; omit for any.",
        },
        dueBefore: {
          type: 'string',
          description: "ISO date string; matches rows whose `fields.dueDate` is on or before that date.",
        },
      },
    },
  },
  {
    name: 'pc_list_quick_tasks_for_project',
    description:
      "List the quick tasks tagged to a given project. Lets the orchestrator answer 'what quick tasks do I have for this project?'. Returns the array of WorkItems (in Quick Tasks project) whose `taggedProjectId` matches.",
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'project id (ULID) whose tagged quick tasks to fetch.' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'pc_log_bug',
    description:
      "File a bug in the user's Caisson dogfood tracker, no matter which project this chat is bound to. Reads the target project id from GlobalSettings.bugLogTargetProjectId; if unset, returns an error telling the user to configure 'Bug log target' in App Settings. The new work item is created with type='bug', dropped into the target project's FIRST stage, and the body is prefixed with 'Logged from project: <source-name> · session: <id>' so the bug carries its origin context. Use whenever the user says something like 'log a bug', 'log this as a bug', 'file a bug report', or otherwise reports a defect they want tracked.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'short, scannable bug title' },
        description: {
          type: 'string',
          description: 'free-form bug description (steps, expected, actual, anything useful). Optional but strongly recommended.',
        },
      },
      required: ['title'],
    },
  },
  MOVE_WORK_ITEM_TOOL,
  UPDATE_WORK_ITEM_TOOL,
  // 19.17 removed `pc_complete_node`, `pc_node_failed`, and `pc_run_workflow`.
  // `pc_complete_node` was re-added in 19.17b as the orchestrator-review
  // decision tool (see ~:707 below). `pc_fire_workflow` (formerly
  // `pc_run_workflow`) was also re-added in 19.17b (see ~:688 below).
  // `pc_node_failed` is re-registered here by the Batch-A tool-audit
  // remediation — the spawner already watches the JSONL for it to mark nodes
  // as agent-self-failed; the tool was never re-added after 19.17, making it
  // a phantom grant. It now lives at ~:734 below.
  ...AGENT_MANAGEMENT_TOOLS,
  GET_WORK_ITEM_TOOL,
  LIST_WORK_ITEMS_TOOL,
  // 19.17 removed `pc_update_workflow_draft` (its handler pointed at a dead
  // v1 route). 19.23 added `pc_create_workflow` and `pc_update_workflow` as
  // live v2 tools (see ~:741/:765 below) — they are NOT removed. The original
  // 19.23 comment here incorrectly said they were pruned; corrected by the
  // Batch-A tool-audit remediation.
  {
    name: 'pc_save_workflow_draft',
    description:
      'Section 19.9 — push an in-progress draft of the v2 workflow currently being authored in the workflow-builder modal. Use this after each meaningful structural change (node added, edge wired, trigger set, position dragged) so the visualizer renders the workflow forming. The draft is NOT written to disk — only `pc_publish_workflow` does that. Server keys the draft by the transient PC_SESSION_ID env var (already set by the host); state clears automatically when the workflow-builder session ends. Drafts can be incomplete (missing nodes / wires) — they only need a top-level `id`. 400 on shape errors.',
    inputSchema: {
      type: 'object',
      properties: {
        def: {
          type: 'object',
          description: 'in-progress v2 workflow object: { id, name, triggers?, nodes: [...], ... }',
          additionalProperties: true,
        },
      },
      required: ['def'],
    },
  },
  {
    name: 'pc_read_workflow_draft',
    description:
      'Section 19.9 — read the current v2 workflow-builder draft for this session. Use this at the start of edit-mode, or any time you suspect the user has dragged nodes / wired edges in the visualizer since your last `pc_save_workflow_draft` write (sync-model-A — the user can edit the graph between your turns). Returns { ok: true, def: <current draft or null> } if a draft exists; { ok: true, def: null } if none. PC_SESSION_ID env is the implicit scope.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pc_get_stages',
    description:
      'Section 19.9 — list the project\'s stages live from the server. Use this BEFORE asking the user which stage should trigger a v2 workflow (`stage-on-entry` trigger). Returns { ok: true, stages: [{ id, name, order, isDone?, isCancelled?, isNew? }, ...] }. Stage `id` is what goes into `triggers[].stage` — never use the name. Use the flags for semantic roles. (Equivalent to `pc_list_stages`; kept under the locked Section 19 name.)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pc_publish_workflow',
    description:
      'Section 19.17 — publish the v2 workflow to the DB-backed `/api/workflows` surface. Validates the graph (cycles, unknown node ids, `when:` grammar, trigger shape, ref integrity), upserts the row (GET → match by slug → PUT or POST), and broadcasts `workflow-changed` so the Workflows tab refreshes. Returns 201 on first-write, 200 on overwrite. 400 on validation errors with per-path `errors:` array — translate to plain English and re-publish after fixing.',
    inputSchema: {
      type: 'object',
      properties: {
        def: {
          type: 'object',
          description: 'v2 workflow object: { id, name, triggers: [...], nodes: [...], description?, worktree?, max_concurrency? }',
          additionalProperties: true,
        },
      },
      required: ['def'],
    },
  },
  {
    name: 'pc_write_claude_md',
    description:
      'Write the project-level CLAUDE.md from the conversational setup wizard (5.6 / D82). Overwrites the existing file. Use this as the SINGLE tool call at the end of the wizard interview, once the user confirms the preview. `content` is the full markdown body (the server does not interpolate). 400 if content is missing or empty. Broadcasts project-claude-md-changed on success so the modal can close.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'full CLAUDE.md markdown body (non-empty)',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'pc_list_stages',
    description:
      'List the project\'s stages live from the server. Use this BEFORE asking the user which stage should trigger a workflow (or which stage a create/update-work-item step should target). Returns { ok: true, stages: [{ id, name, order, isDone?, isCancelled?, isNew? }, ...] }. Stage `id` is what goes into `triggers.on_enter.stage_id` — never use the name. Use `isDone` / `isCancelled` / `isNew` for semantic stage roles instead of guessing from labels. No arguments; PC_PROJECT_ID env is the implicit scope.',
    inputSchema: { type: 'object', properties: {} },
  },
  LIST_AGENTS_TOOL,
  {
    name: 'pc_list_workflows',
    description:
      'List workflows already authored in this project. Use this BEFORE asking the user which child workflow a nested `workflow:` step should call. Returns { valid: [{ id, fileName, ... }], invalid: [...] }; the `id` field is what goes into a nested-workflow step\'s `workflow:` field. No arguments; PC_PROJECT_ID env is the implicit scope.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pc_fire_workflow',
    description:
      'Fire a workflow by slug (the `id:` field, e.g. "triage") or DB ULID. Resolves the row, dispatches through the v2 executor, and returns the runId + rootWorkItemId. Use this when the user explicitly names a workflow ("run the triage workflow"). Trigger defaults to `{ kind: "manual" }`. Returns { ok: true, runId, rootWorkItemId } on success; 400 on disabled / invalid rows; 404 on unknown slug. PC_PROJECT_ID env is the implicit project scope.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: {
          type: 'string',
          description: 'workflow slug (preferred — the `id:` field in the YAML) or DB ULID',
        },
        trigger: {
          type: 'object',
          description: 'optional trigger payload. Defaults to { kind: "manual" }. For stage-on-entry, supply { kind: "stage-on-entry", stage: "<stageId>" } — but typically you fire manually.',
        },
      },
      required: ['workflow'],
    },
  },
  {
    name: 'pc_complete_node',
    description:
      'Submit an orchestrator-review decision for a workflow run paused at a review node. Use when a `kind=orchestrator-review` envelope lands in chat with `{ workflowRunId, nodeId }` and you have judged the artifact. `decision: "approve"` resumes the run; `decision: "reject"` kicks back upstream (the reject loop re-fires the prior agent with your `notes` as feedback, up to `max_iterations`). Returns { ok: true, status: <new run status> } or 404 if the run / node is unknown / no longer paused. PC_PROJECT_ID env is the implicit project scope.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowRunId: {
          type: 'string',
          description: 'the run id from the orchestrator-review envelope',
        },
        nodeId: {
          type: 'string',
          description: 'the review node id from the envelope',
        },
        decision: {
          type: 'string',
          enum: ['approve', 'reject'],
          description: 'approve resumes; reject kicks back upstream with notes as feedback',
        },
        notes: {
          type: 'string',
          description: 'optional — required in practice for reject so the upstream agent has feedback',
        },
      },
      required: ['workflowRunId', 'nodeId', 'decision'],
    },
  },
  {
    name: 'pc_node_failed',
    description:
      'Signal a hard failure from a workflow agent node. Call this when you cannot produce the contracted output (bad input, missing files, unrecoverable error). The v2 subagent spawner detects this call from the JSONL transcript and closes the node as `agent-self-failed` carrying your reason. After calling, end your turn normally — do NOT call this from ad-hoc (non-workflow) dispatch. Schema: { workflowRunId, nodeId, reason }.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowRunId: {
          type: 'string',
          description: 'the workflow run id from the dispatch tokens',
        },
        nodeId: {
          type: 'string',
          description: 'the node id from the dispatch tokens',
        },
        reason: {
          type: 'string',
          description: 'one-line human-readable reason surfaced in the UI',
        },
      },
      required: ['workflowRunId', 'nodeId', 'reason'],
    },
  },
  {
    name: 'pc_list_field_schemas',
    description:
      'List the project\'s custom work-item field schemas. Use this BEFORE authoring a create-work-item / update-work-item step that sets `fields`, so the keys are real (not invented). Returns { ok: true, schemas: [{ key, label, type, options?, required, ... }, ...] }. The `key` is what goes into the step\'s `fields` object. No arguments; PC_PROJECT_ID env is the implicit scope.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pc_create_workflow',
    description:
      'Create a new workflow in this project. Body: { yaml?, def?, scope? }. `scope` defaults to "project" (PC_PROJECT_ID is the implicit owner). Either `yaml` (raw YAML string) or `def` (workflow graph object) is required. Returns the created workflow row including `status` and `parseError` so the caller sees invalid-YAML feedback immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        yaml: {
          type: 'string',
          description: 'raw YAML workflow definition (preferred for plain-text authoring)',
        },
        def: {
          type: 'object',
          description: 'workflow graph object (alternative to yaml)',
          additionalProperties: true,
        },
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description: 'default "project" — owned by PC_PROJECT_ID. Pass "global" only when the workflow should be reusable across every project.',
        },
      },
    },
  },
  {
    name: 'pc_update_workflow',
    description:
      'Update an existing workflow by DB id (ULID). Pass `yaml` or `def` to replace the definition; omit both to patch metadata only (`disabled`, display name). Slug is immutable — rename by duplicate + delete. Returns the updated row including `status` / `parseError` so the caller sees feedback on invalid definitions.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'workflow DB ULID' },
        yaml: { type: 'string', description: 'new YAML definition' },
        def: {
          type: 'object',
          description: 'new workflow graph object',
          additionalProperties: true,
        },
        disabled: {
          type: 'boolean',
          description: 'when true the workflow is disabled (will not fire)',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'pc_delete_workflow',
    description:
      'Soft-delete a workflow by DB id (ULID). Returns 409 when in-flight runs exist unless `cancel: true` is passed (cancels them first). Use `pc_list_workflows` to find the id; prefer `pc_get_workflow` to read-before-delete.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'workflow DB ULID' },
        cancel: {
          type: 'boolean',
          description: 'cancel in-flight runs before deleting (appends ?cancel=1 to the request)',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'pc_get_workflow',
    description:
      'Fetch the full workflow row by DB id (ULID), including the yaml text. Use this to read-before-edit so you don\'t clobber unknown fields. Returns { ok: true, workflow: { id, slug, yaml, status, parseError, ... } } or 404.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'workflow DB ULID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'pc_replace_stages',
    description:
      'Bulk-replace a project\'s stages. The server validates uniqueness, flag constraints, and in-use stage safety. When a removed stage still has work items, the server returns 409 STAGE_HAS_ITEMS with an `orphans` array — surface this to the caller instead of swallowing. Pass `force: true` + `fallbackStageId` (a retained stage id) to force-remove and reassign orphaned items. Always call `pc_request_approval` before removing, reordering, or re-flagging stages.',
    inputSchema: {
      type: 'object',
      properties: {
        stages: {
          type: 'array',
          description: 'full replacement stage list. Each stage needs id + name; order defaults to array index.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'stage slug id (e.g. "backlog")' },
              name: { type: 'string', description: 'display name' },
              order: { type: 'number', description: 'sort order (defaults to array index)' },
              isDone: { type: 'boolean', description: 'marks the terminal-success stage (at most one)' },
              isCancelled: { type: 'boolean', description: 'marks the terminal-abandon stage (at most one)' },
              isNew: { type: 'boolean', description: 'marks the intake/new stage (at most one)' },
            },
            required: ['id', 'name'],
          },
        },
        force: {
          type: 'boolean',
          description: 'force removal of stages that still have items. Requires fallbackStageId.',
        },
        fallbackStageId: {
          type: 'string',
          description: 'stage id to reassign orphaned items to when force=true.',
        },
      },
      required: ['stages'],
    },
  },
  {
    name: 'pc_replace_field_schemas',
    description:
      'Bulk-replace a project\'s custom work-item field schemas. PUT /api/projects/:projectId/field-schemas. Returns { ok: true, items: [...] }. Call pc_list_field_schemas first to read current state before replacing. Always call pc_request_approval before replacing schemas.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'full replacement field schema list. Each item: { key, label, type, options?, required? }.',
          items: {
            type: 'object',
            additionalProperties: true,
          },
        },
      },
      required: ['items'],
    },
  },
  ATTACH_TO_WORK_ITEM_TOOL,
  {
    name: 'pc_invoke_agent',
    description:
      "Dispatch a named agent (kebab-case, e.g. \"researcher\") in this project. Always async — returns `{ ok, mode: 'async', sessionId, runId, agentName, startedAt, status }` immediately. The terminal `agent-completed` / `agent-failed` channel event lands on your next turn (handler protocol entries #4 + #5). For any non-trivial dispatch, call `pc_create_agent_work_item` first and pass the returned id as `workItemId` — the agent then knows its task, expected output, and acceptance criteria via the work item rather than a sprawling input string (keep `input` to \"Begin.\" or a one-liner pointer). Optional `parentWorkItemId` pins the child to a parent work-item for lineage — defaults to `PC_AGENT_PARENT_WORK_ITEM_ID` when called from inside another agent. The project route URL is derived from `PC_PROJECT_ID`.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'pod name (kebab-case)' },
        input: {
          type: 'string',
          description:
            "free-form input — becomes the child's first user message. When you also pass workItemId, keep this trivial (\"Begin.\" or shorter); the agent reads its task from the work item, not from here.",
        },
        workItemId: {
          type: 'string',
          description:
            'work-item ULID this dispatch is assigned to. The agent fetches it via pc_get_work_item as its first action and reads body / acceptance_criteria / attachments from there. Create via pc_create_agent_work_item.',
        },
        parentWorkItemId: {
          type: 'string',
          description:
            'optional parent work-item ULID for lineage (not the assignment — that is `workItemId`); defaults to PC_AGENT_PARENT_WORK_ITEM_ID',
        },
      },
      required: ['name', 'input'],
    },
  },
  {
    name: 'pc_continue_agent',
    description:
      "Resume a recent terminal agent run (`completed` or `failed`) with a follow-up input by spawning via `--resume <ccSessionId>` — the prior conversation is preserved so phrase your input as a continuation, not a fresh ask. Cancelled runs cannot be continued; start a fresh dispatch. Single-active-continuation guard per parent (409 on concurrent). JSONL retention guard (410 on session-expired). Optional `workItemId` re-anchors the resumed run to a (possibly different) work-item contract; omit to carry the parent run's assignment forward. Returns the same shape as `pc_invoke_agent`.",
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'ULID of the prior AgentRun to continue' },
        input: {
          type: 'string',
          description:
            "free-form follow-up — becomes the next user message in the resumed conversation. Phrase as a continuation, not a fresh request.",
        },
        workItemId: {
          type: 'string',
          description:
            'optional work-item ULID. Omitted = inherit the parent run\'s assignment. Supply when the follow-up swaps in a new contract (rare).',
        },
      },
      required: ['runId', 'input'],
    },
  },
  {
    name: 'pc_list_my_runs',
    description:
      "List recent agent runs YOU dispatched in this project (scoped to caller's `pc_session_id`). Use when you've lost track of a runId and need to pick one to continue via `pc_continue_agent`. Filters: `agentName`, `status`, `limit` (default 20, max 100). Newest-first. Row shape: `{ runId, agentName, status, dispatchedAt, completedAt, summary, continues }`.",
    inputSchema: {
      type: 'object',
      properties: {
        agentName: {
          type: 'string',
          description: 'optional — filter by pod name (kebab-case)',
        },
        status: {
          type: 'string',
          enum: ['queued', 'spawning', 'running', 'paused', 'completed', 'failed', 'cancelled'],
          description:
            'optional — filter by persisted status (full state machine).',
        },
        limit: {
          type: 'number',
          description: 'optional — cap on returned rows. Default 20, max 100.',
        },
      },
      required: [],
    },
  },
  {
    name: 'pc_ask_orchestrator',
    description:
      "Pause your run and ask the dispatcher a question. Returns `{ ok, pendingAskId, status: 'waiting' }` immediately; the answer arrives as the next user message when your session resumes via --resume. After calling, do not call any other tools and end your turn naturally. Requires `PC_AGENT_RUN_ID` + `PC_DISPATCHER_SESSION_ID` in env (set by the spawn path).",
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'the question to ask the orchestrator' },
        context: {
          type: 'string',
          description:
            'optional context — recent transcript snippet, files inspected, candidate options',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'pc_ask_user',
    description:
      "Pause your run and route a question to the user via the orchestrator-as-proxy. Returns `{ ok, pendingAskId, status: 'waiting' }` immediately; the answer arrives as the next user message when your session resumes. After calling, do not call any other tools and end your turn naturally. Use this when the question genuinely needs the human; use `pc_ask_orchestrator` first if the orchestrator might know from project context. Multi-choice `options` array supported.",
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'the question to surface to the user' },
        context: {
          type: 'string',
          description: 'optional context — what you tried, why you need the user',
        },
        options: {
          type: 'array',
          description:
            'optional multi-choice options ([{value, label}, ...]). When supplied, the orchestrator renders them as a numbered list; the user reply will be one of the option values.',
          items: {
            type: 'object',
            properties: {
              value: { type: 'string', description: 'machine value returned as the answer' },
              label: { type: 'string', description: 'user-facing label for this choice' },
            },
            required: ['value', 'label'],
          },
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'pc_request_approval',
    description:
      "Pause your run and request explicit human approval for a decision. Returns `{ ok, pendingAskId, status: 'waiting' }` immediately; the user's decision arrives as the next user message when your session resumes. Use this when proceeding requires explicit go/no-go (destructive operations, irreversible writes). `options` is required and must be non-empty.",
    inputSchema: {
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          description:
            'the decision the user is being asked to approve — what will happen, in plain English',
        },
        options: {
          type: 'array',
          description: 'non-empty list of approval choices ([{value, label}, ...])',
          items: {
            type: 'object',
            properties: {
              value: { type: 'string', description: 'machine value returned as the answer' },
              label: { type: 'string', description: 'user-facing label for this choice' },
            },
            required: ['value', 'label'],
          },
        },
        context: {
          type: 'string',
          description:
            'optional context — what produced this decision, alternatives, what the user should weigh',
        },
      },
      required: ['decision', 'options'],
    },
  },
  {
    name: 'pc_answer_pending',
    description:
      'Resume a paused agent with an answer. Atomic open→answered flip. Idempotent: a second call returns `cause: "already-answered"`. Pod-revision drift (pod edited between dispatch and resume) surfaces in the response as `podRevisionDrifted: true`. Orchestrator usage only — agents that need to forward an answer should use pc_ask_orchestrator instead.',
    inputSchema: {
      type: 'object',
      properties: {
        pendingAskId: { type: 'string', description: 'pending-ask ULID from the agent-asks-* event' },
        answer: { type: 'string', description: 'the answer to thread back into the paused agent' },
        answeredBy: {
          type: 'string',
          enum: ['orchestrator', 'user'],
          description:
            '"orchestrator" when answered from your own context, "user" when forwarding the user\'s reply',
        },
      },
      required: ['pendingAskId', 'answer', 'answeredBy'],
    },
  },
] as const;

/** Section 36 — fully-qualified slugs consumed by apps/server's
 *  `mcp__pc-rig__*` wildcard expansion. Derived from TOOLS so the two can
 *  never drift; the previous hand-maintained flat array (and its drift test)
 *  are deleted. The `mcp__pc-rig__` prefix is the MCP server name Caisson scaffolds
 *  into every project's .mcp.json — keep it in sync if the server gets
 *  renamed. */
export const PC_RIG_TOOL_NAMES: readonly string[] = TOOLS.map(
  (t) => `mcp__pc-rig__${t.name}` as const,
);

const toolContext = createToolContext({
  projectId: PROJECT_ID,
  agentSessionId: AGENT_SESSION_ID,
  sessionId: process.env.PC_SESSION_ID ?? '',
  dispatcherSessionId: process.env.PC_SESSION_ID || process.env.PC_DISPATCHER_SESSION_ID || '',
  serverPort: SERVER_PORT,
});

const {
  deleteServer,
  getServer,
  patchServer,
  postServer,
  projectPath,
  putServer,
  withRichLinkHint,
} = toolContext;

interface McpStage {
  id: string;
  name: string;
  order: number;
  isDone?: boolean;
  isCancelled?: boolean;
  isNew?: boolean;
}

interface ProjectStagesResponse {
  stages?: McpStage[];
}

function stageForMcp(s: McpStage): {
  id: string;
  name: string;
  order: number;
  isDone?: true;
  isCancelled?: true;
  isNew?: true;
} {
  return {
    id: s.id,
    name: s.name,
    order: s.order,
    ...(s.isDone === true ? { isDone: true } : {}),
    ...(s.isCancelled === true ? { isCancelled: true } : {}),
    ...(s.isNew === true ? { isNew: true } : {}),
  };
}

function writeStatus() {
  try {
    mkdirSync(DATA, { recursive: true });
    writeFileSync(
      STATUS,
      JSON.stringify(
        {
          pid: process.pid,
          startedAt: new Date().toISOString(),
          aliveAt: new Date().toISOString(),
          tools: TOOLS.map((t) => t.name),
          toolCount: TOOLS.length,
        },
        null,
        2,
      ),
    );
  } catch {
    /* status file is best-effort */
  }
}

function heartbeat() {
  try {
    mkdirSync(DATA, { recursive: true });
    writeFileSync(
      STATUS,
      JSON.stringify(
        {
          pid: process.pid,
          aliveAt: new Date().toISOString(),
          tools: TOOLS.map((t) => t.name),
          toolCount: TOOLS.length,
        },
        null,
        2,
      ),
    );
  } catch {
    /* best-effort */
  }
}

const server = new Server(
  { name: 'pc-rig', version: '0.0.0' },
  { capabilities: { tools: {} } },
);

// Section 22 — fire when CC's MCP client finishes the JSON-RPC handshake
// (the `initialized` notification, last step before tools are safely
// callable). Lets agent-run-manager gate its programmatic spawn-time
// warmup-send on the real handshake-complete signal rather than the
// banner-render `state: 'ready'` (which fires before MCP is connected
// and used to drop the warmup's Enter under concurrent spawn). Dispatched-
// agent path only — orchestrator + agent-designer don't suffer the race.
// Fire-once guard at the AbortController level: pc-rig is a fresh process
// per spawn, so oninitialized should only ever fire once anyway, but
// defense-in-depth.
let handshakeNotified = false;
server.oninitialized = () => {
  if (handshakeNotified) return;
  if (!PROJECT_ID || !AGENT_SESSION_ID) return;
  handshakeNotified = true;
  const payload = JSON.stringify({
    projectId: PROJECT_ID,
    agentSessionId: AGENT_SESSION_ID,
  });
  const req = httpRequest({
    host: '127.0.0.1',
    port: SERVER_PORT,
    method: 'POST',
    path: '/api/internal/mcp-handshake',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  });
  // Fire-and-forget. Failure is non-fatal — agent-run-manager's timeout
  // fallback catches us if this POST never lands.
  req.on('error', () => { /* best-effort */ });
  req.write(payload);
  req.end();
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS as unknown as typeof TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  const workItemResult = await handleWorkItemTool(req.params.name, args, toolContext);
  if (workItemResult) return workItemResult;
  const agentResult = await handleAgentTool(req.params.name, args, toolContext);
  if (agentResult) return agentResult;

  switch (req.params.name) {
    case 'pc_log': {
      const message = typeof args.message === 'string' ? args.message : String(args.message ?? '');
      try {
        mkdirSync(dirname(LOG), { recursive: true });
        appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), message }) + '\n');
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_log failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: `logged: ${message}` }] };
    }

    case 'pc_create_worktree': {
      const name = typeof args.name === 'string' ? args.name : '';
      if (!name) {
        return { content: [{ type: 'text', text: 'pc_create_worktree: name required' }], isError: true };
      }
      try {
        const res = await postServer(projectPath('worktrees/create'), { name });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_create_worktree failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_create_worktree failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_list_worktrees': {
      try {
        const res = await getServer(projectPath('worktrees'));
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_list_worktrees failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_list_worktrees failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_create_quick_task': {
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      const taskBody = typeof args.body === 'string' ? args.body : undefined;
      const taggedProjectId =
        typeof args.taggedProjectId === 'string' && args.taggedProjectId.length > 0
          ? args.taggedProjectId
          : null;
      if (!title) {
        return {
          content: [{ type: 'text', text: 'pc_create_quick_task: title required' }],
          isError: true,
        };
      }
      try {
        const res = await postServer('/api/quick-tasks', {
          title,
          ...(taskBody !== undefined ? { body: taskBody } : {}),
          taggedProjectId,
        });
        if (res.status < 200 || res.status >= 300) {
          return {
            content: [{ type: 'text', text: `pc_create_quick_task failed (${res.status}): ${res.body}` }],
            isError: true,
          };
        }
        const parsed = JSON.parse(res.body) as { ok?: boolean; workItem?: { id?: string; title?: string; callsign?: string | null } };
        const id = parsed.workItem?.id ?? '?';
        const callsign = parsed.workItem?.callsign ?? null;
        const tagSuffix = taggedProjectId ? `, tagged ${taggedProjectId}` : ', untagged';
        const idDisplay = callsign ? `${callsign} (${id})` : id;
        return withRichLinkHint(
          `Added to Quick Tasks (id: ${idDisplay}${tagSuffix}). Title: ${title}`,
        );
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_create_quick_task failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_list_quick_tasks': {
      const params: string[] = [];
      if (typeof args.status === 'string') params.push(`status=${encodeURIComponent(args.status)}`);
      if (typeof args.taggedProjectId === 'string')
        params.push(`taggedProjectId=${encodeURIComponent(args.taggedProjectId)}`);
      if (typeof args.dueBefore === 'string') params.push(`dueBefore=${encodeURIComponent(args.dueBefore)}`);
      const qs = params.length > 0 ? `?${params.join('&')}` : '';
      try {
        const res = await getServer(`/api/quick-tasks/list${qs}`);
        if (res.status < 200 || res.status >= 300) {
          return {
            content: [{ type: 'text', text: `pc_list_quick_tasks failed (${res.status}): ${res.body}` }],
            isError: true,
          };
        }
        return withRichLinkHint(res.body);
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_list_quick_tasks failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_list_quick_tasks_for_project': {
      const projectId = typeof args.projectId === 'string' ? args.projectId.trim() : '';
      if (!projectId) {
        return {
          content: [{ type: 'text', text: 'pc_list_quick_tasks_for_project: projectId required' }],
          isError: true,
        };
      }
      try {
        const res = await getServer(`/api/quick-tasks/for-project/${encodeURIComponent(projectId)}`);
        if (res.status < 200 || res.status >= 300) {
          return {
            content: [
              { type: 'text', text: `pc_list_quick_tasks_for_project failed (${res.status}): ${res.body}` },
            ],
            isError: true,
          };
        }
        return withRichLinkHint(res.body);
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_list_quick_tasks_for_project failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_log_bug': {
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      const description = typeof args.description === 'string' ? args.description : '';
      if (!title) {
        return { content: [{ type: 'text', text: 'pc_log_bug: title required' }], isError: true };
      }
      try {
        const settingsRes = await getServer('/api/settings');
        if (settingsRes.status < 200 || settingsRes.status >= 300) {
          return {
            content: [
              { type: 'text', text: `pc_log_bug: failed to read settings (${settingsRes.status}): ${settingsRes.body}` },
            ],
            isError: true,
          };
        }
        const settingsParsed = JSON.parse(settingsRes.body) as {
          settings?: { bugLogTargetProjectId?: string | null };
        };
        const targetId = settingsParsed.settings?.bugLogTargetProjectId ?? null;
        if (!targetId) {
          return {
            content: [
              {
                type: 'text',
                text: 'pc_log_bug: no bug-log target configured. Open App Settings → "Bug log target" and pick the project where bugs should land.',
              },
            ],
            isError: true,
          };
        }

        const targetRes = await getServer(`/api/projects/${targetId}`);
        if (targetRes.status < 200 || targetRes.status >= 300) {
          return {
            content: [
              { type: 'text', text: `pc_log_bug: target project unreachable (${targetRes.status}): ${targetRes.body}` },
            ],
            isError: true,
          };
        }
        const target = JSON.parse(targetRes.body) as {
          name?: string;
          stages?: Array<{ id: string; order?: number; isNew?: boolean }>;
        };
        const stages = (target.stages ?? []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        // Section 27 — prefer the project's is_new stage if one exists.
        // Falls back to stages[0] (today's behavior) when no stage carries the flag.
        const intakeStage = stages.find((s) => s.isNew)?.id ?? stages[0]?.id;
        if (!intakeStage) {
          return {
            content: [
              { type: 'text', text: `pc_log_bug: target project '${target.name ?? targetId}' has no stages defined.` },
            ],
            isError: true,
          };
        }

        let sourceName = PROJECT_ID;
        if (PROJECT_ID) {
          const sourceRes = await getServer(`/api/projects/${PROJECT_ID}`);
          if (sourceRes.status >= 200 && sourceRes.status < 300) {
            try {
              const source = JSON.parse(sourceRes.body) as { name?: string };
              if (source.name) sourceName = source.name;
            } catch {
              /* fall back to id */
            }
          }
        }

        const sessionId = process.env.PC_SESSION_ID ?? '';
        const prefixParts = [`Logged from project: ${sourceName}`];
        if (sessionId) prefixParts.push(`session: ${sessionId}`);
        const prefix = prefixParts.join(' · ');
        const body = description.trim() ? `${prefix}\n\n${description}` : prefix;

        const createRes = await postServer(`/api/projects/${targetId}/work-items/create`, {
          title,
          stageId: intakeStage,
          body,
          type: 'bug',
        });
        if (createRes.status < 200 || createRes.status >= 300) {
          return {
            content: [
              { type: 'text', text: `pc_log_bug failed (${createRes.status}): ${createRes.body}` },
            ],
            isError: true,
          };
        }
        const parsed = JSON.parse(createRes.body) as { ok?: boolean; workItem?: { id?: string; callsign?: string | null } };
        const newId = parsed.workItem?.id ?? '?';
        const callsign = parsed.workItem?.callsign ?? null;
        const idDisplay = callsign ? `${callsign} (${newId})` : newId;
        return withRichLinkHint(
          `Bug filed in ${target.name ?? targetId} (id: ${idDisplay}, stage: ${intakeStage}). Body: ${prefix}`,
        );
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_log_bug failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    // 19.17 removed pc_node_failed. Re-registered in Batch A of the
    // tool-audit remediation: the spawner already watches for this call in
    // JSONL to mark nodes as agent-self-failed; re-registering makes the
    // tool visible to CC so the model can actually emit it.

    case 'pc_node_failed': {
      const runId = typeof args.workflowRunId === 'string' ? args.workflowRunId.trim() : '';
      const nodeId = typeof args.nodeId === 'string' ? args.nodeId.trim() : '';
      const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
      if (!runId || !nodeId || !reason) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_node_failed: require { workflowRunId, nodeId, reason }',
            },
          ],
          isError: true,
        };
      }
      // The v2 subagent spawner (subagent-spawner.ts) reads this call from
      // the JSONL transcript and closes the node as agent-self-failed with
      // the given reason. This handler just acknowledges so the agent knows
      // the signal was sent; after this call the agent should end its turn.
      return {
        content: [
          {
            type: 'text',
            text: `node failure signal registered for node ${nodeId} (run ${runId}): ${reason}`,
          },
        ],
      };
    }

    case 'pc_destroy_worktree': {
      const target = typeof args.target === 'string' ? args.target : '';
      const force = args.force === true;
      if (!target) {
        return { content: [{ type: 'text', text: 'pc_destroy_worktree: target required' }], isError: true };
      }
      try {
        const res = await postServer(projectPath('worktrees/destroy'), { target, force });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: `destroyed worktree ${target}` }] };
        }
        return {
          content: [{ type: 'text', text: `pc_destroy_worktree failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_destroy_worktree failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    // 19.23 — `pc_create_workflow` + `pc_edit_workflow` cases removed; both
    // were routed at the dead `/api/projects/:projectId/workflows` surface.
    // v2 publish goes through `pc_publish_workflow`. `pc_update_workflow_draft`
    // was already removed in 19.17 for the same reason.

    case 'pc_save_workflow_draft': {
      const def = args.def && typeof args.def === 'object' ? args.def : null;
      if (!def) {
        return {
          content: [{ type: 'text', text: 'pc_save_workflow_draft: def required' }],
          isError: true,
        };
      }
      const sessionId = process.env.PC_SESSION_ID ?? '';
      if (!sessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_save_workflow_draft: PC_SESSION_ID env not set (transient workflow-builder session is the only valid caller)',
            },
          ],
          isError: true,
        };
      }
      try {
        const res = await postServer(projectPath('workflow-builder/draft'), { sessionId, def });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_save_workflow_draft failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_save_workflow_draft failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_read_workflow_draft': {
      const sessionId = process.env.PC_SESSION_ID ?? '';
      if (!sessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_read_workflow_draft: PC_SESSION_ID env not set (transient workflow-builder session is the only valid caller)',
            },
          ],
          isError: true,
        };
      }
      try {
        const res = await getServer(
          projectPath(`workflow-builder/draft/${encodeURIComponent(sessionId)}`),
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_read_workflow_draft failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_read_workflow_draft failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_get_stages': {
      // Same shape as pc_list_stages (kept under the locked Section 19 name).
      try {
        if (!PROJECT_ID) throw new Error('PC_PROJECT_ID required');
        const res = await getServer(`/api/projects/${PROJECT_ID}`);
        if (res.status >= 200 && res.status < 300) {
          try {
            const project = JSON.parse(res.body) as ProjectStagesResponse;
            const stages = (project.stages ?? []).map(stageForMcp);
            return { content: [{ type: 'text', text: JSON.stringify({ ok: true, stages }) }] };
          } catch {
            return { content: [{ type: 'text', text: `pc_get_stages parse error: ${res.body.slice(0, 200)}` }], isError: true };
          }
        }
        return {
          content: [{ type: 'text', text: `pc_get_stages failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_get_stages failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_publish_workflow': {
      // 19.17 — DB-backed publish. The route layer's create+update are
      // separate verbs (POST creates, PUT updates by ULID id); slug is the
      // author-readable handle the workflow-builder agent has. Resolve
      // slug → row id via GET, then PUT if found or POST if not.
      const def = args.def && typeof args.def === 'object' ? args.def : null;
      if (!def) {
        return {
          content: [{ type: 'text', text: 'pc_publish_workflow: def required' }],
          isError: true,
        };
      }
      const defObj = def as { id?: unknown };
      const slug = typeof defObj.id === 'string' ? defObj.id : '';
      if (!slug) {
        return {
          content: [
            { type: 'text', text: 'pc_publish_workflow: def.id (slug) required' },
          ],
          isError: true,
        };
      }
      if (!PROJECT_ID) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_publish_workflow: PC_PROJECT_ID env not set — workflow publish requires a project scope.',
            },
          ],
          isError: true,
        };
      }
      try {
        const listRes = await getServer(
          `/api/workflows?projectId=${encodeURIComponent(PROJECT_ID)}`,
        );
        let existingId: string | null = null;
        if (listRes.status >= 200 && listRes.status < 300) {
          try {
            const parsed = JSON.parse(listRes.body) as {
              workflows?: Array<{
                id: string;
                slug: string;
                scope: 'project' | 'global';
              }>;
            };
            const match = (parsed.workflows ?? []).find(
              (w) => w.slug === slug && w.scope === 'project',
            );
            if (match) existingId = match.id;
          } catch {
            /* fall through to POST */
          }
        }
        const payload: Record<string, unknown> = {
          def,
          actor: 'orchestrator',
          reason: 'mcp-publish',
        };
        let res;
        if (existingId) {
          res = await putServer(
            `/api/workflows/${encodeURIComponent(existingId)}`,
            payload,
          );
        } else {
          payload.projectId = PROJECT_ID;
          payload.scope = 'project';
          res = await postServer('/api/workflows', payload);
        }
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_publish_workflow failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_publish_workflow failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_write_claude_md': {
      const content = typeof args.content === 'string' ? args.content : '';
      if (!content.trim()) {
        return {
          content: [{ type: 'text', text: 'pc_write_claude_md: content required (non-empty)' }],
          isError: true,
        };
      }
      try {
        const res = await putServer(projectPath('claude-md'), { content });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_write_claude_md failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_write_claude_md failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_list_stages': {
      try {
        // GET /api/projects/:id (no suffix) — projectPath('') would leave a
        // trailing slash that Hono's strict router doesn't match.
        if (!PROJECT_ID) throw new Error('PC_PROJECT_ID required');
        const res = await getServer(`/api/projects/${PROJECT_ID}`);
        if (res.status >= 200 && res.status < 300) {
          try {
            const project = JSON.parse(res.body) as ProjectStagesResponse;
            const stages = (project.stages ?? []).map(stageForMcp);
            return { content: [{ type: 'text', text: JSON.stringify({ ok: true, stages }) }] };
          } catch {
            return { content: [{ type: 'text', text: `pc_list_stages parse error: ${res.body.slice(0, 200)}` }], isError: true };
          }
        }
        return {
          content: [{ type: 'text', text: `pc_list_stages failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_list_stages failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_list_workflows': {
      // 19.17 — repointed at the DB-backed `/api/workflows?projectId=...`
      // surface (the legacy v1 `/projects/:id/workflows` path was deleted
      // in 19.12). Returns project-scoped rows plus globals visible to
      // this project.
      if (!PROJECT_ID) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_list_workflows: PC_PROJECT_ID env not set',
            },
          ],
          isError: true,
        };
      }
      try {
        const res = await getServer(
          `/api/workflows?projectId=${encodeURIComponent(PROJECT_ID)}`,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_list_workflows failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_list_workflows failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_fire_workflow': {
      if (!PROJECT_ID) {
        return {
          content: [
            { type: 'text', text: 'pc_fire_workflow: PC_PROJECT_ID env not set' },
          ],
          isError: true,
        };
      }
      const workflow = typeof args.workflow === 'string' ? args.workflow.trim() : '';
      if (!workflow) {
        return {
          content: [{ type: 'text', text: 'pc_fire_workflow: `workflow` (slug or id) required' }],
          isError: true,
        };
      }
      try {
        // Resolve slug → DB id if needed. ULIDs are ~26 chars Crockford base32;
        // slugs are kebab-case. The DB endpoint takes the row id, not the slug.
        const looksLikeUlid = /^[0-9A-HJKMNP-TV-Z]{26}$/.test(workflow);
        let rowId = workflow;
        if (!looksLikeUlid) {
          const listRes = await getServer(
            `/api/workflows?projectId=${encodeURIComponent(PROJECT_ID)}`,
          );
          if (listRes.status < 200 || listRes.status >= 300) {
            return {
              content: [
                { type: 'text', text: `pc_fire_workflow: list failed (${listRes.status}): ${listRes.body}` },
              ],
              isError: true,
            };
          }
          const parsed = JSON.parse(listRes.body) as {
            workflows?: Array<{ id: string; slug: string }>;
          };
          const match = (parsed.workflows ?? []).find((w) => w.slug === workflow);
          if (!match) {
            return {
              content: [
                { type: 'text', text: `pc_fire_workflow: no workflow with slug "${workflow}" in this project` },
              ],
              isError: true,
            };
          }
          rowId = match.id;
        }
        const trigger =
          args.trigger && typeof args.trigger === 'object'
            ? args.trigger
            : { kind: 'manual' };
        const body: Record<string, unknown> = { trigger, projectId: PROJECT_ID };
        const res = await postServer(`/api/workflows/${encodeURIComponent(rowId)}/fire`, body);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_fire_workflow failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_fire_workflow failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_complete_node': {
      if (!PROJECT_ID) {
        return {
          content: [
            { type: 'text', text: 'pc_complete_node: PC_PROJECT_ID env not set' },
          ],
          isError: true,
        };
      }
      const runId = typeof args.workflowRunId === 'string' ? args.workflowRunId.trim() : '';
      const nodeId = typeof args.nodeId === 'string' ? args.nodeId.trim() : '';
      const decision = args.decision;
      if (!runId || !nodeId || (decision !== 'approve' && decision !== 'reject')) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_complete_node: require { workflowRunId, nodeId, decision: "approve"|"reject", notes? }',
            },
          ],
          isError: true,
        };
      }
      try {
        const body: Record<string, unknown> = { runId, nodeId, decision };
        if (typeof args.notes === 'string' && args.notes.trim()) body.notes = args.notes;
        const res = await postServer(
          projectPath('workflow-v2/review'),
          body,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_complete_node failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_complete_node failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_list_field_schemas': {
      try {
        const res = await getServer(projectPath('field-schemas'));
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_list_field_schemas failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_list_field_schemas failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_invoke_agent': {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      const input = typeof args.input === 'string' ? args.input : '';
      if (!name || !input.trim()) {
        return {
          content: [{ type: 'text', text: 'pc_invoke_agent: name and input required' }],
          isError: true,
        };
      }
      if (!PROJECT_ID) {
        return {
          content: [
            { type: 'text', text: 'pc_invoke_agent: PC_PROJECT_ID not set' },
          ],
          isError: true,
        };
      }
      const dispatcherSessionId =
        process.env.PC_SESSION_ID || process.env.PC_DISPATCHER_SESSION_ID || '';
      if (!dispatcherSessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_invoke_agent: PC_SESSION_ID (orchestrator) or PC_DISPATCHER_SESSION_ID (agent) not set',
            },
          ],
          isError: true,
        };
      }
      const parentWorkItemId =
        typeof args.parentWorkItemId === 'string' && args.parentWorkItemId.trim()
          ? args.parentWorkItemId.trim()
          : process.env.PC_AGENT_PARENT_WORK_ITEM_ID || undefined;
      const workItemId =
        typeof args.workItemId === 'string' && args.workItemId.trim()
          ? args.workItemId.trim()
          : undefined;
      const rawDepth = Number(process.env.PC_AGENT_INVOKE_DEPTH ?? '0');
      const parentInvokeDepth =
        Number.isFinite(rawDepth) && rawDepth > 0 ? Math.floor(rawDepth) : 0;
      const payload: Record<string, unknown> = {
        input,
        parentInvokeDepth,
        dispatcherSessionId,
      };
      if (parentWorkItemId) payload.parentWorkItemId = parentWorkItemId;
      if (workItemId) payload.workItemId = workItemId;
      try {
        const res = await postServer(
          `/api/projects/${PROJECT_ID}/agents/${encodeURIComponent(name)}/invoke`,
          payload,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_invoke_agent failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_invoke_agent failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_continue_agent': {
      const runId = typeof args.runId === 'string' ? args.runId.trim() : '';
      const input = typeof args.input === 'string' ? args.input : '';
      if (!runId || !input.trim()) {
        return {
          content: [{ type: 'text', text: 'pc_continue_agent: runId and input required' }],
          isError: true,
        };
      }
      if (!PROJECT_ID) {
        return {
          content: [
            { type: 'text', text: 'pc_continue_agent: PC_PROJECT_ID not set' },
          ],
          isError: true,
        };
      }
      const dispatcherSessionId =
        process.env.PC_SESSION_ID || process.env.PC_DISPATCHER_SESSION_ID || '';
      if (!dispatcherSessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_continue_agent: PC_SESSION_ID / PC_DISPATCHER_SESSION_ID not set',
            },
          ],
          isError: true,
        };
      }
      const continueWorkItemId =
        typeof args.workItemId === 'string' && args.workItemId.trim()
          ? args.workItemId.trim()
          : undefined;
      try {
        const continuePayload: Record<string, unknown> = { input, dispatcherSessionId };
        if (continueWorkItemId) continuePayload.workItemId = continueWorkItemId;
        const res = await postServer(
          `/api/projects/${PROJECT_ID}/agent-runs/${encodeURIComponent(runId)}/continue`,
          continuePayload,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_continue_agent failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_continue_agent failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_list_my_runs': {
      if (!PROJECT_ID) {
        return {
          content: [{ type: 'text', text: 'pc_list_my_runs: PC_PROJECT_ID not set' }],
          isError: true,
        };
      }
      const dispatcherSessionId =
        process.env.PC_SESSION_ID || process.env.PC_DISPATCHER_SESSION_ID || '';
      if (!dispatcherSessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_list_my_runs: PC_SESSION_ID / PC_DISPATCHER_SESSION_ID not set',
            },
          ],
          isError: true,
        };
      }
      const params = new URLSearchParams();
      params.set('dispatcherSessionId', dispatcherSessionId);
      if (typeof args.agentName === 'string' && args.agentName.trim()) {
        params.set('agentName', args.agentName.trim());
      }
      if (typeof args.status === 'string' && args.status.trim()) {
        params.set('status', args.status.trim());
      }
      if (typeof args.limit === 'number' && Number.isFinite(args.limit)) {
        params.set('limit', String(Math.floor(args.limit)));
      }
      try {
        const res = await getServer(
          `/api/projects/${PROJECT_ID}/agent-runs/by-dispatcher?${params.toString()}`,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_list_my_runs failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_list_my_runs failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_ask_orchestrator':
    case 'pc_ask_user':
    case 'pc_request_approval': {
      const toolName = req.params.name;
      const isApproval = toolName === 'pc_request_approval';
      const isAskUser = toolName === 'pc_ask_user';
      const promptField = isApproval ? 'decision' : 'question';
      const promptValue =
        typeof args[promptField] === 'string' ? (args[promptField] as string).trim() : '';
      const context = typeof args.context === 'string' ? args.context : undefined;
      const options = Array.isArray(args.options) ? args.options : undefined;
      if (!promptValue) {
        return {
          content: [{ type: 'text', text: `${toolName}: ${promptField} required` }],
          isError: true,
        };
      }
      if (isApproval && (!options || options.length === 0)) {
        return {
          content: [{ type: 'text', text: `${toolName}: options required (non-empty array)` }],
          isError: true,
        };
      }
      const runId = process.env.PC_AGENT_RUN_ID ?? '';
      if (!runId) {
        return {
          content: [
            {
              type: 'text',
              text: `${toolName}: PC_AGENT_RUN_ID not set — only v2-dispatched agents can pause-and-ask`,
            },
          ],
          isError: true,
        };
      }
      if (!PROJECT_ID) {
        return {
          content: [{ type: 'text', text: `${toolName}: PC_PROJECT_ID not set` }],
          isError: true,
        };
      }
      const kind: 'orchestrator' | 'user' | 'approval' = isApproval
        ? 'approval'
        : isAskUser
          ? 'user'
          : 'orchestrator';
      const payload: Record<string, unknown> = {
        agentRunId: runId,
        kind,
        promptBody: promptValue,
      };
      if (context !== undefined) payload.context = context;
      if (options !== undefined) payload.options = options;
      try {
        const res = await postServer(projectPath('agent-pending-asks'), payload);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `${toolName} failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `${toolName} failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_answer_pending': {
      const pendingAskId = typeof args.pendingAskId === 'string' ? args.pendingAskId.trim() : '';
      const answer = typeof args.answer === 'string' ? args.answer : '';
      const answeredByRaw = typeof args.answeredBy === 'string' ? args.answeredBy : '';
      if (!pendingAskId || !answer) {
        return {
          content: [
            { type: 'text', text: 'pc_answer_pending: pendingAskId and answer required' },
          ],
          isError: true,
        };
      }
      if (answeredByRaw !== 'orchestrator' && answeredByRaw !== 'user') {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_answer_pending: answeredBy must be "orchestrator" or "user"',
            },
          ],
          isError: true,
        };
      }
      try {
        const res = await postServer(
          projectPath(`agent-pending-asks/${encodeURIComponent(pendingAskId)}/answer`),
          { answer, answeredBy: answeredByRaw },
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_answer_pending failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_answer_pending failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_create_workflow': {
      if (!PROJECT_ID) {
        return {
          content: [{ type: 'text', text: 'pc_create_workflow: PC_PROJECT_ID not set' }],
          isError: true,
        };
      }
      const hasDef = args.def && typeof args.def === 'object';
      const hasYaml = typeof args.yaml === 'string' && (args.yaml as string).trim().length > 0;
      if (!hasDef && !hasYaml) {
        return {
          content: [{ type: 'text', text: 'pc_create_workflow: either yaml or def required' }],
          isError: true,
        };
      }
      const scope = args.scope === 'global' ? 'global' : 'project';
      try {
        const payload: Record<string, unknown> = {
          scope,
          actor: 'orchestrator',
          reason: 'mcp-create',
          ...(scope === 'project' ? { projectId: PROJECT_ID } : {}),
        };
        if (hasYaml) payload.yaml = args.yaml;
        if (hasDef) payload.def = args.def;
        const res = await postServer('/api/workflows', payload);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_create_workflow failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_create_workflow failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_update_workflow': {
      const workflowId = typeof args.id === 'string' ? args.id.trim() : '';
      if (!workflowId) {
        return {
          content: [{ type: 'text', text: 'pc_update_workflow: id required' }],
          isError: true,
        };
      }
      try {
        const payload: Record<string, unknown> = {
          actor: 'orchestrator',
          reason: 'mcp-update',
        };
        if (typeof args.yaml === 'string') payload.yaml = args.yaml;
        if (args.def && typeof args.def === 'object') payload.def = args.def;
        if (typeof args.disabled === 'boolean') payload.disabled = args.disabled;
        const res = await putServer(`/api/workflows/${encodeURIComponent(workflowId)}`, payload);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_update_workflow failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_update_workflow failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_delete_workflow': {
      const workflowId = typeof args.id === 'string' ? args.id.trim() : '';
      if (!workflowId) {
        return {
          content: [{ type: 'text', text: 'pc_delete_workflow: id required' }],
          isError: true,
        };
      }
      try {
        const cancel = args.cancel === true;
        const qs = cancel ? '?cancel=1&actor=orchestrator&reason=mcp-delete' : '?actor=orchestrator&reason=mcp-delete';
        const res = await deleteServer(`/api/workflows/${encodeURIComponent(workflowId)}${qs}`);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_delete_workflow failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_delete_workflow failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_get_workflow': {
      const workflowId = typeof args.id === 'string' ? args.id.trim() : '';
      if (!workflowId) {
        return {
          content: [{ type: 'text', text: 'pc_get_workflow: id required' }],
          isError: true,
        };
      }
      try {
        const res = await getServer(`/api/workflows/${encodeURIComponent(workflowId)}`);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_get_workflow failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_get_workflow failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_replace_stages': {
      if (!PROJECT_ID) {
        return {
          content: [{ type: 'text', text: 'pc_replace_stages: PC_PROJECT_ID not set' }],
          isError: true,
        };
      }
      const stages = Array.isArray(args.stages) ? args.stages : null;
      if (!stages) {
        return {
          content: [{ type: 'text', text: 'pc_replace_stages: stages array required' }],
          isError: true,
        };
      }
      try {
        const payload: Record<string, unknown> = { stages };
        if (args.force === true) payload.force = true;
        if (typeof args.fallbackStageId === 'string') payload.fallbackStageId = args.fallbackStageId;
        const res = await patchServer(`/api/projects/${PROJECT_ID}/stages`, payload);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        // Surface 409 STAGE_HAS_ITEMS verbatim so the caller can react.
        return {
          content: [{ type: 'text', text: `pc_replace_stages failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_replace_stages failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_replace_field_schemas': {
      if (!PROJECT_ID) {
        return {
          content: [{ type: 'text', text: 'pc_replace_field_schemas: PC_PROJECT_ID not set' }],
          isError: true,
        };
      }
      const items = Array.isArray(args.items) ? args.items : null;
      if (!items) {
        return {
          content: [{ type: 'text', text: 'pc_replace_field_schemas: items array required' }],
          isError: true,
        };
      }
      try {
        const res = await putServer(`/api/projects/${PROJECT_ID}/field-schemas`, { items });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_replace_field_schemas failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_replace_field_schemas failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`unknown tool: ${req.params.name}`);
  }
});

// Section 36 — guard the stdio-attach + heartbeat behind an "am I the entry
// point?" check so consumers that only need the TOOLS array (apps/server's
// pod-tool-catalog re-exports PC_RIG_TOOL_NAMES) can import this module
// without booting an MCP server and pinning the event loop. The mcp build
// (`scripts/build.mjs`) produces dist/server.mjs which IS the entry point —
// import.meta.url matches process.argv[1]'s file URL there. When Caisson's server
// imports `@pc/mcp` from a test or runtime context, the comparison fails and
// the side effects stay parked.
const ENTRY_URL = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === ENTRY_URL) {
  writeStatus();
  const heartbeatTimer = setInterval(heartbeat, 2000);
  heartbeatTimer.unref?.();

  await server.connect(new StdioServerTransport());
}
