// Section 17a.5 — Static catalog of pc-rig tool names.
//
// The pod materialiser expands `mcp__pc-rig__*` wildcards in pod `tools:`
// allowlists into explicit names — CC's `tools:` frontmatter is exact-name
// match only, no wildcard support.
//
// Keep in sync with the `TOOLS` array in `packages/mcp/src/server.ts`. Drift
// surfaces as agents unable to call newly-added pc-rig tools (their allowlist
// won't include them); fix by appending here.

export const PC_RIG_TOOL_NAMES = [
  'mcp__pc-rig__pc_log',
  'mcp__pc-rig__pc_create_worktree',
  'mcp__pc-rig__pc_list_worktrees',
  'mcp__pc-rig__pc_destroy_worktree',
  'mcp__pc-rig__pc_create_work_item',
  'mcp__pc-rig__pc_log_bug',
  'mcp__pc-rig__pc_move_work_item',
  'mcp__pc-rig__pc_update_work_item',
  'mcp__pc-rig__pc_complete_node',
  'mcp__pc-rig__pc_node_failed',
  'mcp__pc-rig__pc_run_workflow',
  'mcp__pc-rig__pc_create_agent',
  'mcp__pc-rig__pc_get_work_item',
  'mcp__pc-rig__pc_create_workflow',
  'mcp__pc-rig__pc_edit_workflow',
  'mcp__pc-rig__pc_update_workflow_draft',
  'mcp__pc-rig__pc_write_claude_md',
  'mcp__pc-rig__pc_list_stages',
  'mcp__pc-rig__pc_list_agents',
  'mcp__pc-rig__pc_list_workflows',
  'mcp__pc-rig__pc_list_field_schemas',
  'mcp__pc-rig__pc_attach_to_work_item',
  'mcp__pc-rig__pc_invoke_agent',
  'mcp__pc-rig__pc_ask_orchestrator',
  'mcp__pc-rig__pc_ask_user',
  'mcp__pc-rig__pc_request_approval',
  'mcp__pc-rig__pc_answer_pending',
  // 17b additions — pod CRUD MCP tools
  'mcp__pc-rig__pc_get_agent',
  'mcp__pc-rig__pc_update_agent_prompt',
  'mcp__pc-rig__pc_update_agent_settings',
  'mcp__pc-rig__pc_delete_agent',
  'mcp__pc-rig__pc_create_knowledge',
  'mcp__pc-rig__pc_update_knowledge',
  'mcp__pc-rig__pc_delete_knowledge',
  'mcp__pc-rig__pc_knowledge_read',
  'mcp__pc-rig__pc_create_agent_secret',
  'mcp__pc-rig__pc_delete_agent_secret',
  'mcp__pc-rig__pc_add_agent_mcp_server',
  'mcp__pc-rig__pc_delete_agent_mcp_server',
  'mcp__pc-rig__pc_list_agent_audit',
  'mcp__pc-rig__pc_open_agent_designer',
] as const;
