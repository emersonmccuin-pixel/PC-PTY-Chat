# Phase 2 MCP Tool Split Handoff

Prepared: 2026-05-27

Phase 1 server route extraction is complete. The next boundary pass is
`packages/mcp/src/server.ts`, currently about 3,546 lines with the tool
definitions, HTTP helpers, status heartbeat, and every `pc_*` handler in one
file.

## Goal

Split MCP tools into feature modules without changing wire behavior:

```text
packages/mcp/src/tools/
  work-items.ts
  agents.ts
  agent-runs.ts
  workflows.ts
  project-config.ts
  knowledge.ts
  index.ts
```

Keep the root `server.ts` responsible for:

- environment constants and status heartbeat
- MCP SDK `Server` construction
- `ListToolsRequestSchema` registration
- dispatching `CallToolRequestSchema` by tool name
- shared HTTP helper injection

## Progress

First slice complete:

- Added `packages/mcp/src/tools/context.ts` for injected HTTP/project context helpers.
- Added `packages/mcp/src/tools/work-items.ts` for the work-item tool definitions and dispatch handlers.
- Added `packages/mcp/src/tools/index.ts` as the tool module barrel.
- `packages/mcp/src/server.ts` now composes the extracted work-item tool definitions and delegates those nine handlers through `handleWorkItemTool`.
- Added focused tests in `packages/mcp/test/work-items-tools.test.ts`.

## Suggested First Slice

Start with a small, coherent tool family:

1. Extract shared HTTP/context helpers into `packages/mcp/src/tools/context.ts`.
2. Move work-item tools first:
   - `pc_create_work_item`
   - `pc_create_agent_work_item`
   - `pc_approve_work_item`
   - `pc_reject_work_item`
   - `pc_move_work_item`
   - `pc_update_work_item`
   - `pc_get_work_item`
   - `pc_list_work_items`
   - `pc_attach_to_work_item`
3. Add a focused test that:
   - exported tool names match the pre-split names for that family
   - unknown names fall through cleanly
   - one success and one error path preserve content/isError envelopes

## Current Tool Groups

The current switch cases in `packages/mcp/src/server.ts` are grouped enough to
split incrementally:

- Work items and agent contracts: `pc_create_work_item` through `pc_update_work_item`,
  plus `pc_get_work_item`, `pc_list_work_items`, `pc_attach_to_work_item`.
- Agent CRUD, secrets, MCP servers, audit, and knowledge: `pc_create_agent`
  through `pc_knowledge_read`, plus secret/MCP-server cases.
- Workflow drafts and workflow CRUD/fire/review: draft cases, `pc_publish_workflow`,
  `pc_fire_workflow`, `pc_complete_node`, and workflow row CRUD.
- Agent run dispatch and pending asks: `pc_invoke_agent`, `pc_continue_agent`,
  `pc_list_my_runs`, `pc_ask_orchestrator`, `pc_ask_user`,
  `pc_request_approval`, `pc_answer_pending`.
- Project config: stages, field schemas, `CLAUDE.md`.

## Verification Baseline

Before Phase 2, the repo was verified with:

- `pnpm --filter @pc/server typecheck`
- `pnpm --filter @pc/server test`
- `pnpm --filter @pc/mcp typecheck`
- `pnpm --filter @pc/web typecheck`
- `pnpm --filter @pc/desktop typecheck`
- `pnpm --filter @pc/domain test`
- `git diff --check`

Preserve the existing MCP response envelopes exactly. This includes returning
`content: [{ type: 'text', text }]` and `isError: true` in the same cases as
the current switch.
