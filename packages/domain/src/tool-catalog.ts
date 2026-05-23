// Shared tool catalog — single source of truth for friendly labels +
// descriptions of every tool an agent can be granted in its allowlist.
//
// Two consumers:
//   1. Web UI (17d-v2 multi-select) — renders friendly label + dim slug +
//      description in the Settings tab tool picker.
//   2. MCP layer (17b agent-designer + orchestrator conversational tool
//      picks) — surfaces options by friendly name instead of raw slug.
//
// Entries are grouped by `source`. CC built-ins + the pc-rig server are
// always-on. Per-pod MCP servers added by the user fall through with a
// graceful `<slug>` rendering (no friendly name) until they're cataloged.

export type ToolCatalogSource = 'cc-builtin' | 'pc-rig' | 'mcp-server';

export interface ToolCatalogEntry {
  /** Wire slug — what gets written into the agent's tools allowlist. */
  slug: string;
  /** Short human-facing label. Sentence case, no period. */
  label: string;
  /** One-line description. Renders as help text under the label. */
  description: string;
  /** Where this tool comes from. Drives partitioning in the UI picker. */
  source: ToolCatalogSource;
  /** For `mcp-server` entries only — names the server (used for wildcards). */
  serverName?: string;
}

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  // --- CC built-ins -------------------------------------------------------
  {
    slug: 'Read',
    label: 'Read files',
    description: "Read text files from the project's worktree.",
    source: 'cc-builtin',
  },
  {
    slug: 'Glob',
    label: 'Find files by pattern',
    description: 'Find files matching a glob like **/*.ts.',
    source: 'cc-builtin',
  },
  {
    slug: 'Grep',
    label: 'Search file contents',
    description: 'Search file contents with regex (ripgrep-backed).',
    source: 'cc-builtin',
  },
  {
    slug: 'Edit',
    label: 'Edit files',
    description: 'Modify existing files in the worktree.',
    source: 'cc-builtin',
  },
  {
    slug: 'Write',
    label: 'Write new files',
    description: 'Create new files in the worktree.',
    source: 'cc-builtin',
  },
  {
    slug: 'Bash',
    label: 'Run shell commands',
    description: 'Execute arbitrary bash/shell commands.',
    source: 'cc-builtin',
  },
  {
    slug: 'NotebookEdit',
    label: 'Edit Jupyter notebooks',
    description: 'Modify .ipynb files cell-by-cell.',
    source: 'cc-builtin',
  },
  {
    slug: 'Task',
    label: 'Spawn sub-agents (Task tool)',
    description: "Use CC's built-in Task tool to spawn sub-agents.",
    source: 'cc-builtin',
  },
  {
    slug: 'WebFetch',
    label: 'Fetch a URL',
    description: 'Fetch a single web page or API endpoint.',
    source: 'cc-builtin',
  },
  {
    slug: 'WebSearch',
    label: 'Search the web',
    description: 'Run a web search query.',
    source: 'cc-builtin',
  },

  // --- pc-rig (PC's own MCP server) ---------------------------------------
  {
    slug: 'mcp__pc-rig__pc_log',
    label: 'Log to project (PC)',
    description: "Append a line to the project's MCP log.",
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_create_worktree',
    label: 'Create git worktree',
    description: "Open a sibling git worktree off the project's repo.",
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_list_worktrees',
    label: 'List git worktrees',
    description: 'List all worktrees attached to the project.',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_destroy_worktree',
    label: 'Remove git worktree',
    description: 'Tear down a worktree by name or path.',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_create_work_item',
    label: 'Create work item',
    description: "Make a new card in one of the project's stages.",
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_log_bug',
    label: 'Log a bug',
    description: "File a bug to the user's PC dogfood tracker.",
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_move_work_item',
    label: 'Move work item to a stage',
    description: 'Advance / move a card to a different stage.',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_update_work_item',
    label: 'Update work item',
    description: "Edit a card's title, body, fields, or status.",
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_get_work_item',
    label: 'Read a work item',
    description: "Fetch a card's full content + fields.",
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_list_work_items',
    label: 'List work items',
    description: "Find cards in this project by stage / parent / archive-state.",
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_attach_to_work_item',
    label: 'Attach run to work item',
    description: 'Bind the current dispatch to a specific card.',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_complete_node',
    label: 'Complete a workflow node',
    description: 'Report structured output from a workflow node.',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_node_failed',
    label: 'Report workflow node failure',
    description: 'Report a workflow node failure with a reason.',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_run_workflow',
    label: 'Run a workflow',
    description: 'Trigger a workflow by id.',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_create_workflow',
    label: 'Create a workflow',
    description: 'Author a new workflow YAML.',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_edit_workflow',
    label: 'Edit a workflow',
    description: "Modify a workflow's YAML (id-immutable).",
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_update_workflow_draft',
    label: 'Update a workflow draft',
    description: 'Save in-progress workflow-creator state.',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_list_stages',
    label: 'List project stages',
    description: "List the project's stages by id + label.",
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_list_agents',
    label: 'List available agents',
    description: 'List every pod the project can dispatch.',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_list_workflows',
    label: 'List workflows',
    description: "List the project's workflows.",
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_list_field_schemas',
    label: 'List field schemas',
    description: "List the project's per-stage card field schemas.",
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_write_claude_md',
    label: "Write project's CLAUDE.md",
    description: "Author or replace the project's CLAUDE.md.",
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_invoke_agent',
    label: 'Dispatch another agent',
    description: 'Spawn another pod by name with an input prompt.',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_ask_orchestrator',
    label: 'Ask the orchestrator',
    description: 'Pause and ask the project orchestrator a question.',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_ask_user',
    label: 'Ask the user',
    description: 'Pause and ask the human user a question (via orchestrator).',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_request_approval',
    label: 'Request approval',
    description: 'Pause and request explicit approval before proceeding.',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_answer_pending',
    label: 'Answer a pending ask',
    description: 'Reply to an earlier ask-orchestrator / ask-user / approval.',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_continue_agent',
    label: 'Continue an agent run',
    description: 'Resume a terminal AgentRun with a follow-up input.',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_list_my_runs',
    label: 'List my agent runs',
    description: "List recent agent runs YOU dispatched (scoped to caller's session).",
    source: 'pc-rig',
  },

  // --- pc-rig: pod CRUD (17b) ---------------------------------------------
  {
    slug: 'mcp__pc-rig__pc_create_agent',
    label: 'Create an agent pod',
    description: 'Author a new agent pod row (use for fresh-design flows).',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_get_agent',
    label: "Read an agent's config",
    description: 'Fetch a pod bundle: prompt + knowledge + secrets + MCP.',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_update_agent_prompt',
    label: "Update an agent's prompt",
    description: "Replace a pod's system prompt body.",
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_update_agent_settings',
    label: "Update an agent's settings",
    description: 'Change model / tools / effort / output destination etc.',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_delete_agent',
    label: 'Delete an agent pod',
    description: 'Soft-delete a non-stock pod.',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_create_knowledge',
    label: 'Add a knowledge doc',
    description: 'Attach a reference document to an agent.',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_update_knowledge',
    label: 'Update a knowledge doc',
    description: "Replace a knowledge doc's content.",
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_delete_knowledge',
    label: 'Delete a knowledge doc',
    description: 'Remove a knowledge doc from an agent.',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_knowledge_read',
    label: 'Read a knowledge doc',
    description: 'Runtime: pull a knowledge doc by id (worker agents).',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_create_agent_secret',
    label: 'Add an agent secret',
    description: 'Attach an env-var secret to an agent (plaintext v1).',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_delete_agent_secret',
    label: 'Remove an agent secret',
    description: 'Detach a secret env var from an agent.',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_add_agent_mcp_server',
    label: "Configure an agent's MCP server",
    description: 'Attach a per-pod MCP server config (gmail, jira, etc.).',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_delete_agent_mcp_server',
    label: "Remove an agent's MCP server",
    description: 'Detach a per-pod MCP server config.',
    source: 'pc-rig',
  },
  {
    slug: 'mcp__pc-rig__pc_list_agent_audit',
    label: "Read an agent's change history",
    description: "Inspect a pod's audit log (who changed what, when).",
    source: 'pc-rig',
  },

];

const BY_SLUG = new Map(TOOL_CATALOG.map((e) => [e.slug, e]));

/** Friendly label for a slug, or the slug itself if not cataloged. */
export function friendlyName(slug: string): string {
  return BY_SLUG.get(slug)?.label ?? slug;
}

/** One-line description for a slug, or null if not cataloged. */
export function descriptionOf(slug: string): string | null {
  return BY_SLUG.get(slug)?.description ?? null;
}

/** Full entry, or null. */
export function lookupTool(slug: string): ToolCatalogEntry | null {
  return BY_SLUG.get(slug) ?? null;
}
