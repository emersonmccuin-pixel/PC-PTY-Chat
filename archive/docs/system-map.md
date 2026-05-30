# Caisson System Map

Purpose: document the current subsystem patterns so foundational app changes can be discussed from the same map.

Status: branch `codex/architecture-refactor`, inspected 2026-05-29.

Target-state companion: `docs/target-architecture.md`.

Migration plan: `docs/architecture-migration-plan.md`.

## Short Answer

Caisson mostly follows one common pattern now, but not everywhere.

The converged pattern is:

```text
domain contract
  -> db schema/repo
  -> server feature route/service
  -> web feature client or websocket hook
  -> project-scoped websocket broadcast for live invalidation/state
  -> MCP tool proxy when agents need the same operation
```

The main exception is process/runtime work. Runtime subsystems still need an in-memory host:

```text
db row/session metadata
  -> ProjectRuntime / runtime package process wrapper
  -> PTY or LowLevelSpawn
  -> JSONL tailer and event normalization
  -> db cursor/state updates
  -> websocket broadcast and HTTP recovery endpoints
```

The codebase is not a pile of unrelated subsystem designs anymore. The remaining inconsistency is mostly boundary drift:

- some web types mirror older domain shapes and are stale;
- a few old UI calls still target removed routes (`/approval/respond`);
- `ProjectRuntime` still owns several different runtime concerns;
- MCP tools are split by family, but they proxy HTTP by hand rather than sharing typed clients/contracts.

## Hosts

| Host | Location | Port | Owns | Pattern |
|---|---|---:|---|---|
| API/static server | `apps/server/src/index.ts` | 4040 | Hono app, migrations, seeds, route composition, static web fallback, websocket setup | Composition root. Feature routes receive dependencies. |
| Runtime websocket | `apps/server/src/features/runtime-host/*` | 4040 `/ws` | Project chat transport, heartbeat, replay, prompt send, terminal input | WebSocket envelopes plus HTTP recovery routes. |
| Channel server | `apps/server/src/services/channel-server.ts` | 8788 | External `/channel/:slug/:source`, child registration, agent/orchestrator delivery | Legacy parallel delivery plane. Target replacement is durable mailbox plus websocket nudges. |
| Vite web | `apps/web` | 5173 | React UI in dev | Calls API and `/ws` on same origin/proxy. |
| Electron desktop | `apps/desktop/src/main.ts` | 4040 packaged | Dev points at Vite; packaged imports bundled server in-process | Thin shell. No renderer Node bridge except `pcDesktop`. |
| MCP server | `packages/mcp/src/server.ts` | stdio | `pc-rig` tools for Claude sessions | Tool modules proxy to API over localhost HTTP. |

## Persistence Pattern

All durable application data is in one SQLite database under `getDataDir()`:

```text
packages/db/src/schema.ts
packages/db/src/schema-agent-system.ts
packages/db/src/repos/*
```

Common DB conventions:

- ULID text primary keys.
- Epoch-ms integer timestamps.
- JSON stored through Drizzle `text({ mode: 'json' })`.
- Soft delete via `deleted_at` on user-facing rows.
- Repos are mostly per entity.
- `packages/db/src/index.ts` re-exports repo functions and namespace repos.

Main table families:

| Family | Tables | Repos |
|---|---|---|
| Projects | `projects` | `repos/projects.ts` |
| Work items | `work_items`, `attachments`, `field_schemas` | `work-items.ts`, `attachments.ts`, `field-schemas.ts` |
| Workflows | `workflows`, `workflow_audit`, `workflow_runs_v2`, `workflow_run_events`, `failed_run_dismissals` | `workflows.ts`, `workflow-audit.ts`, `workflow-runs-v2.ts`, `failed-run-dismissals.ts` |
| Orchestrator chat | `orchestrator_sessions`, `orchestrator_send_queue`, `post_turn_summaries` | `orchestrator-sessions.ts`, `orchestrator-send-queue.ts`, `post-turn-summaries.ts` |
| Agents/pods | `agents`, `agent_knowledge`, `agent_secrets`, `agent_mcp_servers`, `agent_audit` | `pods.ts`, `pod-audit.ts`, `pod-revision.ts` |
| Agent execution | `agent_runs`, `pending_asks`, `agent_inbox`, `agent_delivery_audit` | `agent-runs.ts`, `pending-asks.ts`, `agent-inbox.ts` |
| Worktrees | `worktrees` | `worktrees.ts` |
| Settings/usage | `settings_global`, `statusline_snapshots` | `settings.ts`, `statusline-snapshots.ts` |

## UI Communication Pattern

There are three UI communication paths.

| Path | Direction | Used for | Pattern |
|---|---|---|---|
| HTTP feature clients | Web -> server | CRUD, commands, recovery reads | `apps/web/src/features/<name>/client.ts` calls `apps/server/src/features/<name>/routes.ts` or `apps/server/src/routes/*`. |
| Project websocket | Server -> web and web -> runtime | Chat, runtime state, live changes, terminal input, ask replies | `useProjectWs()` opens `/ws?projectId=...`, reducer materializes chat session state. |
| All-project websocket fanout | Server -> web | Activity/global panels | `useAllProjectsWs()` opens one socket per non-active project. |

Common live envelopes include:

- `session-changed`, `session-replay`, `runtime-state`, `send-ack`, `send-queue-snapshot`
- `raw`, `state`, `event`, `jsonl`, `exit`, `turn-end`
- `work-items-changed`, `stages-changed`, `field-schemas-changed`, `attachment-changed`
- `workflow-changed`, `workflow-v2-run-changed`, `workflow-v2-review-pending`, `workflow-v2-human-hold`
- `pod-changed`
- `agent-run-changed`, `agent-jsonl-event`
- `channel-event`, `ask`, `statusline-snapshot`, `project-claude-md-changed`

## Subsystem Inventory

### Project Lifecycle

Ownership:

- Domain: `packages/domain/src/project.ts`
- DB: `projects`
- Server: `apps/server/src/features/projects/routes.ts`
- Services: `ProjectCreate`, `ProjectScaffold`, `ProjectRegistry`, `ProjectRuntime`
- Web: `apps/web/src/features/projects/client.ts`, project rail/components
- Live events: mostly returned through HTTP; project deletion removes runtime from registry.

Flow:

```text
web project client
  -> /api/projects*
  -> ProjectCreate / ProjectScaffold / projects repo
  -> ProjectRegistry register/refresh/remove
  -> ProjectRuntime per project
```

Pattern fit: strong. Project state uses DB rows plus `ProjectRegistry` as the in-memory runtime host.

Drift/risk:

- Project rename refreshes cached runtime state, but slug-based filesystem/worktree migration is deferred.
- Project filesystem deletion is route-owned and not a reusable project service.

### Runtime Host / Orchestrator Chat

Ownership:

- Domain: `orchestrator.ts`
- DB: `orchestrator_sessions`, `orchestrator_send_queue`, `post_turn_summaries`
- Server routes: `features/runtime-host/routes.ts`
- WS: `features/runtime-host/websocket-server.ts`, `websocket-connect.ts`, `websocket-message.ts`
- PTY handlers: `features/runtime-host/pty-handlers.ts`
- Services: `ProjectRuntime`, `OrchestratorRuntimeSnapshots`, `orchestrator-send-queue-delivery`, `session-replay`, `terminal-mode`
- Runtime package: `InteractiveSession`, `PtySession`, `JsonlTailer`
- Web: `use-project-ws.ts`, `chat-session-reducer.ts`, `features/chat/*`, `components/Orchestrator.tsx`

Flow:

```text
web ChatSurface
  -> useProjectWs /ws?projectId
  -> runtime-host websocket
  -> ProjectRuntime.ensurePty()
  -> InteractiveSession / Claude PTY
  -> JSONL tailer and hook events
  -> db cursor/session/send-queue updates
  -> ProjectWebSocketHub broadcast
  -> chat reducer and ChatSurface
```

HTTP recovery routes cover current session, runtime snapshot, replay, terminal transcript, new session, resume session, send-queue cancel/retry.

Pattern fit: strong but specialized. This is the most complete runtime pattern and should be the reference for other live-process subsystems.

Drift/risk:

- Runtime state is split between DB rows, `ProjectRuntime`, PTY state, JSONL cursor, and browser reducer. The snapshot service is the public truth, but internals remain multi-source.
- `ProjectRuntime` still owns orchestrator runtime plus transient sessions plus workflow/project services.

### Transient Sessions

Ownership:

- Server routes: `features/transient-sessions/routes.ts`
- Runtime host: `ProjectRuntime.startAgentDesigner`, `startWorkflowBuilder`, `startSetupWizard`
- Runtime package: `PtySession`
- Web client: `features/transient-sessions/client.ts`
- Web surfaces: `CreatePodModal`/`AgentDesignerChat`, `WorkflowBuilderModal`/`WorkflowBuilderChat`, `SetupWizardModal`, `TransientAgentConversation`
- Live events: `agent-designer-*`, `workflow-builder-*`, `setup-wizard-*`, normalized into chat envelopes in the modal components.

Flow:

```text
web modal start
  -> /api/projects/:id/<transient>/start
  -> ProjectRuntime starts session-local PTY
  -> route attaches common handlers
  -> prefixed WS events
  -> modal adapter converts to ChatSurface events
```

Pattern fit: medium. Server-side route registration is standardized with descriptors. UI still has per-modal event adapters.

Drift/risk:

- Transient sessions do not have DB session rows; they are process/runtime only with per-session files.
- Event prefixes differ from orchestrator envelopes and must be adapted in each modal.
- Setup wizard uses runtime-file prompt append, while agent-designer and workflow-builder use pod materialization.

### Work Items, Stages, Fields, Attachments

Ownership:

- Domain: `work-item.ts`, `work-item-contract.ts`, `field-schema.ts`, `attachment.ts`
- DB: `work_items`, `attachments`, `field_schemas`, project `stages`
- Server: `features/work-items/routes.ts`
- Services: `WorkItemService`, `AttachmentService`, `FieldSchemaService`, agent verification services
- Web: `features/work-items/client.ts`, kanban/table/detail/project settings components
- MCP: `packages/mcp/src/tools/work-items.ts`, parts of `project-config.ts`
- Live events: `work-items-changed`, `stages-changed`, `field-schemas-changed`, `attachment-changed`

Flow:

```text
web/MCP
  -> project work-item routes
  -> ProjectRuntime.workItemService()
  -> db repos and domain validation
  -> optional workflow stage-on-entry fire
  -> WS invalidation event
  -> web refetch/update
```

Pattern fit: strong for live work-item behavior.

Drift/risk:

- Web `WorkItemStatus` omits `awaiting-verification` and `cancelled`, which domain supports.
- Legacy routes `/work-items/move` and `/work-items/update` coexist with versioned routes.

### Workflows

Ownership:

- Domain: `workflow-v2.ts`, `workflow-row.ts`, legacy `workflow.ts`
- Pure workflow logic: `packages/workflows/src/dag/*`, `serialize-v2.ts`, `registry-v2.ts`
- DB: `workflows`, `workflow_audit`, `workflow_runs_v2`, `workflow_run_events`, `failed_run_dismissals`
- Server routes: `apps/server/src/routes/workflow-routes.ts`, `features/workflow-compat/routes.ts`
- Runtime services: `dag-run-service.ts`, `dag-executor.ts`, `workflow-import.ts`
- Web: `features/workflows/client.ts`, `WorkflowsList`, `WorkflowGraphV2`, `WorkflowBuilderModal`
- MCP: `packages/mcp/src/tools/workflows.ts`
- Live events: `workflow-changed`, `workflow-builder-draft`, `workflow-v2-run-changed`, `workflow-v2-review-pending`, `workflow-v2-human-hold`

Flow:

```text
web/MCP authoring
  -> /api/workflows or workflow-builder draft routes
  -> workflows repo validates/parses/audits
  -> workflow-changed broadcast

fire/run
  -> ProjectRuntime.fireV2Workflow()
  -> fireDagWorkflow()
  -> workflow_runs_v2 row + root work item
  -> DagExecutor with injected live deps
  -> agent/work-item/worktree/channel side effects
  -> run state/event persistence and WS broadcasts
```

Pattern fit: medium-high. The pure DAG core is cleanly separated from live deps. The route layer still has both promoted workflow routes and compatibility routes.

Drift/risk:

- Legacy workflow compatibility endpoints remain for `/workflow-v2/*`.
- Old approval UI still calls `/api/projects/:projectId/approval/respond`; current route is `/api/projects/:projectId/workflow-v2/review`.
- Workflow builder has both chat-driven draft state and graph state; the draft is transient runtime memory, not DB.

### Agents / Pods / Tool Catalog

Ownership:

- Domain: `agent.ts`, `pod.ts`, `tool-catalog.ts`, `agent-body.ts`
- DB: `agents`, `agent_knowledge`, `agent_secrets`, `agent_mcp_servers`, `agent_audit`
- Server routes: `apps/server/src/routes/pod-routes.ts`
- Services: `stock-pod-seed`, `stock-pod-reset`, `pod-drift`, `pod-spawn`, `pod-tool-catalog`
- Runtime package: `pod-materializer.ts`
- Web: `features/agents/client.ts`, `AgentsList`, pod settings/detail components
- MCP: `packages/mcp/src/tools/agents.ts`
- Live events: global `pod-changed`

Flow:

```text
web/MCP pod CRUD
  -> /api/agents/pods*
  -> pod repos and audit rows
  -> pod-changed global broadcast
  -> materialized into session-local plugin at spawn time
```

Pattern fit: strong. Agents/pods mirror workflows: scoped DB rows, audit rows, web client, MCP tools, runtime materialization.

Drift/risk:

- Routes are still in `apps/server/src/routes/pod-routes.ts`, not under `features/agents`.
- Stock pod seeding is boot-time and has domain behavior embedded in service constants.
- Tool lifecycle is inferred from catalog/allowlists, not explicit metadata.

### Agent Runs / Pending Asks / Delivery

Ownership:

- Domain: `agent-system.ts`, `agent-comms.ts`
- DB: `agent_runs`, `pending_asks`, `agent_inbox`, `agent_delivery_audit`
- Server routes: `features/agent-runs/routes.ts`
- Services: `agent-run-factory`, `pause-resume`, `agent-active-runs`, `agent-delivery`, `agent-audit`, `agent-verification`
- Runtime package: `AgentRun`, `AgentRunRegistry`, `LowLevelSpawn`, `AgentRunJsonlTailer`
- Web: `features/agent-runs/client.ts`, `ActivityPanel`, `AgentTranscriptModal`
- MCP: `tools/agent-runs.ts`
- Channel: `ChannelServer.emitToSession`, inbox drain on child registration
- Live events: `agent-run-changed`, `agent-jsonl-event`, channel events to orchestrator

Flow:

```text
MCP pc_invoke_agent or HTTP invoke
  -> agent-runs route
  -> dispatchFreshAgent()
  -> insert agent_runs row
  -> materialize pod
  -> AgentRun state machine and cap registry
  -> JSONL/live events
  -> terminal persistence, verification, inbox/channel delivery
  -> WS Activity Panel events
```

Pause/resume flow:

```text
agent MCP ask/approval tool
  -> pending ask route
  -> pending_asks row + AgentRun paused
  -> inbox/channel event to dispatcher
  -> user/orchestrator answer route
  -> pending_asks answered + AgentRun resumes
```

Pattern fit: strong but complex. This subsystem has the clearest explicit state machine.

Drift/risk:

- `PC_AGENT_SESSION_ID` still maps to CC session id in env comments, while a future design wants agent_run_id.
- Active run state is in memory; boot reconciles orphan rows to failed.
- Transcript backfill reads JSONL from provider session path, not from a DB event store.

### MCP Tool Server

Ownership:

- Host: `packages/mcp/src/server.ts`
- Tools: `packages/mcp/src/tools/*`
- Catalog: `packages/domain/src/tool-catalog.ts`
- Server bridge: HTTP calls to API server through `ToolContext`
- Status: `mcp-status.json` under project data

Flow:

```text
Claude tool call
  -> pc-rig MCP stdio server
  -> feature handler switch
  -> ToolContext localhost HTTP call
  -> API route/service/db/runtime
  -> text result back to Claude
```

Pattern fit: medium. Tool definitions are split by feature, but the handler layer hand-builds HTTP requests and response strings.

Drift/risk:

- Tool contracts are JSON schemas separate from server route types and web types.
- Catalog is manually maintained, with drift tests protecting public `pc-rig` tools.
- MCP is not sharing web feature clients or generated contracts.

### Files, Project Context, Settings, Onboarding

Ownership:

- Files routes: `features/files/routes.ts`, services `fs-browse`, `fs-probe`, `files-tree`
- Project context routes: `features/project-context/routes.ts`, services `memory-files`, `custom-commands`
- Settings/onboarding routes: `features/settings-onboarding/routes.ts`, services `preflight`, `onboarding-install`, `onboarding-auth`
- DB: `settings_global`; project context mostly filesystem
- Web: `features/files`, `features/project-context`, `features/settings`
- MCP: `pc_write_claude_md`, stage/field-schema config tools
- Live events: `project-claude-md-changed`

Flow:

```text
web settings/files/context client
  -> server feature route
  -> DB or contained filesystem service
  -> optional broadcast
```

Pattern fit: medium-high. These are simpler request/response subsystems.

Drift/risk:

- Some filesystem operations are route-level commands rather than cohesive services.
- Onboarding installer reaches the network and host system, unlike most local-first operations.

### Statusline / Usage

Ownership:

- Domain: `statusline.ts`, settings usage fields
- DB: `statusline_snapshots`
- Server: `features/statusline/routes.ts`
- Web: `store/statusline.ts`, `use-statusline-sync.ts`, `UsageCapsPanel`, global usage hook
- Live events: `statusline-snapshot`

Flow:

```text
Claude/statusline bridge
  -> POST /api/internal/statusline-data
  -> statusline snapshot repo
  -> statusline-snapshot broadcast
  -> web store/hooks
```

Pattern fit: strong for telemetry.

Drift/risk:

- Web store comments say it mirrors domain types, so this is another manual contract mirror.

### Project Worktrees

Ownership:

- Domain: `worktree.ts`
- DB: `worktrees`
- Server: `features/project-worktrees/routes.ts`
- Services: `WorktreeService`
- Runtime package: `worktree.ts`
- Web: called by workflow/work item surfaces as needed

Flow:

```text
web/server workflow or work-item operation
  -> ProjectRuntime.worktrees()
  -> WorktreeService
  -> git worktree operation + worktrees repo
```

Pattern fit: medium. It has DB tracking plus filesystem/git side effects.

Drift/risk:

- Worktree operations are inherently host-stateful; DB and filesystem can drift.
- Cleanup/destruction needs careful coordination and should remain isolated.

### Channel / Chat Bridges

Target direction: retire Channel as a primary subsystem. Replace it with a durable mailbox/delivery system where Channel is only a compatibility adapter during migration.

Ownership:

- Channel server: `services/channel-server.ts`
- Chat bridge routes: `features/chat-bridges/routes.ts`
- MCP bridge routes: `features/mcp-bridge/routes.ts`
- Delivery: `agent-delivery.ts`, inbox repos
- Web: transcript viewer, channel-send test/proxy, ask rendering

Flow:

```text
external POST or server synthesized event
  -> ChannelServer
  -> registered CC child for project/session
  -> optional inbox durability
  -> project WS channel-event broadcast
```

Target flow:

```text
sender
  -> mailbox enqueue
  -> durable message/recipient rows
  -> recipient lease/poll or websocket nudge
  -> recipient ack/fail
  -> retry, dead-letter, or complete
  -> canonical live event
```

Pattern fit: specialized. It is a second host because child Claude sessions register independently of the main UI websocket.

Drift/risk:

- It is a parallel communication plane next to `/ws`; useful, but needs explicit boundaries because agents, workflows, asks, and orchestrator all depend on it.
- It should not remain the durable delivery primitive. Delivery should be mailbox-first so offline recipients, reconnect, retries, and audit have one source of truth.

### Desktop And Dev Controls

Ownership:

- Desktop: `apps/desktop/src/main.ts`, `preload.ts`, packaging scripts
- Dev controls: `features/dev-controls/routes.ts`, `features/dev-controls/client.ts`
- Build/staging: `apps/desktop/scripts/*`

Flow:

```text
dev desktop
  -> Electron loads Vite URL

packaged desktop
  -> Electron sets PC_ROOT/PC_DATA_DIR
  -> imports bundled server.mjs in-process
  -> loads http://127.0.0.1:4040
```

Pattern fit: separate host pattern, intentionally thin.

Drift/risk:

- Dev restart endpoint is destructive and must stay gated/isolated.
- Packaged mode imports the server bundle directly, so server module evaluation is app boot.

## Web Layer Pattern

Current web pattern:

```text
apps/web/src/features/<feature>/types.ts
apps/web/src/features/<feature>/client.ts
apps/web/src/hooks/use-*.ts
apps/web/src/components/*
```

What is consistent:

- `apps/web/src/api/client.ts` is now a compatibility barrel.
- Live web sources do not import `@/api/client` directly.
- Most HTTP calls sit behind feature clients and `api/http.ts`.
- Chat UI has been split into `apps/web/src/features/chat/*`.

What is inconsistent:

- Several clients still call `fetch` directly for richer error handling. That is acceptable, but should be a deliberate client-layer pattern.
- Components still make direct fetches in places, notably transcript and approval UI.
- Web imports `@pc/domain` directly for workflow graph types in a few components.

## Route Group Map

| Route group | Server owner | Web/MCP owner |
|---|---|---|
| `/api/projects*` | `features/projects/routes.ts` | `features/projects/client.ts` |
| `/api/fs/*`, `/api/projects/:id/files/*` | `features/files/routes.ts` | `features/files/client.ts` |
| `/api/projects/:id/session*`, `/orchestrator/runtime`, `/sessions*`, `/send-queue*` | `features/runtime-host/routes.ts` | `features/runtime/client.ts`, `useProjectWs` |
| `/ws` | `features/runtime-host/websocket-server.ts` | `useProjectWs`, `useAllProjectsWs` |
| `/api/projects/:id/agent-designer|workflow-builder|setup-wizard/*` | `features/transient-sessions/routes.ts` | `features/transient-sessions/client.ts` |
| `/api/projects/:id/work-items*`, `/stages`, `/field-schemas`, `/attachments` | `features/work-items/routes.ts` | `features/work-items/client.ts`, MCP work-item/project-config tools |
| `/api/workflows*` | `routes/workflow-routes.ts` | `features/workflows/client.ts`, MCP workflow tools |
| `/api/projects/:id/workflow-v2/*`, workflow-builder draft, failed-run dismissals | `features/workflow-compat/routes.ts` | workflow UI and MCP workflow-builder tools |
| `/api/agents/pods*` | `routes/pod-routes.ts` | `features/agents/client.ts`, MCP agent tools |
| `/api/projects/:id/agent-runs*`, `/agents/:name/invoke`, `/agent-pending-asks*` | `features/agent-runs/routes.ts` | `features/agent-runs/client.ts`, MCP agent-run tools |
| `/api/projects/:id/worktrees*` | `features/project-worktrees/routes.ts` | project/workflow worktree surfaces |
| `/api/projects/:id/commands`, `/memory`, `/claude-md*` | `features/project-context/routes.ts` | `features/project-context/client.ts`, MCP `pc_write_claude_md` |
| `/api/settings`, `/api/preflight`, `/api/onboarding/*` | `features/settings-onboarding/routes.ts` | `features/settings/client.ts` |
| `/api/internal/statusline-data`, `/api/usage/aggregate`, `/statusline` | `features/statusline/routes.ts` | statusline stores/hooks |
| `/api/mcp-status`, `/api/internal/mcp-handshake` | `features/mcp-bridge/routes.ts` | MCP runtime and settings surfaces |
| `/api/ask`, `/api/subagent-transcript`, `/channel-send` | `features/chat-bridges/routes.ts` | chat/transcript/channel test surfaces |
| `/api/dev/*` | `features/dev-controls/routes.ts` | `features/dev-controls/client.ts` |

## Pattern Drift To Resolve Before Foundational Changes

High confidence drift:

1. `apps/web/src/features/chat/approvals.tsx` posts to `/api/projects/:projectId/approval/respond`, while the server comment says v2 review responses go through `/api/projects/:projectId/workflow-v2/review`.
2. Web work-item types do not match domain work-item status/fields.
3. Web statusline and several feature types still mirror domain/server shapes manually.

Structural drift:

1. `ProjectRuntime` is still a multi-subsystem host: orchestrator PTY, transient PTYs, worktrees, work items, attachments, field schemas, workflow firing.
2. Pod and workflow route modules still live in `apps/server/src/routes/*` while newer route groups live in `apps/server/src/features/*`.
3. MCP tool contracts, web client contracts, and server request bodies are maintained separately.
4. Runtime events use several envelope families: orchestrator generic envelopes, transient prefixed envelopes, channel events, and agent-run events.
5. Channel is a parallel delivery plane; target architecture replaces it with durable mailbox delivery.

## Recommended Foundation Direction

Do not rewrite the app. Standardize the live pattern that already exists.

Target feature cartridge:

```text
packages/domain/src/<subsystem>.ts
packages/db/src/repos/<subsystem>.ts
apps/server/src/features/<subsystem>/routes.ts
apps/server/src/services/<subsystem>.ts
apps/web/src/features/<subsystem>/types.ts
apps/web/src/features/<subsystem>/client.ts
apps/web/src/features/<subsystem>/hooks.ts
packages/mcp/src/tools/<subsystem>.ts
```

For runtime cartridges, add an explicit host interface:

```text
db session/run row
  -> host snapshot service
  -> process wrapper
  -> event tailer
  -> persisted cursor/state
  -> canonical websocket envelopes
  -> HTTP replay/recovery endpoint
```

Near-term cleanup order:

1. Fix approval UI to target the v2 review route or remove the old approval bubble path.
2. Make web feature types import shared browser-safe domain contracts, or create a generated/shared contracts package.
3. Move pod/workflow routes under `features/*` to match the current route-module convention.
4. Extract transient-session UI adapters so all modal sessions consume the same envelope/snapshot contract.
5. Design mailbox delivery and move Channel behind it as a compatibility adapter.
6. Split `ProjectRuntime` into smaller hosts only after each runtime, replay, and mailbox contract is written and tested.
