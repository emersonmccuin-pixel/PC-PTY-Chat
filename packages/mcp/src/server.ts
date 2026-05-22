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
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// packages/mcp/src/server.ts → trunk root is three levels up. Used as the
// fallback data dir; PC_DATA_DIR override wins.
const ROOT = resolve(__dirname, '..', '..', '..');
const DATA = process.env.PC_DATA_DIR ? resolve(process.env.PC_DATA_DIR) : resolve(ROOT, 'data');
const PROJECT_ID = process.env.PC_PROJECT_ID ?? '';
const SERVER_PORT = Number(process.env.PC_SERVER_PORT ?? 4040);

// Per-project log + heartbeat — keep each project's MCP signals isolated.
const PROJECT_DATA = PROJECT_ID ? resolve(DATA, 'projects', PROJECT_ID) : DATA;
const LOG = resolve(PROJECT_DATA, 'mcp-log.jsonl');
const STATUS = resolve(PROJECT_DATA, 'mcp-status.json');

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
  {
    name: 'pc_create_work_item',
    description:
      'Create a new work item in the given stage. Returns the new WorkItem with its generated ULID id. Use this when the user asks for a fresh card / task / item; do not seed one via pc_update_work_item.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'short title for the work item' },
        stageId: {
          type: 'string',
          description: 'destination stage id (slug, e.g. "draft" / "review" / "done")',
        },
        body: { type: 'string', description: 'optional free-form body / spec' },
      },
      required: ['title', 'stageId'],
    },
  },
  {
    name: 'pc_log_bug',
    description:
      "File a bug in the user's PC-PTY-Chat dogfood tracker, no matter which project this chat is bound to. Reads the target project id from GlobalSettings.bugLogTargetProjectId; if unset, returns an error telling the user to configure 'Bug log target' in App Settings. The new work item is created with type='bug', dropped into the target project's FIRST stage, and the body is prefixed with 'Logged from project: <source-name> · session: <id>' so the bug carries its origin context. Use whenever the user says something like 'log a bug', 'log this as a bug', 'file a bug report', or otherwise reports a defect they want tracked.",
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
  {
    name: 'pc_move_work_item',
    description:
      'Move a work item to a different stage. If a workflow has `triggers.on_enter: { stage_id: <toStage> }`, that workflow fires automatically against the bound wi-<id> worktree.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'work item id (ULID)' },
        toStage: { type: 'string', description: 'destination stage id' },
      },
      required: ['id', 'toStage'],
    },
  },
  {
    name: 'pc_update_work_item',
    description:
      'Admin only — manually merge fields into a work item.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'work item id' },
        fields: {
          type: 'object',
          description: 'fields to merge into workItem.fields (shallow merge)',
          additionalProperties: true,
        },
      },
      required: ['id', 'fields'],
    },
  },
  {
    name: 'pc_complete_node',
    description:
      'Close a single workflow node as successful. The orchestrator delegated you via Task with a prompt carrying [workflowRunId: <id>] and [nodeId: <id>] tokens — pass both verbatim. `output` is whatever payload your node should publish; later nodes reference it as `$<this-node-id>.output[.field]`. The runtime re-ticks the workflow on success so downstream nodes fire. Returns { ok: true } on success or { ok: false, error } if the run or node id is unknown / already closed.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowRunId: {
          type: 'string',
          description: 'opaque id from the channel prompt (look for "[workflowRunId: <id>]")',
        },
        nodeId: {
          type: 'string',
          description: 'opaque id from the channel prompt (look for "[nodeId: <id>]")',
        },
        output: {
          type: 'object',
          description: 'Output payload to publish under this node id.',
          additionalProperties: true,
        },
      },
      required: ['workflowRunId', 'nodeId', 'output'],
    },
  },
  {
    name: 'pc_node_failed',
    description:
      'Close a single workflow node as failed. Pass workflowRunId + nodeId from the channel prompt tokens, plus a short reason string. The runtime re-ticks; downstream nodes with trigger_rule "all_success" become unreachable and get skipped. Use this when you cannot produce the contracted output — e.g. the input was malformed, the worktree is missing required files, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowRunId: {
          type: 'string',
          description: 'opaque id from the channel prompt (look for "[workflowRunId: <id>]")',
        },
        nodeId: {
          type: 'string',
          description: 'opaque id from the channel prompt (look for "[nodeId: <id>]")',
        },
        reason: {
          type: 'string',
          description: 'one-line failure reason — shown in the UI on the failed run.',
        },
      },
      required: ['workflowRunId', 'nodeId', 'reason'],
    },
  },
  {
    name: 'pc_run_workflow',
    description:
      'Start a fresh run of a callable workflow. `name` is the workflow id (matches the workflow file basename + the workflow YAML\'s `id:` field). `input` is an optional object passed through to the run as `run.inputs`. The workflow must declare `triggers.callable: true`. The run executes in its own `run-<short>` worktree (siblings of the workspace). Returns the new WorkflowRun or { ok: false, error } when the workflow is unknown, ambiguous, invalid, or not callable.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'workflow id (matches the file basename)' },
        input: {
          type: 'object',
          description: 'optional inputs object — referenceable in the workflow as $inputs.<key> once that substitution lands; passes through to run.inputs today.',
          additionalProperties: true,
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'pc_create_agent',
    description:
      "Create a NEW agent pod (DB-resident; global-scope in v1). Returns the new pod row with its ULID id. Use this for fresh agent design — the user said 'build me an agent that does X'. For structural design from scratch you should usually dispatch agent-designer first (pc_invoke_agent agent='agent-designer') so the design conversation happens in its specialised pod; call pc_create_agent directly only for trivial extractors / utilities or when continuing a design conversation. Stock-pod names (orchestrator/researcher/writer/reviewer/planner/extractor/agent-designer) are reserved — 400 if name collides. Broadcasts pod-changed on success.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'lowercase kebab-case agent name (letters/numbers/dashes)' },
        prompt: { type: 'string', description: "the agent's system prompt body (markdown)" },
        description: { type: 'string', description: 'one-line description for the dispatch picker' },
        model: { type: 'string', description: "model slug (e.g. 'opus' / 'sonnet' / 'haiku' / 'inherit')" },
        effort: { type: 'string', description: "reasoning effort: low / medium / high / xhigh / max" },
        maxTurns: { type: 'integer', description: 'optional cap on the number of conversation turns' },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: "allowlist of tool slugs (e.g. ['Read','Grep','mcp__pc-rig__pc_log']). Empty = inherit all.",
        },
        outputDestination: {
          type: 'string',
          description: "where the agent's output goes (per AgentOutputDestination enum)",
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'pc_get_agent',
    description:
      "Fetch the full pod bundle for an agent: prompt + knowledge docs + secret env-var names (NEVER values) + MCP servers + scalar settings. Use when you need to read an agent's current configuration before recommending a change, answering 'what does <agent> know about X?', or auditing a pod's setup. Accepts either { id } (ULID) or { name } (resolved to id via list lookup).",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'pod ULID id (mutually exclusive with name)' },
        name: { type: 'string', description: 'pod name (looked up if id absent)' },
      },
    },
  },
  {
    name: 'pc_update_agent_prompt',
    description:
      "Replace an agent's system prompt body. Most-used edit path: 'make orchestrator terser', 'teach researcher to cite sources'. Audits as actor='orchestrator'. Stock-pod prompts (orchestrator/researcher/...) are editable — be deliberate; danger-zone editing in the UI is gated for a reason. Accepts either { id } or { name }. Triggers restart-on-edit for any live session.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'pod ULID id (mutually exclusive with name)' },
        name: { type: 'string', description: 'pod name (looked up if id absent)' },
        prompt: { type: 'string', description: 'the new system prompt body (markdown)' },
        reason: { type: 'string', description: 'optional one-line audit reason' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'pc_update_agent_settings',
    description:
      "Update an agent's scalar settings: model, effort, maxTurns, tools, outputDestination, description, or name. Pass only the fields you want to change. For prompt edits use pc_update_agent_prompt instead. Audits as actor='orchestrator'; multi-field updates audit under a shared change-set. Accepts either { id } or { name }.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'pod ULID id (mutually exclusive with name)' },
        name: { type: 'string', description: 'pod name (looked up if id absent)' },
        newName: { type: 'string', description: 'rename (lowercase kebab-case)' },
        description: { type: 'string', description: 'new one-line description' },
        model: { type: 'string' },
        effort: { type: 'string', description: 'low / medium / high / xhigh / max' },
        maxTurns: { type: 'integer' },
        tools: { type: 'array', items: { type: 'string' } },
        outputDestination: { type: 'string' },
        reason: { type: 'string', description: 'optional one-line audit reason' },
      },
    },
  },
  {
    name: 'pc_delete_agent',
    description:
      "Soft-delete an agent pod. Stock pods (orchestrator/researcher/writer/reviewer/planner/extractor/agent-designer) are NOT deletable — returns 409. The pod can be restored via the History tab. Audits as actor='orchestrator'. Accepts either { id } or { name }.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'pod ULID id (mutually exclusive with name)' },
        name: { type: 'string', description: 'pod name (looked up if id absent)' },
        reason: { type: 'string', description: 'optional one-line audit reason' },
      },
    },
  },
  {
    name: 'pc_create_knowledge',
    description:
      "Attach a knowledge document to an agent (reference material the agent can read at runtime via pc_knowledge_read). Low-friction add path: paste the content, omit the docName and we'll auto-derive from the first markdown heading or first non-empty line. Use this when the user says 'teach <agent> about <topic>: …'. Accepts either { agentId } or { agentName }. Audits as actor='orchestrator'. Returns the new knowledge row including its id.",
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'pod ULID id (mutually exclusive with agentName)' },
        agentName: { type: 'string', description: 'pod name (looked up if agentId absent)' },
        content: { type: 'string', description: 'document body (markdown / plain text)' },
        docName: {
          type: 'string',
          description: 'optional doc name — auto-derived from H1 / first line if omitted',
        },
        reason: { type: 'string', description: 'optional one-line audit reason' },
      },
      required: ['content'],
    },
  },
  {
    name: 'pc_update_knowledge',
    description:
      "Wholesale-replace a knowledge document's content (and optionally its name). The prior version is preserved in the audit log for revert. Use for 'the pricing tiers changed — update <agent>'s pricing doc: …'. Audits as actor='orchestrator'. Accepts either { agentId } or { agentName } plus { knowledgeId }.",
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'pod ULID id (mutually exclusive with agentName)' },
        agentName: { type: 'string', description: 'pod name (looked up if agentId absent)' },
        knowledgeId: { type: 'string', description: 'knowledge doc ULID id' },
        content: { type: 'string', description: 'new document body' },
        docName: { type: 'string', description: 'optional rename' },
        reason: { type: 'string', description: 'optional one-line audit reason' },
      },
      required: ['knowledgeId'],
    },
  },
  {
    name: 'pc_delete_knowledge',
    description:
      "Remove a knowledge document from an agent. Audits as actor='orchestrator'. Accepts either { agentId } or { agentName } plus { knowledgeId }.",
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'pod ULID id (mutually exclusive with agentName)' },
        agentName: { type: 'string', description: 'pod name (looked up if agentId absent)' },
        knowledgeId: { type: 'string', description: 'knowledge doc ULID id' },
        reason: { type: 'string', description: 'optional one-line audit reason' },
      },
      required: ['knowledgeId'],
    },
  },
  {
    name: 'pc_knowledge_read',
    description:
      "Read a single knowledge document's full content by id. Worker agents call this at runtime to pull reference material (the agent's spawn-time prompt lists available docs + their ids). The orchestrator uses it to surface knowledge content inline ('what does <agent> know about <topic>?'). Accepts either { agentId } or { agentName } plus { knowledgeId }.",
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'pod ULID id (mutually exclusive with agentName)' },
        agentName: { type: 'string', description: 'pod name (looked up if agentId absent)' },
        knowledgeId: { type: 'string', description: 'knowledge doc ULID id' },
      },
      required: ['knowledgeId'],
    },
  },
  {
    name: 'pc_create_agent_secret',
    description:
      "Attach a plaintext env-var secret to an agent. The value is stored in plain text in v1 (encryption lands in v2) — the user has been warned via the UI banner. Pod gets `envVarName=value` materialised into its environment at spawn. Use for things like API keys / tokens needed by per-pod MCP servers. Audits event-only (value never logged). Accepts either { agentId } or { agentName }.",
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'pod ULID id (mutually exclusive with agentName)' },
        agentName: { type: 'string', description: 'pod name (looked up if agentId absent)' },
        envVarName: { type: 'string', description: 'environment variable name (e.g. GMAIL_TOKEN)' },
        valuePlaintext: { type: 'string', description: 'secret value (stored plaintext in v1)' },
        reason: { type: 'string', description: 'optional one-line audit reason' },
      },
      required: ['envVarName', 'valuePlaintext'],
    },
  },
  {
    name: 'pc_delete_agent_secret',
    description:
      "Detach a secret env-var from an agent. Audits as actor='orchestrator'. Accepts either { agentId } or { agentName } plus { secretId }.",
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'pod ULID id (mutually exclusive with agentName)' },
        agentName: { type: 'string', description: 'pod name (looked up if agentId absent)' },
        secretId: { type: 'string', description: 'secret ULID id' },
        reason: { type: 'string', description: 'optional one-line audit reason' },
      },
      required: ['secretId'],
    },
  },
  {
    name: 'pc_add_agent_mcp_server',
    description:
      "Configure a per-pod MCP server (e.g. gmail, jira, custom). The pod's materialised mcp.json will merge this server into the baseline at spawn time; pod entry wins per-server-name. Pass the standard MCP config shape: { command, args, env } OR { url } (for HTTP transports). Accepts either { agentId } or { agentName }.",
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'pod ULID id (mutually exclusive with agentName)' },
        agentName: { type: 'string', description: 'pod name (looked up if agentId absent)' },
        serverName: { type: 'string', description: 'MCP server name (e.g. "gmail")' },
        config: {
          type: 'object',
          description: 'MCP server config: { command, args?, env? } or { url }',
          properties: {
            command: { type: 'string' },
            args: { type: 'array', items: { type: 'string' } },
            env: { type: 'object', additionalProperties: { type: 'string' } },
            url: { type: 'string' },
          },
        },
        reason: { type: 'string', description: 'optional one-line audit reason' },
      },
      required: ['serverName', 'config'],
    },
  },
  {
    name: 'pc_delete_agent_mcp_server',
    description:
      "Detach a per-pod MCP server. Audits as actor='orchestrator'. Accepts either { agentId } or { agentName } plus { mcpServerId }.",
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'pod ULID id (mutually exclusive with agentName)' },
        agentName: { type: 'string', description: 'pod name (looked up if agentId absent)' },
        mcpServerId: { type: 'string', description: 'MCP server row ULID id' },
        reason: { type: 'string', description: 'optional one-line audit reason' },
      },
      required: ['mcpServerId'],
    },
  },
  {
    name: 'pc_open_agent_designer',
    description:
      "Open the AgentDesignerSessionModal in the UI so the user can design a new agent in a dedicated chat with agent-designer. Use this for ANY 'make me an agent that does X' / fresh-design / 'help me design an agent' request. Do NOT use pc_invoke_agent for agent-designer — that path is for one-shot worker agents; agent-designer is a conversational specialist that needs a free-form chat. Pass `initialIntent` carrying the user's request verbatim — the modal seeds it as the first user message so the agent-designer can open the conversation immediately. The chat then runs in the modal entirely; you will NOT receive its turns in your channel. When the agent-designer creates the new pod (pc_create_agent fires), the project's WS broadcasts `project-agents-changed` and the modal closes; you'll then surface a one-line confirmation in chat.",
    inputSchema: {
      type: 'object',
      properties: {
        initialIntent: {
          type: 'string',
          description: "the user's request verbatim — seeds the modal's first user message",
        },
      },
      required: ['initialIntent'],
    },
  },
  {
    name: 'pc_list_agent_audit',
    description:
      "Read an agent's change history. Returns audit rows newest-first. Filter by actor ('orchestrator' / 'user'), field ('prompt' / 'model' / 'effort' / 'tools' / 'description' / 'name' / 'maxTurns' / 'outputDestination' / 'knowledge' / 'secret' / 'mcp-server'), limit (default 50), beforeCreatedAt (epoch ms — for paging). Use when reasoning about 'why does this agent behave this way?' or auditing recent changes. Accepts either { agentId } or { agentName }.",
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'pod ULID id (mutually exclusive with agentName)' },
        agentName: { type: 'string', description: 'pod name (looked up if agentId absent)' },
        actor: { type: 'string', description: "filter by actor ('orchestrator' / 'user')" },
        field: { type: 'string', description: 'filter by audit field key' },
        limit: { type: 'integer', description: 'max rows returned (default 50)' },
        beforeCreatedAt: {
          type: 'integer',
          description: 'page boundary (epoch ms); rows older than this',
        },
      },
    },
  },
  {
    name: 'pc_get_work_item',
    description:
      'Fetch the full work item by id — title, body, fields, stage, status, parent. Use this when an agent needs to read the work item it is operating on without filesystem digging. Returns { ok: true, workItem } or { ok: false, error } for unknown / archived ids.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'work item id (ULID)' },
        includeArchived: {
          type: 'boolean',
          description: 'when true, also returns soft-deleted work items',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'pc_create_workflow',
    description:
      'Create a NEW project-scoped workflow YAML. Used by the conversational workflow-creator modal (4b). `def` is the typed workflow object (matches the on-disk YAML shape, minus the post-parse `kind:` discriminator). Server validates against the same parser the registry uses, serializes to YAML, writes to `<project>/.project-companion/workflows/<def.id>.yaml`, broadcasts project-workflows-changed. 409 on id collision. 400 on validation errors (returned with per-path messages).',
    inputSchema: {
      type: 'object',
      properties: {
        def: {
          type: 'object',
          description: 'typed workflow object: { id, triggers?, nodes: [...], ... }',
          additionalProperties: true,
        },
      },
      required: ['def'],
    },
  },
  {
    name: 'pc_edit_workflow',
    description:
      'Edit an EXISTING project-scoped workflow YAML in place. Companion to `pc_create_workflow`; same `def` shape (typed workflow object). Server runs the same validator + serializer the create path uses — comments + key order survive on round-trip — then writes to `<project>/.project-companion/workflows/<def.id>.yaml` and broadcasts project-workflows-changed. 400 if `def.id` does not match the URL workflow id (renames are a duplicate + delete operation, not an edit). 400 on validation errors with per-path messages. Use this when the workflow-creator session opened in edit mode (initial user message includes `[edit-mode workflowId="..."]`); use `pc_create_workflow` otherwise.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: {
          type: 'string',
          description:
            'id of the workflow to edit (the URL slug; must match def.id since renames are not supported via edit)',
        },
        def: {
          type: 'object',
          description: 'typed workflow object: { id, triggers?, nodes: [...], ... }',
          additionalProperties: true,
        },
      },
      required: ['workflowId', 'def'],
    },
  },
  {
    name: 'pc_update_workflow_draft',
    description:
      'Push an in-progress draft of the workflow currently being authored. Use this after each meaningful structural change during the conversational interview so the user can see the workflow forming in the visualizer. The draft is NOT written to disk — only `pc_create_workflow` does that. Server keys the draft by the transient PC_SESSION_ID env var (already set by the host); draft state clears automatically when the workflow-creator session ends. 400 on validation errors so you can self-correct mid-interview.',
    inputSchema: {
      type: 'object',
      properties: {
        def: {
          type: 'object',
          description: 'in-progress typed workflow object',
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
      'List the project\'s stages live from the server. Use this BEFORE asking the user which stage should trigger a workflow (or which stage a create/update-work-item step should target). Returns { ok: true, stages: [{ id, name, order }, ...] }. Stage `id` is what goes into `triggers.on_enter.stage_id` — never use the name. No arguments; PC_PROJECT_ID env is the implicit scope.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pc_list_agents',
    description:
      'List the agents available to this project. Use this BEFORE asking the user which agent a subagent step should call, or before authoring a subagent step. Returns { ok: true, globals: [{ name, description?, ... }, ...], overrides: [], projectOnly: [] }. Post-17e all live agents are global-scope DB pods and surface in `globals`; the other arrays are kept empty for API back-compat. The `name` is what goes into a subagent step\'s `subagent:` field. No arguments; PC_PROJECT_ID env is the implicit scope.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pc_list_workflows',
    description:
      'List workflows already authored in this project. Use this BEFORE asking the user which child workflow a nested `workflow:` step should call. Returns { valid: [{ id, fileName, ... }], invalid: [...] }; the `id` field is what goes into a nested-workflow step\'s `workflow:` field. No arguments; PC_PROJECT_ID env is the implicit scope.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pc_list_field_schemas',
    description:
      'List the project\'s custom work-item field schemas. Use this BEFORE authoring a create-work-item / update-work-item step that sets `fields`, so the keys are real (not invented). Returns { ok: true, schemas: [{ key, label, type, options?, required, ... }, ...] }. The `key` is what goes into the step\'s `fields` object. No arguments; PC_PROJECT_ID env is the implicit scope.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pc_attach_to_work_item',
    description:
      'Attach a text/markdown/JSON payload to a work item. The default destination for agent output per Section 3 D13 (the "report I will read later" path). Server stamps provenance: source = "agent" + the passed agentName + nodeId + workflowRunId. Returns { ok: true, attachment } or { ok: false, error }.',
    inputSchema: {
      type: 'object',
      properties: {
        workItemId: { type: 'string', description: 'destination work item id (ULID)' },
        name: { type: 'string', description: 'attachment display name' },
        content: { type: 'string', description: 'attachment body (inline; no filesystem path variant)' },
        kind: {
          type: 'string',
          description: 'free-form kind tag — known set: text / markdown / json. Defaults to "markdown".',
        },
        contentType: { type: 'string', description: 'optional MIME type' },
        agentName: { type: 'string', description: 'name of the agent producing this attachment' },
        workflowRunId: {
          type: 'string',
          description: 'workflow run id from the dispatch envelope ([workflowRunId: ...])',
        },
        nodeId: {
          type: 'string',
          description: 'workflow node id from the dispatch envelope ([nodeId: ...])',
        },
      },
      required: ['workItemId', 'name', 'content'],
    },
  },
  {
    name: 'pc_invoke_agent',
    description:
      "Dispatch a named agent (kebab-case, e.g. \"researcher\") in this project. With wait: true (default for background agents) the call blocks until the child finishes and returns { ok, mode: 'sync', sessionId, runId, result }; with wait: false (orchestrator default — don't block the chat composer) the call returns { ok, mode: 'async', sessionId, runId, startedAt } immediately and the terminal agent-completed / agent-failed channel event lands on your next turn (orchestrator handler protocol entries #4 + #5). Optional parentWorkItemId pins the child to a work-item — defaults to PC_AGENT_PARENT_WORK_ITEM_ID when called from inside another agent. The project route URL is derived from PC_PROJECT_ID.",
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'pod-row name of the agent to dispatch (kebab-case)',
        },
        input: {
          type: 'string',
          description: "free-form input — becomes the child's first user message",
        },
        wait: {
          type: 'boolean',
          description:
            'true → block until the child finishes; false → return immediately + terminal event lands on next turn. Orchestrator defaults to false; background agents default to true.',
        },
        parentWorkItemId: {
          type: 'string',
          description:
            'optional work-item ULID to attach the child to; defaults to PC_AGENT_PARENT_WORK_ITEM_ID',
        },
      },
      required: ['name', 'input'],
    },
  },
  {
    name: 'pc_ask_orchestrator',
    description:
      "Pause your run and ask the orchestrator a question. Returns { ok: true, pendingAskId, status: 'waiting' } immediately; the answer arrives as the next user message when your session resumes via --resume. After calling this tool, do not call any other tools and end your turn naturally — the runtime resumes you once the orchestrator answers. agentName + sessionId are read from PC_AGENT_NAME / PC_AGENT_SESSION_ID env vars set at spawn time; agents not spawned via pc_invoke_agent cannot call this.",
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'the question to ask the orchestrator' },
        context: {
          type: 'string',
          description:
            'optional context — recent transcript snippet, files inspected, candidate options. Helps the orchestrator decide whether it can answer directly or needs to escalate to the user.',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'pc_ask_user',
    description:
      "Pause your run and route a question to the user via the orchestrator-as-proxy. Returns { ok: true, pendingAskId, status: 'waiting' } immediately; the answer arrives as the next user message when your session resumes via --resume. After calling this tool, do not call any other tools and end your turn naturally — the runtime resumes you once the orchestrator forwards the user's reply. Use this when the question genuinely needs the human (intent / preference / approval-flavoured judgment); use pc_ask_orchestrator first if the orchestrator might know from project context.",
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'the question to surface to the user' },
        context: {
          type: 'string',
          description:
            'optional context — what you tried, what you found, why you need the user to weigh in',
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
      "Pause your run and request explicit human approval for a decision. Returns { ok: true, pendingAskId, status: 'waiting' } immediately; the user's decision arrives as the next user message when your session resumes via --resume. After calling this tool, do not call any other tools and end your turn naturally. Use this when proceeding requires explicit go/no-go (destructive operations, irreversible writes, expensive commits). Options is required and must be non-empty — typically [{value:'approve', label:'Approve'}, {value:'reject', label:'Reject'}, optionally {value:'revise', label:'Revise'}].",
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
            'optional context — what produced this decision, what the alternatives are, what the user should weigh',
        },
      },
      required: ['decision', 'options'],
    },
  },
  {
    name: 'pc_answer_pending',
    description:
      'Resume a paused agent with an answer. Atomically flips the pending-ask row waiting→answered, re-spawns the agent with --resume <sessionId>, and writes the answer as the next user message. Idempotent: a second call for the same pendingAskId returns ok: false, cause: "already-answered". Orchestrator usage only — agents that need to forward an answer to a different paused agent should use pc_ask_orchestrator instead.',
    inputSchema: {
      type: 'object',
      properties: {
        pendingAskId: { type: 'string', description: 'pending-ask ULID from the agent-asks-* event' },
        answer: { type: 'string', description: 'the answer to thread back into the paused agent' },
        answeredBy: {
          type: 'string',
          enum: ['orchestrator', 'user'],
          description:
            '"orchestrator" when answered from your own context, "user" when forwarding the user\'s reply (typically after a pc_ask_user round-trip)',
        },
      },
      required: ['pendingAskId', 'answer', 'answeredBy'],
    },
  },
] as const;

function projectPath(suffix: string): string {
  if (!PROJECT_ID) throw new Error('PC_PROJECT_ID is required for project-scoped calls');
  return `/api/projects/${PROJECT_ID}/${suffix.replace(/^\//, '')}`;
}

async function postServer(
  path: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((res, rej) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: SERVER_PORT,
        method: 'POST',
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c as Buffer));
        r.on('end', () =>
          res({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }),
        );
      },
    );
    req.on('error', rej);
    req.write(payload);
    req.end();
  });
}

async function putServer(
  path: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((res, rej) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: SERVER_PORT,
        method: 'PUT',
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c as Buffer));
        r.on('end', () =>
          res({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }),
        );
      },
    );
    req.on('error', rej);
    req.write(payload);
    req.end();
  });
}

async function getServer(path: string): Promise<{ status: number; body: string }> {
  return new Promise((res, rej) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: SERVER_PORT, method: 'GET', path },
      (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c as Buffer));
        r.on('end', () =>
          res({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }),
        );
      },
    );
    req.on('error', rej);
    req.end();
  });
}

async function patchServer(
  path: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((res, rej) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: SERVER_PORT,
        method: 'PATCH',
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c as Buffer));
        r.on('end', () =>
          res({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }),
        );
      },
    );
    req.on('error', rej);
    req.write(payload);
    req.end();
  });
}

/** Knowledge / secret / mcp-server tools accept { agentId } / { agentName }
 *  while agent tools use { id } / { name }. Adapt the former to the shape
 *  resolvePodId expects. */
function agentArgs(args: Record<string, unknown>): Record<string, unknown> {
  return {
    id: args.agentId,
    name: args.agentName,
  };
}

/** Auto-derive a knowledge-doc name from the content body. Priority: first
 *  H1 (`# Heading`) → first non-empty line → fallback to a timestamp slug.
 *  Whitespace trimmed; capped at 64 chars; kebab-cased. */
function deriveKnowledgeName(content: string): string {
  const lines = content.split(/\r?\n/);
  let candidate = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      candidate = line.replace(/^#+\s*/, '').trim();
    } else {
      candidate = line;
    }
    if (candidate) break;
  }
  if (!candidate) {
    return `knowledge-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  }
  const slug = candidate
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || `knowledge-${Date.now()}`;
}

/** Resolve a pod by either { id } or { name }. Name lookup hits the global
 *  list endpoint. Used by every pc_*_agent / pc_*_knowledge MCP tool so the
 *  orchestrator can refer to pods by their human name without needing to
 *  juggle ULIDs across turns. */
async function resolvePodId(
  args: Record<string, unknown>,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (typeof args.id === 'string' && args.id.trim().length > 0) {
    return { ok: true, id: args.id.trim() };
  }
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) {
    return { ok: false, error: 'either id or name required' };
  }
  const res = await getServer('/api/agents/pods');
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, error: `pod-list lookup failed (${res.status}): ${res.body}` };
  }
  try {
    const parsed = JSON.parse(res.body) as { pods?: Array<{ id: string; name: string }> };
    const pod = (parsed.pods ?? []).find((p) => p.name === name);
    if (!pod) return { ok: false, error: `no pod named '${name}'` };
    return { ok: true, id: pod.id };
  } catch (err) {
    return { ok: false, error: `pod-list parse failed: ${(err as Error).message}` };
  }
}

async function deleteServer(path: string): Promise<{ status: number; body: string }> {
  return new Promise((res, rej) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: SERVER_PORT, method: 'DELETE', path },
      (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c as Buffer));
        r.on('end', () =>
          res({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }),
        );
      },
    );
    req.on('error', rej);
    req.end();
  });
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

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS as unknown as typeof TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

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

    case 'pc_create_work_item': {
      const title = typeof args.title === 'string' ? args.title : '';
      const stageId = typeof args.stageId === 'string' ? args.stageId : '';
      const bodyText = typeof args.body === 'string' ? args.body : undefined;
      if (!title || !stageId) {
        return {
          content: [{ type: 'text', text: 'pc_create_work_item: title and stageId required' }],
          isError: true,
        };
      }
      try {
        const res = await postServer(projectPath('work-items/create'), {
          title,
          stageId,
          ...(bodyText ? { body: bodyText } : {}),
        });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_create_work_item failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_create_work_item failed: ${(err as Error).message}` }],
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
          stages?: Array<{ id: string; order?: number }>;
        };
        const stages = (target.stages ?? []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        const firstStage = stages[0]?.id;
        if (!firstStage) {
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
          stageId: firstStage,
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
        const parsed = JSON.parse(createRes.body) as { ok?: boolean; workItem?: { id?: string } };
        const newId = parsed.workItem?.id ?? '?';
        return {
          content: [
            {
              type: 'text',
              text: `Bug filed in ${target.name ?? targetId} (id: ${newId}, stage: ${firstStage}). Body: ${prefix}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_log_bug failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_move_work_item': {
      const id = typeof args.id === 'string' ? args.id : '';
      const toStage = typeof args.toStage === 'string' ? args.toStage : '';
      if (!id || !toStage) {
        return { content: [{ type: 'text', text: 'pc_move_work_item: id and toStage required' }], isError: true };
      }
      try {
        const res = await postServer(projectPath('work-items/move'), { id, toStage });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return { content: [{ type: 'text', text: `pc_move_work_item failed (${res.status}): ${res.body}` }], isError: true };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_move_work_item failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_update_work_item': {
      const id = typeof args.id === 'string' ? args.id : '';
      const fields = args.fields && typeof args.fields === 'object' ? args.fields : null;
      if (!id || !fields) {
        return { content: [{ type: 'text', text: 'pc_update_work_item: id and fields required' }], isError: true };
      }
      try {
        const res = await postServer(projectPath('work-items/update'), { id, fields });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return { content: [{ type: 'text', text: `pc_update_work_item failed (${res.status}): ${res.body}` }], isError: true };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_update_work_item failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_complete_node': {
      const workflowRunId = typeof args.workflowRunId === 'string' ? args.workflowRunId : '';
      const nodeId = typeof args.nodeId === 'string' ? args.nodeId : '';
      const output = args.output && typeof args.output === 'object' ? args.output : null;
      if (!workflowRunId || !nodeId || !output) {
        return {
          content: [
            { type: 'text', text: 'pc_complete_node: workflowRunId, nodeId, and output required' },
          ],
          isError: true,
        };
      }
      try {
        const res = await postServer(projectPath('workflow/node-complete'), {
          workflowRunId,
          nodeId,
          output,
        });
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

    case 'pc_node_failed': {
      const workflowRunId = typeof args.workflowRunId === 'string' ? args.workflowRunId : '';
      const nodeId = typeof args.nodeId === 'string' ? args.nodeId : '';
      const reason = typeof args.reason === 'string' ? args.reason : '';
      if (!workflowRunId || !nodeId || !reason) {
        return {
          content: [
            { type: 'text', text: 'pc_node_failed: workflowRunId, nodeId, and reason required' },
          ],
          isError: true,
        };
      }
      try {
        const res = await postServer(projectPath('workflow/node-failed'), {
          workflowRunId,
          nodeId,
          reason,
        });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_node_failed failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_node_failed failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_run_workflow': {
      const name = typeof args.name === 'string' ? args.name : '';
      const input = args.input && typeof args.input === 'object' ? args.input : undefined;
      if (!name) {
        return { content: [{ type: 'text', text: 'pc_run_workflow: name required' }], isError: true };
      }
      try {
        const res = await postServer(projectPath('workflow/run'), { name, input });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_run_workflow failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_run_workflow failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
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

    case 'pc_create_agent': {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (!name) {
        return { content: [{ type: 'text', text: 'pc_create_agent: name required' }], isError: true };
      }
      try {
        const payload: Record<string, unknown> = {
          name,
          actor: 'orchestrator',
          reason: 'mcp-create',
        };
        if (typeof args.prompt === 'string') payload.prompt = args.prompt;
        if (typeof args.description === 'string') payload.description = args.description;
        if (typeof args.model === 'string') payload.model = args.model;
        if (typeof args.effort === 'string') payload.effort = args.effort;
        if (typeof args.maxTurns === 'number') payload.maxTurns = args.maxTurns;
        if (Array.isArray(args.tools)) payload.tools = args.tools;
        if (typeof args.outputDestination === 'string') {
          payload.outputDestination = args.outputDestination;
        }
        const res = await postServer('/api/agents/pods', payload);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_create_agent failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_create_agent failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_get_agent': {
      try {
        const id = await resolvePodId(args);
        if (!id.ok) {
          return { content: [{ type: 'text', text: `pc_get_agent: ${id.error}` }], isError: true };
        }
        const res = await getServer(`/api/agents/pods/${encodeURIComponent(id.id)}`);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_get_agent failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_get_agent failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_update_agent_prompt': {
      const prompt = typeof args.prompt === 'string' ? args.prompt : '';
      if (typeof args.prompt !== 'string') {
        return {
          content: [{ type: 'text', text: 'pc_update_agent_prompt: prompt required (string)' }],
          isError: true,
        };
      }
      try {
        const id = await resolvePodId(args);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_update_agent_prompt: ${id.error}` }],
            isError: true,
          };
        }
        const payload: Record<string, unknown> = {
          prompt,
          actor: 'orchestrator',
          reason: typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-edit-prompt',
        };
        const res = await patchServer(`/api/agents/pods/${encodeURIComponent(id.id)}`, payload);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_update_agent_prompt failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_update_agent_prompt failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_update_agent_settings': {
      try {
        const id = await resolvePodId(args);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_update_agent_settings: ${id.error}` }],
            isError: true,
          };
        }
        const payload: Record<string, unknown> = {
          actor: 'orchestrator',
          reason: typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-edit-settings',
        };
        if (typeof args.newName === 'string') payload.name = args.newName.trim();
        if (typeof args.description === 'string') payload.description = args.description;
        if (typeof args.model === 'string') payload.model = args.model;
        if (typeof args.effort === 'string') payload.effort = args.effort;
        if (typeof args.maxTurns === 'number') payload.maxTurns = args.maxTurns;
        if (Array.isArray(args.tools)) payload.tools = args.tools;
        if (typeof args.outputDestination === 'string') {
          payload.outputDestination = args.outputDestination;
        }
        // Body must contain at least one mutating field — the `actor` + `reason`
        // alone produces a no-op update.
        const fieldKeys = Object.keys(payload).filter(
          (k) => k !== 'actor' && k !== 'reason',
        );
        if (fieldKeys.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'pc_update_agent_settings: at least one setting field required (newName / description / model / effort / maxTurns / tools / outputDestination)',
              },
            ],
            isError: true,
          };
        }
        const res = await patchServer(`/api/agents/pods/${encodeURIComponent(id.id)}`, payload);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_update_agent_settings failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_update_agent_settings failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_delete_agent': {
      try {
        const id = await resolvePodId(args);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_delete_agent: ${id.error}` }],
            isError: true,
          };
        }
        const reason =
          typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-delete';
        const qs = `actor=orchestrator&reason=${encodeURIComponent(reason)}`;
        const res = await deleteServer(`/api/agents/pods/${encodeURIComponent(id.id)}?${qs}`);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_delete_agent failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_delete_agent failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_create_knowledge': {
      const content = typeof args.content === 'string' ? args.content : '';
      if (typeof args.content !== 'string') {
        return {
          content: [{ type: 'text', text: 'pc_create_knowledge: content required (string)' }],
          isError: true,
        };
      }
      const explicitName =
        typeof args.docName === 'string' && args.docName.trim().length > 0
          ? args.docName.trim()
          : null;
      const name = explicitName ?? deriveKnowledgeName(content);
      try {
        const id = await resolvePodId(agentArgs(args));
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_create_knowledge: ${id.error}` }],
            isError: true,
          };
        }
        const payload: Record<string, unknown> = {
          name,
          content,
          actor: 'orchestrator',
          reason: typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-create-knowledge',
        };
        const res = await postServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/knowledge`,
          payload,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_create_knowledge failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_create_knowledge failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_update_knowledge': {
      const knowledgeId = typeof args.knowledgeId === 'string' ? args.knowledgeId.trim() : '';
      if (!knowledgeId) {
        return {
          content: [{ type: 'text', text: 'pc_update_knowledge: knowledgeId required' }],
          isError: true,
        };
      }
      try {
        const id = await resolvePodId(agentArgs(args));
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_update_knowledge: ${id.error}` }],
            isError: true,
          };
        }
        const payload: Record<string, unknown> = {
          actor: 'orchestrator',
          reason: typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-edit-knowledge',
        };
        if (typeof args.content === 'string') payload.content = args.content;
        if (typeof args.docName === 'string') payload.name = args.docName.trim();
        const fieldKeys = Object.keys(payload).filter(
          (k) => k !== 'actor' && k !== 'reason',
        );
        if (fieldKeys.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'pc_update_knowledge: at least one of { content, docName } required',
              },
            ],
            isError: true,
          };
        }
        const res = await patchServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/knowledge/${encodeURIComponent(knowledgeId)}`,
          payload,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_update_knowledge failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_update_knowledge failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_delete_knowledge': {
      const knowledgeId = typeof args.knowledgeId === 'string' ? args.knowledgeId.trim() : '';
      if (!knowledgeId) {
        return {
          content: [{ type: 'text', text: 'pc_delete_knowledge: knowledgeId required' }],
          isError: true,
        };
      }
      try {
        const id = await resolvePodId(agentArgs(args));
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_delete_knowledge: ${id.error}` }],
            isError: true,
          };
        }
        const reason =
          typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-delete-knowledge';
        const qs = `actor=orchestrator&reason=${encodeURIComponent(reason)}`;
        const res = await deleteServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/knowledge/${encodeURIComponent(knowledgeId)}?${qs}`,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_delete_knowledge failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_delete_knowledge failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_knowledge_read': {
      const knowledgeId = typeof args.knowledgeId === 'string' ? args.knowledgeId.trim() : '';
      if (!knowledgeId) {
        return {
          content: [{ type: 'text', text: 'pc_knowledge_read: knowledgeId required' }],
          isError: true,
        };
      }
      try {
        const id = await resolvePodId(agentArgs(args));
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_knowledge_read: ${id.error}` }],
            isError: true,
          };
        }
        const res = await getServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/knowledge/${encodeURIComponent(knowledgeId)}`,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_knowledge_read failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_knowledge_read failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_create_agent_secret': {
      const envVarName = typeof args.envVarName === 'string' ? args.envVarName.trim() : '';
      const valuePlaintext = typeof args.valuePlaintext === 'string' ? args.valuePlaintext : '';
      if (!envVarName) {
        return {
          content: [{ type: 'text', text: 'pc_create_agent_secret: envVarName required' }],
          isError: true,
        };
      }
      if (typeof args.valuePlaintext !== 'string') {
        return {
          content: [
            { type: 'text', text: 'pc_create_agent_secret: valuePlaintext required (string)' },
          ],
          isError: true,
        };
      }
      try {
        const id = await resolvePodId(agentArgs(args));
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_create_agent_secret: ${id.error}` }],
            isError: true,
          };
        }
        const payload: Record<string, unknown> = {
          envVarName,
          valuePlaintext,
          actor: 'orchestrator',
          reason: typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-create-secret',
        };
        const res = await postServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/secrets`,
          payload,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_create_agent_secret failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_create_agent_secret failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_delete_agent_secret': {
      const secretId = typeof args.secretId === 'string' ? args.secretId.trim() : '';
      if (!secretId) {
        return {
          content: [{ type: 'text', text: 'pc_delete_agent_secret: secretId required' }],
          isError: true,
        };
      }
      try {
        const id = await resolvePodId(agentArgs(args));
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_delete_agent_secret: ${id.error}` }],
            isError: true,
          };
        }
        const reason =
          typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-delete-secret';
        const qs = `actor=orchestrator&reason=${encodeURIComponent(reason)}`;
        const res = await deleteServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/secrets/${encodeURIComponent(secretId)}?${qs}`,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_delete_agent_secret failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_delete_agent_secret failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_add_agent_mcp_server': {
      const serverName = typeof args.serverName === 'string' ? args.serverName.trim() : '';
      const config = args.config && typeof args.config === 'object' ? args.config : null;
      if (!serverName) {
        return {
          content: [{ type: 'text', text: 'pc_add_agent_mcp_server: serverName required' }],
          isError: true,
        };
      }
      if (!config) {
        return {
          content: [{ type: 'text', text: 'pc_add_agent_mcp_server: config required (object)' }],
          isError: true,
        };
      }
      try {
        const id = await resolvePodId(agentArgs(args));
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_add_agent_mcp_server: ${id.error}` }],
            isError: true,
          };
        }
        const payload: Record<string, unknown> = {
          name: serverName,
          config,
          actor: 'orchestrator',
          reason: typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-add-server',
        };
        const res = await postServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/mcp-servers`,
          payload,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_add_agent_mcp_server failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_add_agent_mcp_server failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_open_agent_designer': {
      const initialIntent =
        typeof args.initialIntent === 'string' ? args.initialIntent : '';
      if (!initialIntent.trim()) {
        return {
          content: [
            { type: 'text', text: 'pc_open_agent_designer: initialIntent required' },
          ],
          isError: true,
        };
      }
      try {
        // 1. Start the transient session.
        const startRes = await postServer(
          projectPath('agent-designer/start'),
          {},
        );
        if (startRes.status < 200 || startRes.status >= 300) {
          return {
            content: [
              {
                type: 'text',
                text: `pc_open_agent_designer failed at start (${startRes.status}): ${startRes.body}`,
              },
            ],
            isError: true,
          };
        }
        // 2. Seed the first user message. CC takes a beat to be ready for
        //    input post-spawn; we don't wait for ready here — the modal's
        //    state event will catch the user up. The send call is queued
        //    by PtySession until the session can accept it.
        const sendRes = await postServer(projectPath('agent-designer/send'), {
          text: initialIntent.trim(),
        });
        if (sendRes.status < 200 || sendRes.status >= 300) {
          return {
            content: [
              {
                type: 'text',
                text: `pc_open_agent_designer failed at send (${sendRes.status}): ${sendRes.body}`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: 'Opened the agent-designer modal. The user is talking to agent-designer there; stay silent until pc_create_agent fires (project-agents-changed) or the user comes back here.',
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: `pc_open_agent_designer failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case 'pc_list_agent_audit': {
      try {
        const id = await resolvePodId(agentArgs(args));
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_list_agent_audit: ${id.error}` }],
            isError: true,
          };
        }
        const params: string[] = [];
        if (typeof args.actor === 'string' && args.actor.trim()) {
          params.push(`actor=${encodeURIComponent(args.actor.trim())}`);
        }
        if (typeof args.field === 'string' && args.field.trim()) {
          params.push(`field=${encodeURIComponent(args.field.trim())}`);
        }
        if (typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0) {
          params.push(`limit=${args.limit}`);
        }
        if (
          typeof args.beforeCreatedAt === 'number' &&
          Number.isFinite(args.beforeCreatedAt)
        ) {
          params.push(`beforeCreatedAt=${args.beforeCreatedAt}`);
        }
        const qs = params.length > 0 ? `?${params.join('&')}` : '';
        const res = await getServer(`/api/agents/pods/${encodeURIComponent(id.id)}/audit${qs}`);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_list_agent_audit failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_list_agent_audit failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_delete_agent_mcp_server': {
      const mcpServerId = typeof args.mcpServerId === 'string' ? args.mcpServerId.trim() : '';
      if (!mcpServerId) {
        return {
          content: [{ type: 'text', text: 'pc_delete_agent_mcp_server: mcpServerId required' }],
          isError: true,
        };
      }
      try {
        const id = await resolvePodId(agentArgs(args));
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_delete_agent_mcp_server: ${id.error}` }],
            isError: true,
          };
        }
        const reason =
          typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-delete-server';
        const qs = `actor=orchestrator&reason=${encodeURIComponent(reason)}`;
        const res = await deleteServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/mcp-servers/${encodeURIComponent(mcpServerId)}?${qs}`,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            {
              type: 'text',
              text: `pc_delete_agent_mcp_server failed (${res.status}): ${res.body}`,
            },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: `pc_delete_agent_mcp_server failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case 'pc_get_work_item': {
      const id = typeof args.id === 'string' ? args.id : '';
      const includeArchived = args.includeArchived === true;
      if (!id) {
        return { content: [{ type: 'text', text: 'pc_get_work_item: id required' }], isError: true };
      }
      try {
        const suffix = `work-items/${encodeURIComponent(id)}${includeArchived ? '?includeArchived=1' : ''}`;
        const res = await getServer(projectPath(suffix));
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_get_work_item failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_get_work_item failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_create_workflow': {
      const def = args.def && typeof args.def === 'object' ? args.def : null;
      if (!def) {
        return { content: [{ type: 'text', text: 'pc_create_workflow: def required' }], isError: true };
      }
      try {
        const res = await postServer(projectPath('workflows'), { def });
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

    case 'pc_edit_workflow': {
      const workflowId = typeof args.workflowId === 'string' ? args.workflowId : '';
      const def = args.def && typeof args.def === 'object' ? args.def : null;
      if (!workflowId) {
        return {
          content: [{ type: 'text', text: 'pc_edit_workflow: workflowId required' }],
          isError: true,
        };
      }
      if (!def) {
        return {
          content: [{ type: 'text', text: 'pc_edit_workflow: def required' }],
          isError: true,
        };
      }
      try {
        const res = await putServer(
          projectPath(`workflows/${encodeURIComponent(workflowId)}`),
          { def },
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_edit_workflow failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_edit_workflow failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_update_workflow_draft': {
      const def = args.def && typeof args.def === 'object' ? args.def : null;
      if (!def) {
        return {
          content: [{ type: 'text', text: 'pc_update_workflow_draft: def required' }],
          isError: true,
        };
      }
      const sessionId = process.env.PC_SESSION_ID ?? '';
      if (!sessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_update_workflow_draft: PC_SESSION_ID env not set (transient workflow-creator session is the only valid caller)',
            },
          ],
          isError: true,
        };
      }
      try {
        const res = await postServer(projectPath('workflow-creator/draft'), { sessionId, def });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_update_workflow_draft failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_update_workflow_draft failed: ${(err as Error).message}` },
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
            const project = JSON.parse(res.body) as { stages?: Array<{ id: string; name: string; order: number }> };
            const stages = (project.stages ?? []).map((s) => ({ id: s.id, name: s.name, order: s.order }));
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

    case 'pc_list_agents': {
      try {
        const res = await getServer(projectPath('agents'));
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_list_agents failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_list_agents failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_list_workflows': {
      try {
        const res = await getServer(projectPath('workflows'));
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

    case 'pc_attach_to_work_item': {
      const workItemId = typeof args.workItemId === 'string' ? args.workItemId : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const content = typeof args.content === 'string' ? args.content : '';
      const kind = typeof args.kind === 'string' && args.kind.trim() ? args.kind.trim() : 'markdown';
      const contentType = typeof args.contentType === 'string' ? args.contentType : undefined;
      const agentName = typeof args.agentName === 'string' ? args.agentName : undefined;
      const workflowRunId = typeof args.workflowRunId === 'string' ? args.workflowRunId : undefined;
      const nodeId = typeof args.nodeId === 'string' ? args.nodeId : undefined;
      if (!workItemId || !name || !content) {
        return {
          content: [
            { type: 'text', text: 'pc_attach_to_work_item: workItemId, name, and content required' },
          ],
          isError: true,
        };
      }
      try {
        const payload: Record<string, unknown> = {
          kind,
          name,
          content,
          source: 'agent',
        };
        if (contentType !== undefined) payload.contentType = contentType;
        if (agentName !== undefined) payload.agentName = agentName;
        if (workflowRunId !== undefined) payload.runId = workflowRunId;
        if (nodeId !== undefined) payload.nodeId = nodeId;
        const res = await postServer(
          projectPath(`work-items/${encodeURIComponent(workItemId)}/attachments`),
          payload,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_attach_to_work_item failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_attach_to_work_item failed: ${(err as Error).message}` }],
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
            { type: 'text', text: 'pc_invoke_agent: PC_PROJECT_ID not set — cannot route invoke' },
          ],
          isError: true,
        };
      }
      // Section 18.5a — forward the caller's CC sessionId so the route can
      // route terminal channel events back to the right orchestrator. PC sets
      // PC_SESSION_ID on every orchestrator spawn (project-runtime); child
      // MCP processes inherit it. Agents-as-callers also inherit
      // PC_DISPATCHER_SESSION_ID — when the orchestrator's sessionId isn't
      // in env, fall back to the dispatcher's so nested invocations route
      // to the original orchestrator (not the parent agent, which can't
      // process channel events itself).
      const dispatcherSessionId =
        process.env.PC_SESSION_ID || process.env.PC_DISPATCHER_SESSION_ID || '';
      if (!dispatcherSessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_invoke_agent: PC_SESSION_ID (orchestrator) or PC_DISPATCHER_SESSION_ID (agent) not set — cannot route terminal events back',
            },
          ],
          isError: true,
        };
      }
      const wait = args.wait === undefined ? undefined : args.wait === true;
      const parentWorkItemId =
        typeof args.parentWorkItemId === 'string' && args.parentWorkItemId.trim()
          ? args.parentWorkItemId.trim()
          : process.env.PC_AGENT_PARENT_WORK_ITEM_ID || undefined;
      // 16b.4.5 — forward the caller's depth so the route can enforce the
      // nesting cap. Orchestrator (no env var) → parentInvokeDepth=0; an
      // agent dispatched at depth N reports parentInvokeDepth=N. Malformed
      // values clamp at the route via `checkInvokeDepth`.
      const rawDepth = Number(process.env.PC_AGENT_INVOKE_DEPTH ?? '0');
      const parentInvokeDepth = Number.isFinite(rawDepth) && rawDepth > 0 ? Math.floor(rawDepth) : 0;
      const payload: Record<string, unknown> = { input, parentInvokeDepth, dispatcherSessionId };
      if (wait !== undefined) payload.wait = wait;
      if (parentWorkItemId) payload.parentWorkItemId = parentWorkItemId;
      try {
        const res = await postServer(
          `/api/projects/${PROJECT_ID}/agents/${encodeURIComponent(name)}/invoke`,
          payload,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_invoke_agent failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_invoke_agent failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_ask_orchestrator': {
      const question = typeof args.question === 'string' ? args.question.trim() : '';
      const context = typeof args.context === 'string' ? args.context : undefined;
      if (!question) {
        return {
          content: [{ type: 'text', text: 'pc_ask_orchestrator: question required' }],
          isError: true,
        };
      }
      // PC sets these at agent spawn time (16b.4). If they're not in env,
      // this isn't a paused-able agent — fail loud rather than mint a row
      // pointing at a session we can't resume.
      const agentName = process.env.PC_AGENT_NAME ?? '';
      const sessionId = process.env.PC_AGENT_SESSION_ID ?? '';
      if (!agentName || !sessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_ask_orchestrator: PC_AGENT_NAME / PC_AGENT_SESSION_ID not set — only agents spawned via pc_invoke_agent can pause-and-ask',
            },
          ],
          isError: true,
        };
      }
      const runId = process.env.PC_AGENT_RUN_ID || undefined;
      const parentWorkItemId = process.env.PC_AGENT_PARENT_WORK_ITEM_ID || undefined;
      // Section 18.5a — forward dispatcher's CC sessionId so the route can
      // emit the pause channel event back to the orchestrator that originally
      // dispatched this agent.
      const dispatcherSessionId = process.env.PC_DISPATCHER_SESSION_ID || '';
      if (!dispatcherSessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_ask_orchestrator: PC_DISPATCHER_SESSION_ID not set — agent runtime must thread the dispatcher session id through to enable channel routing',
            },
          ],
          isError: true,
        };
      }
      try {
        const payload: Record<string, unknown> = {
          sessionId,
          agentName,
          kind: 'ask-orchestrator',
          question,
          dispatcherSessionId,
        };
        if (context !== undefined) payload.context = context;
        if (runId !== undefined) payload.runId = runId;
        if (parentWorkItemId !== undefined) payload.parentWorkItemId = parentWorkItemId;
        const res = await postServer(projectPath('agent-pending-asks'), payload);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_ask_orchestrator failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_ask_orchestrator failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_ask_user': {
      const question = typeof args.question === 'string' ? args.question.trim() : '';
      const context = typeof args.context === 'string' ? args.context : undefined;
      const options = Array.isArray(args.options) ? args.options : undefined;
      if (!question) {
        return {
          content: [{ type: 'text', text: 'pc_ask_user: question required' }],
          isError: true,
        };
      }
      const agentName = process.env.PC_AGENT_NAME ?? '';
      const sessionId = process.env.PC_AGENT_SESSION_ID ?? '';
      if (!agentName || !sessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_ask_user: PC_AGENT_NAME / PC_AGENT_SESSION_ID not set — only agents spawned via pc_invoke_agent can pause-and-ask',
            },
          ],
          isError: true,
        };
      }
      const runId = process.env.PC_AGENT_RUN_ID || undefined;
      const parentWorkItemId = process.env.PC_AGENT_PARENT_WORK_ITEM_ID || undefined;
      const dispatcherSessionId = process.env.PC_DISPATCHER_SESSION_ID || '';
      if (!dispatcherSessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_ask_user: PC_DISPATCHER_SESSION_ID not set — agent runtime must thread the dispatcher session id through to enable channel routing',
            },
          ],
          isError: true,
        };
      }
      try {
        const payload: Record<string, unknown> = {
          sessionId,
          agentName,
          kind: 'ask-user',
          question,
          dispatcherSessionId,
        };
        if (context !== undefined) payload.context = context;
        if (options !== undefined) payload.options = options;
        if (runId !== undefined) payload.runId = runId;
        if (parentWorkItemId !== undefined) payload.parentWorkItemId = parentWorkItemId;
        const res = await postServer(projectPath('agent-pending-asks'), payload);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_ask_user failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_ask_user failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_request_approval': {
      const decision = typeof args.decision === 'string' ? args.decision.trim() : '';
      const context = typeof args.context === 'string' ? args.context : undefined;
      const options = Array.isArray(args.options) ? args.options : [];
      if (!decision) {
        return {
          content: [{ type: 'text', text: 'pc_request_approval: decision required' }],
          isError: true,
        };
      }
      if (options.length === 0) {
        return {
          content: [
            { type: 'text', text: 'pc_request_approval: options required (non-empty array)' },
          ],
          isError: true,
        };
      }
      const agentName = process.env.PC_AGENT_NAME ?? '';
      const sessionId = process.env.PC_AGENT_SESSION_ID ?? '';
      if (!agentName || !sessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_request_approval: PC_AGENT_NAME / PC_AGENT_SESSION_ID not set — only agents spawned via pc_invoke_agent can pause-and-ask',
            },
          ],
          isError: true,
        };
      }
      const runId = process.env.PC_AGENT_RUN_ID || undefined;
      const parentWorkItemId = process.env.PC_AGENT_PARENT_WORK_ITEM_ID || undefined;
      const dispatcherSessionId = process.env.PC_DISPATCHER_SESSION_ID || '';
      if (!dispatcherSessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_request_approval: PC_DISPATCHER_SESSION_ID not set — agent runtime must thread the dispatcher session id through to enable channel routing',
            },
          ],
          isError: true,
        };
      }
      try {
        const payload: Record<string, unknown> = {
          sessionId,
          agentName,
          kind: 'approval',
          // The pending-ask route uses `question` for the prose; we pass
          // the decision text under that field. The body builder labels it
          // "Approval requested:" so the orchestrator surface stays clear.
          question: decision,
          options,
          dispatcherSessionId,
        };
        if (context !== undefined) payload.context = context;
        if (runId !== undefined) payload.runId = runId;
        if (parentWorkItemId !== undefined) payload.parentWorkItemId = parentWorkItemId;
        const res = await postServer(projectPath('agent-pending-asks'), payload);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_request_approval failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_request_approval failed: ${(err as Error).message}` }],
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
          content: [{ type: 'text', text: 'pc_answer_pending: pendingAskId and answer required' }],
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
          content: [{ type: 'text', text: `pc_answer_pending failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_answer_pending failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`unknown tool: ${req.params.name}`);
  }
});

writeStatus();
const heartbeatTimer = setInterval(heartbeat, 2000);
heartbeatTimer.unref?.();

await server.connect(new StdioServerTransport());
