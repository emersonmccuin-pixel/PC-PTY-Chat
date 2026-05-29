# System Map

Status: Phase 5 kickoff map.

Worktree: `E:\Claude Code Projects\Personal\PC-PTY-Chat-phase5`.

Branch: `codex/phase-5-hardening`.

Base: `dev` at `44980f1`.

## Package And Layer Map

| Layer | Path | Owns | Main consumers |
|---|---|---|---|
| Desktop shell | `apps/desktop` | Electron wrapper and packaged app shell | Human app runtime |
| Web UI | `apps/web` | React app, feature clients, chat/workflow/agent views | Browser renderer |
| Server | `apps/server` | Hono HTTP API, WebSocket composition, service wiring | Web UI, MCP bridge, channel server |
| MCP server | `packages/mcp` | `pc_*` tool metadata and handlers | Claude Code MCP runtime |
| Runtime | `packages/runtime` | PTY/session primitives, JSONL tailers, agent run state machine | Server services |
| DB | `packages/db` | Drizzle schema, migrations, repos | Server and MCP handlers |
| Domain | `packages/domain` | Shared product contracts and pure types | DB, runtime, server, web, MCP |
| Workflows | `packages/workflows` | Workflow graph validation/execution primitives | Server workflow services |
| Utils | `packages/utils` | Shared helpers | DB/server/runtime as needed |
| Channel server | `channel-server` | Separate channel package metadata | Runtime channel integration |

## Server Composition

`apps/server/src/index.ts` is now mostly boot, composition, static serving, registry setup, and route/WebSocket registration.

Feature route groups:

| Group | Registration | Main routes |
|---|---|---|
| MCP bridge | `features/mcp-bridge/routes.ts` | `/api/mcp-status`, `/api/internal/mcp-handshake` |
| Chat bridges | `features/chat-bridges/routes.ts` | `/api/ask`, `/api/subagent-transcript`, `/api/projects/:projectId/channel-send` |
| Settings/onboarding | `features/settings-onboarding/routes.ts` | settings, Claude profile, preflight, install/auth |
| Files | `features/files/routes.ts` | `/api/fs/*`, project tree and preview |
| Projects | `features/projects/routes.ts` | project list/create/update/delete/reveal |
| Workflows | `routes/workflow-routes.ts` | workflow CRUD, audit, duplicate, fire |
| Pods/agents | `routes/pod-routes.ts` | pod CRUD, stock reset, knowledge, secrets, MCP servers |
| Runtime host | `features/runtime-host/routes.ts` | active session, runtime snapshot, session replay, terminal transcript, new/resume, send queue retry/cancel |
| Project context | `features/project-context/routes.ts` | commands, memory, `CLAUDE.md` status/write |
| Transient sessions | `features/transient-sessions/routes.ts` | agent-designer, workflow-builder, setup-wizard start/send/interrupt/terminal/resize/stop |
| Work items | `features/work-items/routes.ts` | work item CRUD, legacy move/update, approvals, attachments, stages, field schemas |
| Workflow compatibility | `features/workflow-compat/routes.ts` | builder drafts, failed-run dismissals, v2 definitions/runs, review |
| Project worktrees | `features/project-worktrees/routes.ts` | worktree list/create/destroy |
| Agent runs | `features/agent-runs/routes.ts` | active/list/cancel, invoke, continue, pending asks, transcript events |
| Statusline | `features/statusline/routes.ts` | statusline snapshot, usage aggregate |
| Dev controls | `features/dev-controls/routes.ts` | status/restart endpoint; restart remains destructive and user-owned |

## Web Feature Map

Feature clients:

- `features/projects` owns project contracts/client.
- `features/runtime` owns orchestrator session, replay, runtime snapshot, send queue, terminal transcript client types, and web-side project WebSocket contracts.
- `features/transient-sessions` owns modal session HTTP client.
- `features/agent-runs` owns run list/cancel/invoke/continue/pending ask/transcript clients.
- `features/agents` owns pod/agent client contracts.
- `features/work-items` owns work item/stage/field/attachment contracts.
- `features/workflows` owns workflow client contracts.
- `features/files` owns file browser/tree/preview contracts.
- `features/project-context` owns memory/commands/Claude-md client contracts.
- `features/settings` owns settings/onboarding client contracts.
- `features/dev-controls` owns dev status/restart client contracts.
- `features/chat` owns chat surface rendering, composer actions, pending prompts, runtime thinking, terminal pane, JSONL normalization, tool grouping, approvals.

Top-level adapters and views:

- `hooks/use-project-ws.ts` owns active project WebSocket connection, heartbeat, outbound messages, diagnostics, and reducer dispatch.
- `hooks/use-all-projects-ws.ts` owns non-active project WebSocket subscriptions.
- `hooks/ws-heartbeat.ts` owns shared reconnect backoff, heartbeat timeout, and client ping helpers.
- `hooks/chat-session-reducer.ts` owns replay/dedupe/session ordering and materialized chat events.
- `features/runtime/ws-types.ts` owns web-side project WebSocket envelope, event, outbound message, status, and diagnostics contracts.
- `components/Orchestrator.tsx` coordinates runtime client, project WebSocket, chat surface, sessions, and status.
- `components/TransientAgentConversation.tsx`, `AgentDesignerChat.tsx`, `WorkflowBuilderChat.tsx`, and `SetupWizardModal.tsx` adapt transient modal sessions into chat.
- `components/ActivityPanel.tsx` and `AgentTranscriptModal.tsx` own agent run listing and transcript display.

## WebSocket And Event Surfaces

Primary UI socket:

- Server path: `/ws?projectId=<ULID>`.
- Server setup: `features/runtime-host/websocket-server.ts`.
- Subscriber hub: `services/websocket-hub.ts`.
- Connect snapshot: `features/runtime-host/websocket-connect.ts`.
- Message handler: `features/runtime-host/websocket-message.ts`.
- Client hook: `apps/web/src/hooks/use-project-ws.ts`.
- Client contract: `apps/web/src/features/runtime/ws-types.ts`.
- All-project sibling hook: `apps/web/src/hooks/use-all-projects-ws.ts`.

Inbound client messages:

- `send`: prompt text plus optional `clientMessageId`.
- `interrupt`: interrupts live PTY.
- `terminal-input`: raw terminal bytes.
- `resize`: terminal dimensions.
- `ask-reply`: pending ask answer.
- `client-ping`: app-level heartbeat expecting `server-pong`.

Core outbound envelopes:

- `session-changed`: active orchestrator session changed or initialized.
- `session-replay`: replay checkpoint with `sessionId`, `highWaterSeq`, and sequenced replay items.
- `runtime-state`: public runtime snapshot with health, wait point, replay cursor, JSONL cursor, queue depth.
- `send-ack`: prompt accepted, queued, rejected, or failed.
- `send-queue-snapshot`: current orchestrator send queue.
- `state`, `turn-end`, `event`, `jsonl`, `raw`, `exit`: PTY/hook/JSONL runtime stream.
- `server-pong`: heartbeat response.

Other broadcast envelopes:

- `work-items-changed`, `stages-changed`, `field-schemas-changed`.
- `workflow-changed`, `workflow-run-changed`, `workflow-builder-draft`.
- `pod-changed`.
- `agent-run-changed`, `agent-jsonl-event`, pending ask envelopes.
- `statusline-snapshot`.
- `project-claude-md-changed`.
- `channel-event`.

Channel server:

- `services/channel-server.ts` hosts `/channel-register` for child-process channel registration.
- Channel events are routed to registered children and echoed to the project UI through `channel-event`.

## Runtime/Chat Data Flow

1. Web opens `/ws?projectId=...`.
2. Server validates project and subscribes the socket in `ProjectWebSocketHub`.
3. Connect snapshot sends `session-changed`, optional live `state`, `runtime-state`, `session-replay`, and `send-queue-snapshot`.
4. Server starts or resumes the orchestrator PTY in the background when needed.
5. User prompt sends `send` with `clientMessageId`.
6. Server writes immediately when PTY is `ready` and no backlog exists; otherwise records `orchestrator_send_queue`.
7. Server responds with `send-ack` and broadcasts `send-queue-snapshot`.
8. PTY hooks and JSONL tailers emit `event`, `jsonl`, `raw`, `turn-end`, `state`, and refreshed `runtime-state`.
9. Web reducer dedupes by session sequence and replays checkpoints without duplicating live envelopes.

## MCP Tool Families

MCP root:

- `packages/mcp/src/server.ts` composes feature tools and dispatches handlers.
- `packages/mcp/src/tools/index.ts` re-exports feature tool modules.

Tool families:

| Module | Tools |
|---|---|
| `tools/work-items.ts` | `pc_create_work_item`, `pc_create_agent_work_item`, `pc_approve_work_item`, `pc_reject_work_item`, `pc_log_bug`, `pc_move_work_item`, `pc_update_work_item`, `pc_get_work_item`, `pc_list_work_items`, `pc_attach_to_work_item` |
| `tools/workflows.ts` | `pc_save_workflow_draft`, `pc_read_workflow_draft`, `pc_publish_workflow`, `pc_list_workflows`, `pc_fire_workflow`, `pc_complete_node`, `pc_node_failed`, `pc_create_workflow`, `pc_update_workflow`, `pc_delete_workflow`, `pc_get_workflow` |
| `tools/agent-runs.ts` | `pc_invoke_agent`, `pc_continue_agent`, `pc_list_my_runs`, `pc_ask_orchestrator`, `pc_ask_user`, `pc_request_approval`, `pc_answer_pending` |
| `tools/agents.ts` | `pc_create_agent`, `pc_get_agent`, `pc_update_agent_prompt`, `pc_update_agent_settings`, `pc_delete_agent`, knowledge tools, secret tools, agent MCP-server tools, audit/list tools |
| `tools/project-config.ts` | `pc_get_stages`, `pc_write_claude_md`, `pc_list_stages`, `pc_list_field_schemas`, `pc_replace_stages`, `pc_replace_field_schemas` |
| `tools/context.ts` | shared context helpers and runtime/tool-call context |

Catalog surface:

- `packages/domain/src/tool-catalog.ts` maps public `mcp__pc-rig__pc_*` slugs to product metadata.
- `apps/server/test/pod-tool-catalog-drift.test.ts` guards stock pod allowlists, orchestrator allowlist, and public tool catalog drift.

## DB Repo And Table Map

Schema files:

- `packages/db/src/schema.ts` owns core app tables.
- `packages/db/src/schema-agent-system.ts` owns agent-run system tables.

Core tables and repos:

| Area | Tables | Repos |
|---|---|---|
| Projects | `projects` | `repos/projects.ts` |
| Work items | `workItems`, `attachments`, `fieldSchemas` | `repos/work-items.ts`, `attachments.ts`, `field-schemas.ts` |
| Workflows | `workflows`, `workflowAudit`, `workflowRunsV2`, `workflowRunEvents`, `failedRunDismissals` | `workflows.ts`, `workflow-audit.ts`, `workflow-runs-v2.ts`, `failed-run-dismissals.ts` |
| Worktrees | `worktrees` | `worktrees.ts` |
| Orchestrator runtime | `orchestratorSessions`, `orchestratorSendQueue`, `postTurnSummaries` | `orchestrator-sessions.ts`, `orchestrator-send-queue.ts`, `post-turn-summaries.ts` |
| Agents/pods | `agents`, `agentKnowledge`, `agentSecrets`, `agentMcpServers`, `agentAudit` | `pods.ts`, `pod-revision.ts`, `pod-audit.ts` |
| Agent runs | `agentRuns`, `pendingAsks`, `agentInbox`, `agentDeliveryAudit` | `agent-runs.ts`, `pending-asks.ts`, `agent-inbox.ts` |
| Settings/statusline | `settingsGlobal`, `statuslineSnapshots` | `settings.ts`, `statusline-snapshots.ts` |

## Boundary Notes

- `apps/server/test/web-boundaries.test.ts` guards against resurrecting `components/ChatSurface.tsx`, direct `@/api/client` imports, and public contract exports from feature `client.ts` files.
- Web currently imports `@pc/domain` directly in some places; Phase 3 accepted browser-safe domain types instead of duplicating all contracts.
- Runtime primitives in `packages/runtime` are preserved and should not be replaced without a failing trace.
- `POST /api/dev/restart` exists but is explicitly outside normal agent operation.
