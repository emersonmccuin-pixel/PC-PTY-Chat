# Holistic Architecture Synthesis

## 1. Executive Summary

Baseline:

| Field | Value |
|---|---|
| Date | 2026-05-30 |
| Branch | `dev` |
| Commit | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` |
| Inputs | Six priority subsystem handoffs plus `target-architecture.md` and `refactor-tracker.md` |
| Evidence rule | Current code is implementation truth. Prior handoffs are subsystem claims and recommendations. `archive/` was ignored. |

Overall system health:

- **Subsystem-doc claim:** The app has the right raw ingredients: Hono routes, SQLite repos, domain models, runtime wrappers, feature clients, MCP tools, and DB-backed records for sessions, runs, workflows, work items, and partial inbox delivery.
- **Verified fact:** The package tree currently has `agent-host`, `db`, `domain`, `mcp`, `runtime`, `utils`, and `workflows`; there is no `packages/contracts`, `packages/app-services`, `packages/live`, or `packages/mailbox`.
- **Synthesis:** The main problem is not missing functionality. It is that the command, event, delivery, and runtime ownership boundaries are not coherent across subsystems.

Major architectural problems:

- Shared contracts are missing, so web, server, MCP, runtime, and prompt text all hand-roll related schemas.
- Live WebSocket delivery is mostly a best-effort in-memory projection, not a durable fact stream.
- `ProjectRuntime` still owns too many unrelated runtime, workflow, transient-session, and product-service responsibilities.
- Agent asks, workflow reviews, external webhooks, chat asks, and channel messages are separate delivery concepts with overlapping behavior.
- Workflows and agents both create long-running work, but cancellation, recovery, transcript ownership, and active-handle ownership differ.
- MCP is a second product API over localhost HTTP instead of a thin adapter over shared command/query contracts.
- The current non-archive worktree has no test/spec files, while many historical tests appear deleted in `git status`.

Recommended target direction:

```text
shared contracts
  -> app services
  -> SQLite repos
  -> durable facts/outbox/mailbox rows
  -> live projection and typed clients
  -> runtime/MCP/UI adapters
```

Highest-risk areas:

1. Chat/runtime and transcript replay.
2. Channel removal and durable mailbox delivery.
3. Workflow run identity, cancellation, review state, and boot reconciliation.
4. Agent pause/resume, pending asks, host reattach, and delivery.
5. Canonical live event envelope and cursor replay.
6. Test restoration before behavior changes.

## 2. System Inventory

### Covered Priority Subsystems

| Subsystem | Purpose | Runtime process | Owned state today | Target recommendation |
|---|---|---|---|---|
| WebSocket/event propagation | Live UI projection for runtime and resource changes | Server and renderer | Socket subscribers, client buffers, reconnect epoch | Refactor into canonical live events plus durable outbox/replay; keep `/ws` as transport compatibility |
| Chat runtime and transcript UI | Primary orchestrator session, transcript, send queue, asks, terminal mode | Server, renderer, Claude/PTY child | `orchestrator_sessions`, `orchestrator_send_queue`, session JSONL/log files, chat UI projection | Split into conversation/session/send/replay services; add shared contracts and durable pending interactions |
| Agents and agent runs | Agent definitions, dispatch, pause/resume, verification, transcript, delivery | Server, optional agent-host, Claude child | `agent_runs`, `pending_asks`, pod tables, `agent_inbox` | Add agent-run app service/contracts; fix pending ask atomicity; migrate delivery to mailbox |
| Workflows and workflow builder | Workflow definitions, DAG runs, review, builder modal | Server, renderer, DB, child runtime work | `workflows`, `workflow_runs_v2`, `workflow_run_events`, in-memory builder drafts | Add definition/run/review/builder services; stable run identity; cancellation/recovery; shared contracts |
| MCP and tooling | Per-spawn `pc-rig` MCP server and tool calls | MCP child, server, Claude runtime | Live tool list, generated `mcp.json`, heartbeat file, pod tool allowlists | Keep stdio adapter; add capability registry and typed local API/shared contracts |
| Channel server replacement | Current dev-channel bridge and future message inbox | Server plus per-Claude channel bridge today; mailbox worker target | Channel registrants, `agent_inbox`, `pending_asks`, audit | Replace Channel with durable mailbox, UI inbox, and app-injected orchestrator turns |

### Missing Or Boundary-Unclear Subsystems

These should be incorporated into the refactor roadmap before implementation planning:

| Subsystem candidate | Why it is now in scope | Current tracker status |
|---|---|---|
| Shared contracts and app-service layer | Every completed doc depends on it before MCP/web/server drift can be fixed. | New candidate |
| Live event contracts and outbox | WebSocket, chat, agents, workflows, MCP mutations, mailbox, statusline, and project registry all need the same event envelope. | Already tracked, not started |
| Mailbox service and delivery workers | Channel replacement needs a real subsystem, not only a deletion plan. | Covered by Channel doc, but should be tracked explicitly as mailbox target |
| Runtime host and PTY sessions | Chat, transient sessions, worktrees, MCP readiness, agent host, and send queue all cross `ProjectRuntime`. | Already tracked, not started |
| Conversation/runtime transcript store | Chat and agent transcript surfaces need a shared replay and persistence decision. | New candidate |
| Pending interactions and approvals | Chat `/api/ask`, agent `pending_asks`, workflow review, and future UI inbox overlap. | New candidate or merge with human review inbox |
| Work items, stages, fields, attachments | Agents and workflows depend on work-item contracts, stage references, verification, attachments, and live updates. | Already tracked, not started |
| Project lifecycle and registry | Project create/update/delete/reorder currently lacks live-event coordination, but all sockets and project-scoped services depend on it. | Already tracked, not started |
| Project worktrees and path guard | Workflow execution, agent runs, verification, and runtime spawn use worktree/path boundaries. | Already tracked, not started |
| Transient sessions | Agent designer, workflow builder, and setup wizard repeat runtime/chat patterns with volatile state. | Already tracked, not started |
| MCP capability registry and external tool discovery | Tool availability is shared by MCP, pod settings, prompts, materializer, and UI labels. | New candidate or subpart of MCP |
| Statusline and usage telemetry | It already writes snapshots and broadcasts, but does not share contracts/live-event model. | Already tracked, not started |
| Desktop shell/dev controls | Lower priority, but server restart/dev-control paths must not be touched casually during runtime refactors. | Already tracked, not started |

## 3. Current Architecture Map

Verified composition facts:

- `apps/server/src/index.ts` is the composition root for `ProjectWebSocketHub`, runtime PTY handlers, `ChannelServer`, project registry, boot reattach, route registration, and dev controls.
- `ProjectWebSocketHub` is created at `apps/server/src/index.ts:168`; `broadcastTo` and `broadcastAll` are defined at `apps/server/src/index.ts:177` and `apps/server/src/index.ts:186`.
- `ChannelServer` is created at `apps/server/src/index.ts:263` and started at `apps/server/src/index.ts:281`.
- Older and newer route layouts coexist: feature routes under `apps/server/src/features/*`, plus legacy `apps/server/src/routes/pod-routes.ts` and `apps/server/src/routes/workflow-routes.ts`.
- `ProjectRuntime` exposes chat sessions, workflow firing, stage-entry triggers, transient assistant sessions, workflow builder drafts, and PTY lifecycle in one class (`apps/server/src/services/project-runtime.ts:91`, `:124`, `:290`, `:314`, `:433`, `:608`, `:889`, `:978`).

Major current flows:

```text
UI mutation
  -> web feature client or direct fetch
  -> Hono route
  -> repo/service write
  -> best-effort broadcastTo/broadcastAll
  -> feature hook patches or refetches
```

```text
Chat send
  -> /ws send message
  -> runtime-host websocket message handler
  -> ProjectRuntime.ensureActiveSession/ensurePty
  -> InteractiveSession/PTY
  -> provider JSONL tail
  -> jsonl-events.jsonl
  -> runtime-host pty handler broadcast
  -> chat reducer/renderer
```

```text
Agent dispatch
  -> MCP pc_invoke_agent or HTTP route
  -> agent-run factory/pod spawn
  -> agent_runs row and scratch files
  -> AgentRun or agent-host process
  -> agent-run-changed / agent-jsonl-event
  -> terminal effects, work-item verification, Channel/inbox delivery
```

```text
Workflow fire
  -> /api/workflows/:id/fire, MCP tool, or stage-entry trigger
  -> ProjectRuntime.fireV2Workflow
  -> workflow_runs_v2 row and dagState snapshot
  -> DagExecutor side effects
  -> work items, agents, shell/script steps, review prompts
  -> workflow-v2-run-changed and optional Channel prompt
```

```text
MCP tool call
  -> pc-rig stdio MCP server
  -> ToolContext raw localhost HTTP
  -> Hono route
  -> product write/read
  -> raw text response to Claude
```

```text
Channel delivery
  -> external POST or app enqueueAndPush
  -> ChannelServer registrant map and/or agent_inbox row
  -> per-Claude channel-server/server.js
  -> notifications/claude/channel
  -> <channel> block in provider JSONL
  -> chat parser/grouping
```

Dependency adjacency list:

| Node | Depends on / calls |
|---|---|
| Web UI | HTTP feature clients, `/ws`, Zustand stores, localStorage, raw WS envelopes |
| Server composition root | DB repos, project registry, runtime, ChannelServer, route modules, WebSocket hub |
| Runtime host / `ProjectRuntime` | `packages/runtime`, DB repos, pod materializer, workflows, worktrees, transient sessions, send queue |
| Agents | Pod repos, runtime spawn/host, MCP env, work items, Channel/inbox, live events |
| Workflows | DB workflows/runs, work items/stages, agents, worktrees, Channel review, MCP, live events |
| MCP | Runtime env, localhost HTTP routes, pod tool allowlists, MCP config, heartbeat files |
| Channel | Project slug/session identity, registrant sockets, Claude dev-channel MCP bridge, agent inbox |
| DB | Product records, runtime records, partial delivery records, audit snapshots |

## 4. Integration Matrix

| Subsystem | Inbound integrations | Outbound integrations | Coupling |
|---|---|---|---|
| WebSocket/event propagation | Runtime events, HTTP route broadcasters, Channel callback, statusline route, web sockets | React hooks, Zustand stores, feature refetches | High |
| Chat runtime | `/ws`, runtime HTTP routes, hook `/api/ask`, session switcher, terminal mode | DB sessions/send queue, session files, PTY, WebSocket, post-turn summaries | High |
| Agents | MCP tools, web Activity Panel, workflow subagents, verification review | `agent_runs`, `pending_asks`, `agent_inbox`, runtime/host, Channel, work items, WS | High |
| Workflows | `/api/workflows`, compat routes, MCP workflow tools, stage-entry moves, builder modal | `workflow_runs_v2`, work items, agents, worktrees, Channel review, WS | High |
| MCP/tooling | Claude MCP stdio, runtime spawn config, pod settings, status UI | Localhost HTTP routes, generated MCP config, heartbeat files, indirect DB/live writes | High |
| Channel/mailbox target | External `/channel`, bridge registration, agent delivery, workflow review | Claude dev channel, UI WS, `agent_inbox`, `pending_asks`, future mailbox | High |
| Work items/stages | UI, MCP, agents, workflows, attachments, verification | DB rows, stage changes, live events, workflow triggers | High |
| Project registry | UI project rail, all project-scoped routes, sockets, runtimes | `ProjectRuntime` instances, DB project rows, project files | Medium/High |
| Worktrees | Workflow runtime, agent runtime, project routes | Git commands, worktree DB rows, path guard | Medium/High |
| Transient sessions | Agent designer, workflow builder, setup wizard UI/MCP | PTY sessions, transient WS prefixes, in-memory drafts | High |
| Statusline/usage | Claude status hook/post, UI poll/hooks | DB snapshots, WS `statusline-snapshot`, Zustand usage view | Medium |

## 5. Shared State and Ownership

| State | Current owner | Recommended owner | Risk |
|---|---|---|---|
| Project records and active project registry | DB repos plus `ProjectRegistry`/web stores | Project app service plus feature client/live event | Project list changes are not consistently live-projected |
| Runtime sessions | `ProjectRuntime` plus `orchestrator_sessions` | Conversation/session service plus runtime-host adapter | Process and product lifecycle are mixed |
| Chat transcript events | Per-session `jsonl-events.jsonl` and provider JSONL | Conversation transcript repository, initially file-backed, later SQLite append table if chosen | Replay models differ across chat/agents |
| Send queue | `orchestrator_send_queue` plus WS handlers | Conversation send service | Mailbox orchestrator-turn delivery needs this as an app service |
| Live events | `ProjectWebSocketHub` and ad hoc event objects | `packages/live` or service plus DB outbox | Missed event recovery is inconsistent |
| Agent runs | Server services, runtime wrappers, optional host, `agent_runs` | AgentRunService plus runtime adapter/host | Pause/resume and host-mode rev consistency issues |
| Pending asks | Agent-run service table plus chat in-memory ask store | PendingInteractionService; mailbox delivers references | Multiple answer/ack models |
| Agent delivery | `agent_inbox` plus Channel push | MailboxService and delivery workers | Partial durability, no leases/retries/dead letters |
| Workflow definitions | `workflows` repo and routes | WorkflowDefinitionService | Slug identity and duplicate YAML mismatch risks |
| Workflow runs | `WorkflowRunWriter`, `DagExecutor`, route helpers | WorkflowRunService with active-handle registry | Cancellation/recovery/review validation gaps |
| Builder drafts | `ProjectRuntime.workflowBuilderDrafts` | WorkflowBuilderService; explicit transient or durable draft table | Volatile by accident unless documented |
| Worktrees | `WorktreeService`, runtime git primitive, DB worktree rows | Worktree app service or runtime-adjacent service | Filesystem/git side effects cross workflow/agent/runtime |
| Tool capabilities | MCP `TOOLS`, domain catalog, pod allowlists, web labels | Browser-safe capability registry | Drift breaks prompts, UI, runtime materialization |
| UI caches | Feature hooks, Zustand, localStorage | Feature hooks over typed clients and live events | Local state can mask source-of-truth drift |

## 6. Cross-Cutting Issues

1. **No shared contract layer.**
   - Verified: `packages/contracts` does not exist.
   - Impact: Web, server, MCP, runtime, and domain shapes drift, including pending asks, workflow events, agent DTOs, and tool schemas.

2. **Live events are not durable facts.**
   - Verified: `ProjectWebSocketHub` only owns in-memory subscribers and `broadcastAll`; no `live_events` or outbox table exists in the current package layout.
   - Impact: A committed DB write can be invisible to connected or reconnecting clients.

3. **Global events conflict with project-filtered clients.**
   - Verified: `broadcastAll` exists in `apps/server/src/services/websocket-hub.ts:62`; client hooks filter by `env.projectId` in `use-project-ws.ts:222` and `use-all-projects-ws.ts:192`.
   - Impact: Global workflow/pod updates are easy to drop unless each hook has a bespoke workaround.

4. **Runtime process ownership is too broad.**
   - Verified: `ProjectRuntime` owns chat session methods, workflow firing, transient sessions, and builder drafts.
   - Impact: Splitting any one feature risks changing unrelated runtime behavior.

5. **Delivery and pending-action semantics are fragmented.**
   - Verified: `pending_asks`, `agent_inbox`, `agent_delivery_audit`, chat in-memory asks, workflow review Channel posts, and external `/channel` all coexist.
   - Impact: "Waiting on a human/orchestrator" has no single lifecycle, retry, or UI surface.

6. **Workflows and agents share tables/events but not lifecycle ownership.**
   - Subsystem-doc claim: Workflow subagents write `agent_runs` but are not owned by the same active-run registry as normal agent runs.
   - Impact: Cancellation, transcript, recovery, and verification behavior diverge.

7. **MCP is a product API mirror.**
   - Verified: MCP tool handlers use `ToolContext` over localhost HTTP and hand-written payload checks.
   - Impact: Server route changes can silently break agents even when web UI keeps working.

8. **Identity is weak in several key places.**
   - Workflow runs use workflow slug identity; Channel recipients use `(projectId, sessionId)`; agent delivery uses dispatcher session; global/project pod resolution can drift by name/revision.
   - Impact: Durable records can be misattributed after duplicate, project override, resume, or session switch.

9. **Executable test coverage is absent from the current non-archive tree.**
   - Verified: `rg --files --glob "!archive/**" | rg "(test|spec)\\.(ts|tsx|js|mjs)$"` returned no files.
   - Impact: Any behavior refactor starts with high regression risk.

## 7. Architectural Invariants

Migration must preserve these behaviors:

- WebSocket connect must not spawn an orchestrator PTY by itself.
- One active orchestrator session per project remains enforced.
- Runtime chat replay must continue to load old `jsonl-events.jsonl` and legacy replay data until a deliberate migration removes it.
- `send` acknowledgements, queued sends, retries, and cancellation must remain session-scoped and idempotent.
- `intent=activity` must not become a runtime-spawning connection.
- Agent-run statuses remain closed-world: `queued`, `spawning`, `running`, `paused`, `completed`, `failed`, `cancelled`.
- Agent pending asks and workflow review decisions must be idempotent under repeated prompt/inbox actions.
- Existing `pc-rig` MCP server name and `pc_*` tool names need compatibility wrappers until all prompts and pod allowlists migrate.
- Workflow-driven work-item moves must not recursively fire stage-entry workflows unless product rules change explicitly.
- Project scoping must prevent cross-project data leaks in live events, mailbox delivery, MCP calls, and worktree paths.
- Channel is a deletion target, but existing Channel behavior must stay available until mailbox/UI inbox/orchestrator-turn replacements are implemented.

## 8. Target System Architecture

Recommended dependency direction:

```text
contracts
  -> domain
  -> db repos
  -> app services
  -> adapters: HTTP, MCP, runtime host, live events, web clients
```

Target subsystem boundaries:

| Boundary | Owns | Must not own |
|---|---|---|
| Contracts | DTOs, command/query schemas, event envelopes, result/error shapes | Business side effects |
| Domain | Pure product rules and state transitions | Hono, React, MCP stdio, filesystem process handles |
| DB repos | SQLite schema, migrations, transactions, row mapping | Route validation or UI behavior |
| App services | Commands/queries, transactions, outbox writes, idempotency | Socket registries, React state, raw PTY IO |
| Runtime host | Process spawn, PTY IO, JSONL tailing, readiness, health | Work-item/workflow/product mutation rules |
| Live | Canonical event envelope, outbox, cursor replay, fanout | Product writes or delivery acknowledgement |
| Mailbox | Messages, recipients, delivery attempts, leases, ack/read/dead-letter | Runtime lifecycle, prompt text as source of truth |
| MCP | Stdio adapter, tool formatting, typed local client | Product route duplication |
| Web | View state, feature hooks, typed clients, rendering | Backend paths in components, raw event schema ownership |

Keep:

- `ProjectWebSocketHub` transport as a compatibility fanout.
- `JsonlTailer`, `InteractiveSession`, and send queue concepts.
- `agent_runs`, `workflow_runs_v2`, `workflows`, `orchestrator_sessions`, work-item tables.
- `packages/workflows` as pure DAG logic.
- `pc-rig` MCP stdio process.

Split:

- `ProjectRuntime` into runtime host, conversation/session services, transient-session service, workflow runtime service hooks, and worktree access.
- Workflow definition, run, review, and builder services.
- Agent definition/pod service from agent-run service and runtime adapter.
- Generic live-event distribution from chat transport.

Replace:

- Channel/dev-channel delivery with mailbox, UI inbox, and app-injected runtime turns.
- Ad hoc WS envelopes with canonical events plus compatibility adapters.
- MCP hand-written payloads with shared contracts and typed client calls.

Delete after migration:

- `channel-server/server.js`, `/channel-register`, target use of `/channel/:slug/:source`, and `notifications/claude/channel`.
- Long-lived compatibility routes only after web, MCP, and prompts are moved.

## 9. Contract Registry

Contracts that need formalization before broad implementation:

| Contract | Current shape | Needed owner |
|---|---|---|
| Live event envelope | Ad hoc `{ type, ... }` objects | `packages/contracts/live-events.ts` |
| Project resource events | Some events, no project-list event | Project contracts plus live events |
| Runtime session DTOs | Server/web local runtime types | Runtime/conversation contracts |
| Transcript event/replay | `jsonl`, `session-replay`, `agent-jsonl-event`, direct file reads | Transcript/conversation contracts |
| Send queue commands | WS message handlers and route endpoints | Conversation send contracts |
| Agent run commands/results | MCP, routes, web DTOs | Agent-run contracts |
| Agent pending asks | MCP payloads, DB rows, web client drift | Pending interaction contracts |
| Workflow definition/run/review | `/api/workflows`, compat routes, MCP tools, local event types | Workflow contracts |
| Mailbox messages/recipients/delivery | `agent_inbox`, Channel text, external POST | Mailbox contracts |
| MCP capabilities | `TOOLS`, `TOOL_CATALOG`, pod allowlists, UI labels | Capability registry |
| Work item/stage/field/attachment | Domain/db/web route variants | Work-item contracts |
| Worktree commands | Runtime service, DB rows, project routes | Worktree contracts |
| Statusline/usage | Route-local/web-local shapes | Statusline contracts |

## 10. Conflict Resolution

| Conflict | Recommendation | Tradeoff |
|---|---|---|
| Runtime transcript storage: SQLite now vs file-backed adapter | Start with a `TranscriptRepository` abstraction that reads existing files and can mirror new events into SQLite later. | Preserves old sessions and reduces first migration risk; does not immediately solve all query/replay needs. |
| `pending_asks` ownership: mailbox vs agent-run | Keep pending-interaction state in an interaction/domain table; mailbox delivers references and UI/runtime actions. | Avoids making delivery own agent/run state; requires two linked records. |
| Global live events vs project-filtered sockets | Canonical events must include `scope: 'project' | 'global'` plus `projectId: null | ULID`; clients must explicitly accept scoped global events. | Requires adapter work, but removes ambiguous `broadcastAll` semantics. |
| `human-review` support | Reject or disable `human-review` publish/fire until mailbox-backed UI inbox exists; keep `orchestrator-review` as current working path. | Product limitation is explicit; avoids silently parking runs. |
| MCP direct app services vs typed localhost HTTP | Use a typed localhost client first because MCP is a separate process. Move to app services only for in-process adapters. | Keeps process boundary safe; app services still needed behind HTTP routes. |
| Workflow `workflow_run_events` source of truth | Keep it as audit/observability until a dedicated run-event service is designed; do not overload it as live outbox. | Avoids premature event-sourcing; leaves an explicit future decision. |
| Agent host mandatory or optional | Do not make it mandatory in the first plan. Define host-backed and in-process recovery semantics separately, then decide after agent-run service contracts exist. | Slower convergence, but lower runtime disruption. |
| Channel compatibility | Keep existing Channel paths as compatibility only until mailbox equivalents pass tests; do not add new Channel features. | Some duplicate paths during migration; target remains clean deletion. |
| Builder drafts durable or transient | Keep transient intentionally for now; if user expectations require persistence, add a draft table under WorkflowBuilderService. | Avoids accidental product commitment while making volatility explicit. |

## 11. Migration Roadmap

| Phase | Goal | Subsystems affected | Dependencies | Compatibility shims | Tests needed | Restart/reload | Risk |
|---|---|---|---|---|---|---|---|
| 0 | Restore or recreate focused tests and characterize current behavior | All priority subsystems | None | None | WS hub/hooks, runtime replay/send queue, pending asks, workflow identity/review/cancel, MCP tools, Channel delivery | Test process only | High value, low behavior risk |
| 1 | Establish shared contracts and capability registry skeleton | Web, server, MCP, agents, workflows, work items | Phase 0 preferred | Re-export old local types as aliases | Contract round-trip and parity tests | Build/reload only | Medium |
| 2 | Introduce app-service seams for low-risk resources | Projects/settings/work items first | Contracts | Routes delegate to services but keep endpoints | Command/query tests; live event emission tests | Server/web reload | Medium |
| 3 | Normalize live event envelope and outbox for non-runtime resources | WebSocket, projects, work items, pods, workflows, statusline | Contracts and services | Emit canonical plus legacy events | DB write -> outbox -> fanout -> replay; global event tests | DB migration/server/web reload | High |
| 4 | Harden workflow definition/run/review service boundaries | Workflows, work items/stages, agents, MCP, live | Phases 1-3 | Keep `/api/workflows` and compat routes | Stable run identity, duplicate rewrite, cancellation, boot reconcile, review validation | DB migration/server/web reload | High |
| 5 | Harden agent-run service boundaries | Agents, runtime, work items, MCP, live | Phases 1-3 | Keep current MCP/WS shapes | Pending ask atomicity, rev freshness, pause/cancel/resume, host/in-process recovery | Server/MCP/web reload | High |
| 6 | Add conversation/session/send/replay service boundaries | Chat, runtime host, live, statusline | Phases 0-3 | File replay adapter remains | New/resume/close, reconnect replay, send queue drain, ask durability | Server/web reload; DB if mirroring events | High |
| 7 | Introduce mailbox schema, UI inbox, and orchestrator-turn delivery worker | Channel, agents, workflows, chat, MCP, live | Contracts, runtime send service facade | Dual-write or bridge from `agent_inbox` | Enqueue/lease/ack/retry/dead-letter, UI inbox, runtime-turn ack | DB/server/web reload | High |
| 8 | Migrate agent and workflow delivery off Channel | Channel, agents, workflows, mailbox, chat parser | Phase 7 | Keep Channel fallback flag temporarily | Agent pause/terminal, workflow review, external webhook no-drop tests | Server/runtime reload | High |
| 9 | Split `ProjectRuntime` and standardize transient sessions/worktrees | Runtime host, transient sessions, worktrees, workflows, chat | Service contracts stable | Runtime facade keeps old route methods | PTY lifecycle, transient event, worktree/path guard tests | Server/runtime reload | High |
| 10 | Move MCP tools to typed contracts/client family by family | MCP, work items, workflows, agents, project config | Service/contract coverage | Existing `pc_*` names remain | MCP family integration tests | MCP rebuild/server reload | Medium/High |
| 11 | Remove obsolete compatibility paths | Channel, compat routes, legacy event shapes, stale prompts | All callers migrated | Feature flags only for rollback window | Static search plus integration suite | Server/runtime/web reload | High |

Rollback strategy:

- Keep legacy HTTP endpoints and legacy WS envelopes until each client family is migrated.
- Gate mailbox delivery cutovers by message kind.
- Keep file-backed transcript replay as fallback until migration validates old and new sessions.
- Do not delete Channel runtime until static search and integration tests prove no active callers remain.

## 12. Implementation Sequencing

Must happen first:

- Restore tests or create equivalent focused tests.
- Define shared contract package shape and import rules.
- Freeze new Channel uses and new ad hoc WS event families.
- Decide first canonical live event envelope and outbox table shape.

Can happen in parallel after Phase 1:

- Project/settings/work-item contract migration.
- Capability registry metadata extraction.
- Workflow definition service shell.
- Agent-run command service shell.
- Transcript repository interface.
- Mailbox schema design.

Should wait:

- Deep `ProjectRuntime` split until chat send/replay and live contracts are characterized.
- Channel deletion until mailbox UI inbox and orchestrator-turn delivery exist.
- MCP agent/workflow tool rewrites until those service contracts are stable.
- `human-review` enablement until durable review inbox exists.

Risky edits needing isolated PRs/checkpoints:

- Workflow run identity migration.
- Agent pending ask state machine changes.
- Runtime transcript storage changes.
- Send queue/orchestrator-turn delivery worker.
- Deleting dev-channel flags and channel bridge.
- Changes to `pc_*` tool results or tool names.

## 13. Test and Verification Strategy

System-level tests:

- DB mutation by HTTP, MCP, and UI path emits the same durable fact and live event.
- Socket disconnect during mutation, then reconnect, recovers visible state by cursor replay or deterministic refetch.
- Chat reconnect during a turn replays transcript and send queue without duplicate user rows.
- Agent pause answered twice remains idempotent and recoverable.
- Workflow review duplicate/wrong-node decisions are rejected.
- Mailbox message created while runtime is offline later delivers exactly once or dead-letters with audit.

Integration tests across boundaries:

- MCP `pc_create_work_item` -> route/service -> DB -> live event -> UI hook.
- MCP `pc_invoke_agent` -> agent run row -> Activity Panel event -> terminal delivery.
- Workflow fire -> agent subrun -> work-item verification -> workflow completion/failure.
- Workflow orchestrator-review -> mailbox or explicit unsupported error.
- External webhook with no active recipient -> queued/rejected by policy, never silently dropped.
- Project create/rename/delete/reorder -> project rail refresh in another client.

Manual dogfood checks:

- Two browser clients on one project, mutate work items, pods, workflows, and agent runs in one, verify the other updates.
- Refresh renderer mid-chat and mid-agent run, verify transcript, queue, and activity recover.
- Simulate Channel-disabled delivery after mailbox path exists and verify agent terminal/ask delivery still works.
- Run workflow with long shell command and cancel; active work must stop or show cancellation-requested/draining state.

Current coverage gap:

- No non-archive test/spec files are present in this checkout. Implementation planning should treat test restoration as Phase 0, not optional polish.

## 14. Observability and Debuggability

Add diagnostics around:

- Live events: event id, cursor, type, entity, project scope, replay count, dropped/invalid event reason.
- WebSocket sessions: connection id, project id, intent, last cursor, reconnect count, heartbeat age.
- Runtime sessions: session id, provider id, JSONL path/cursor, PTY state, send queue depth, ready-gate status.
- Agent runs: run id, host/in-process owner, status rev, PID, last activity, pause/ask id, delivery status.
- Workflow runs: run id, workflow row/version, active node states, cancellation status, review request id, active child process/run ids.
- Mailbox: message id, recipient id, delivery id, lease owner, attempts, next retry, ack/read state, dead-letter reason.
- MCP: process pid, heartbeat age, tool count, handshake owner, strict config errors, external server discovery status.

Debug surfaces:

- Admin/dev route or panel for live outbox cursor and replay.
- Mailbox inspector for pending/dead-letter messages.
- Runtime inspector that includes MCP ready-gate and send queue state.
- Agent/workflow run inspector that separates durable row state from active process handle state.

## 15. Tracker Update

This synthesis updates `refactor plan/refactor-tracker.md` by:

- Marking the six completed priority subsystem docs as `synthesized`.
- Marking `Holistic synthesis` as `synthesized`.
- Adding or updating follow-up subsystem candidates exposed by synthesis:
  - shared contracts and app-service layer;
  - mailbox service and delivery workers;
  - conversation/runtime transcript store;
  - pending interactions and approvals;
  - MCP capability registry and external tool discovery.
- Keeping unresolved decisions visible as open questions rather than silently resolving them inside one subsystem.

## 16. Open Questions and Decision Log

Blocking decisions:

- What exact `LiveEvent` envelope and cursor semantics ship first?
- Should `pending_asks` and chat asks share a `pending_interactions` table, with mailbox delivering references?
- What is the canonical mailbox recipient model: user, project inbox, orchestrator session, agent run, workflow run node, or typed union?
- What counts as acknowledgement for an app-injected orchestrator turn: queued in DB, written to PTY, observed in JSONL, or explicit tool ack?
- Should workflow run recovery after restart terminalize every active run, or support resumable active handles?
- Should `human-review` be disabled until a mailbox-backed UI inbox is built?

Non-blocking uncertainties:

- Whether runtime transcript events ultimately live in SQLite, files behind a repository, or both.
- Whether agent host should become mandatory for durable long-running agent survival.
- Whether builder drafts should become durable user-facing drafts.
- How much external MCP capability discovery is required before accepting config.
- Retention policy for live outbox, transcript events, mailbox audit, and dead letters.

Decision log:

| Decision | Status | Notes |
|---|---|---|
| Channel is a deletion target, not a new compatibility platform | Accepted by target architecture and Channel handoff | Build mailbox replacement before deleting current paths |
| WebSocket is projection/nudge, not source of truth | Accepted | Requires durable facts/outbox or deterministic query refetch |
| MCP keeps `pc-rig` and `pc_*` compatibility during migration | Accepted | Tool internals can move behind typed contracts |
| Start with typed localhost MCP client before direct app-service import | Recommended | MCP is a separate runtime process |
| Runtime transcript repository before storage migration | Recommended | Protects old sessions and lowers blast radius |
| `human-review` should not ship as silently actionable until inbox exists | Recommended | Reject or hide in validation/publish path |
| Current repo is the implementation target | Accepted | Build clean boundaries in this repo; use empty/scratch directories only for disposable spikes, not as the real refactor target |
