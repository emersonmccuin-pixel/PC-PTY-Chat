# UI Refresh, WebSocket, and Event Propagation Handoff

## 1. Executive Summary

- **Subsystem:** UI refresh / WebSocket / event propagation.
- **Purpose:** Carries live runtime, chat, resource, status, and cross-project activity updates from server/runtime processes to the React UI.
- **Why it matters:** Stale UI state makes every higher-level subsystem look unreliable: chat, work items, agents, workflows, statusline, project lists, and transient assistant surfaces all depend on this path.
- **Current health:** Mixed. Runtime chat has a durable `jsonl-events.jsonl` replay path and reconnect snapshots. Several resource lists use versioned snapshot envelopes. However, the live event layer is not canonical or durable, global broadcasts can be dropped by current client filters, project-list changes have no live event, and event contracts are duplicated across server and web code.
- **High-level recommendation:** Refactor toward a shared live-event contract and durable outbox/replay layer. Keep the current `/ws` fanout and resource-list patching as compatibility shims while introducing canonical event envelopes, typed feature invalidation hooks, and catch-up cursors.

## 2. Baseline

| Field | Value |
|---|---|
| Date | 2026-05-30 |
| Branch | `dev` |
| Commit | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` |
| Codebase state | Current implementation only. The working tree was already dirty with many deleted tests/docs and an untracked `refactor plan/` folder before this handoff was written. |
| Assumed implemented recommendations from other docs | None. No prior subsystem handoff exists yet. |
| Excluded paths | `archive/` |

Verified baseline notes:

- `refactor plan/refactor plan docs/` contained only `README.md`.
- `rg --files --glob "!archive/**" --glob "!apps/server/data/**" | rg "(test|spec)\.(ts|tsx)$"` returned no current test files in the working tree.
- `rg -n "outbox|live_event|live_events|websocket_events" apps packages --glob "!archive/**" --glob "!apps/server/data/**"` returned no canonical durable live-event table or package.

## 3. Scope and Non-Goals

Included:

- Server `/ws` registration and per-project fanout.
- Client active-project and background-project WebSocket hooks.
- Runtime chat reconnect/replay flow.
- Event envelope shapes consumed by UI hooks.
- Resource invalidation/update hooks that depend on WS events.
- Current event emission paths in server routes/services.
- State ownership for live projection, replay, and freshness.

Out of scope for this document:

- Deep chat transcript rendering rules. Covered by the next subsystem.
- Agent lifecycle and delivery semantics beyond their WS envelopes.
- Workflow DAG semantics beyond `workflow-changed` and `workflow-v2-run-changed`.
- Channel replacement design, except where `channel-event` intersects UI fanout.
- Desktop shell and dev process lifecycle.

Do not change casually:

- `/ws?projectId=<id>&intent=chat` and `intent=activity` compatibility.
- Existing runtime replay files under `<data>/projects/<id>/sessions/<sessionId>/jsonl-events.jsonl`.
- Existing resource envelope names until all consumers move to the canonical envelope.
- `ProjectRuntime` process ownership until the runtime-host split is planned.

## 4. Current System Trace

### Startup and registration

- `apps/server/src/index.ts` creates one `ProjectWebSocketHub<ULID>` and wraps it with `broadcastTo(projectId, msg)` and `broadcastAll(msg)` at lines 168-186.
- `broadcastTo` calls `ProjectWebSocketHub.broadcast`, which injects `projectId` into object envelopes before JSON serialization in `apps/server/src/services/websocket-hub.ts`.
- `broadcastAll` calls `ProjectWebSocketHub.broadcastAll`, which serializes the payload unchanged; no `projectId` is injected.
- `registerRuntimeHostWebSocketServer` mounts `ws` on `/ws` after `serve(...)` starts the Hono HTTP server in `apps/server/src/index.ts`.
- `apps/web/vite.config.ts` proxies `/ws` to the API port during web dev.

### WebSocket connect flow

- Client active project:
  - `apps/web/src/App.tsx` calls `useProjectWs(activeProject)` and passes `ws.events`, `ws.send`, `ws.status`, and diagnostics into `Shell`.
  - `apps/web/src/hooks/use-project-ws.ts` opens `new WebSocket(/ws?projectId=<id>&intent=chat)`.
- Client background projects:
  - `apps/web/src/App.tsx` calls `useAllProjectsWs(projects, activeProject?.id, projects.length > 1)`.
  - `apps/web/src/hooks/use-all-projects-ws.ts` opens one socket per non-active project with `intent=activity`.
- Server connect:
  - `handleRuntimeHostWsConnection` in `apps/server/src/features/runtime-host/websocket-server.ts` requires `projectId`, resolves the `ProjectRuntime`, subscribes the socket, and sends a connect checkpoint.
  - `sendRuntimeHostConnectSnapshot` in `apps/server/src/features/runtime-host/websocket-connect.ts` sends:
    - `{ type: 'session-changed', session }`;
    - `{ type: 'state', state }` only for focused `intent=chat` when a live PTY already exists;
    - `{ type: 'runtime-state', ... }`;
    - `{ type: 'session-replay', events, highWaterSeq }` when a session exists;
    - `{ type: 'send-queue-snapshot', items }` when a session exists.

### WebSocket message flow

- Client sends outbound messages from `useProjectWs.send`.
- `handleRuntimeHostWsMessage` in `apps/server/src/features/runtime-host/websocket-message.ts` handles:
  - `client-ping` -> `server-pong`;
  - `send` -> create/ensure active session, ensure PTY, send or enqueue prompt, return `send-ack`, broadcast send-queue/runtime snapshots;
  - `interrupt`;
  - `terminal-input`;
  - `resize`;
  - `ask-reply` -> resolve in-memory pending ask.

### Runtime event flow

- `createRuntimeHostPtyController` in `apps/server/src/features/runtime-host/pty-handlers.ts` attaches once per PTY and broadcasts:
  - `raw`;
  - `state`;
  - `turn-end`;
  - legacy `event`;
  - canonical `jsonl`;
  - `exit`;
  - `runtime-state` snapshots after most lifecycle updates.
- Runtime JSONL persistence happens before live broadcast:
  - `packages/runtime/src/pty-session.ts` writes each normalized JSONL event to `<sessionDataPath>/jsonl-events.jsonl`.
  - `apps/server/src/services/session-replay.ts` loads that file for active connect snapshots and past-session replay.
- Runtime cursor persistence is debounced through `jsonl-cursor-tick` and `setOrchestratorSessionJsonlCursor`.

### Non-runtime event flow

Verified event emitters:

| Event | Server emitters | Current UI consumers |
|---|---|---|
| `work-item-changed` | `WorkItemService`, `work-item-writer.ts`, route bypass in `features/work-items/routes.ts` | `useProjectWorkItems`, `KanbanBoard`, rich-link invalidator, detail modals |
| `stages-changed` | `features/work-items/routes.ts` stage replacement route | `useProjectStages`, settings stages editor via refreshed project data |
| `attachment-changed` | `AttachmentService` | rich-link invalidator, attachment detail surfaces |
| `pod-changed` | `pod-writer.ts`, `routes/pod-routes.ts` via `broadcastAll` | `useProjectPods` if event reaches hook |
| `workflow-changed` | `routes/workflow-routes.ts` via `broadcastTo` or `broadcastAll` | `useProjectWorkflows` if event reaches hook |
| `workflow-v2-run-changed` | `workflow-run-writer.ts`, DAG service | `useProjectWorkflowV2Runs` |
| `agent-run-changed` | agent-run factory, boot reconcile, liveness/terminal effects | `useProjectAgentRuns`, activity panel |
| `statusline-snapshot` | `features/statusline/routes.ts` | `useStatuslineSync`, statusline store |
| `channel-event` | `index.ts` channel server callback and `ChannelServer` internals | chat/activity surfaces |
| transient session prefixes | `features/transient-sessions/routes.ts` | agent-designer, workflow-builder, setup-wizard UI |

### Failure and recovery flow

- Server-side liveness:
  - `registerRuntimeHostWebSocketServer` pings sockets every 30 seconds and terminates sockets that miss pong.
- Client-side liveness:
  - `useProjectWs` and `useAllProjectsWs` send `client-ping` every 15 seconds and force reconnect after 45 seconds without inbound traffic.
  - `useProjectWs` also reconnects on `visibilitychange`, `online`, and `focus` if stale.
- Active resource-list recovery:
  - `useProjectWs` bumps `useWsEpoch` whenever the focused socket opens.
  - `useResourceList` refetches on `wsEpoch`, project switch, unknown-id snapshot, or terminal snapshot.
- Runtime chat recovery:
  - Active connect gets a replay checkpoint from disk, not from the in-memory socket hub.
- Non-runtime recovery:
  - There is no durable outbox, event cursor, or server-side replay for work items, projects, pods, workflows, agent runs, statusline, or transient-session events.
  - Recovery depends on per-feature HTTP refetches and whether the feature hook is wired to reconnect or missed-event detection.

### Important edge cases

- `broadcastAll` sends untagged events, while both `useProjectWs` and `useAllProjectsWs` drop any incoming envelope whose `env.projectId` does not match the connection project.
- `useProjectWorkflows` and `useProjectStages` are bespoke hooks and do not consume `useWsEpoch`, so missed events are not reconciled on reconnect.
- The client comment in `use-project-ws.ts` says `intent=chat` spawns/attaches. The server `websocket-connect.ts` comment and behavior say connect never starts a PTY; it only attaches to an already-live PTY.
- Project create/update/delete/reorder routes update HTTP state but emit no `project-changed` event. Current tab state is updated locally in `App.tsx`; other connected clients can go stale.

## 5. Integration Map

### Inbound integrations

| Inbound caller | Contract | Side effect |
|---|---|---|
| React active project | `/ws?projectId=<id>&intent=chat` | Subscribes to per-project stream; gets runtime checkpoint; may send chat/control messages |
| React background projects | `/ws?projectId=<id>&intent=activity` | Subscribes to broadcast-only project stream for unread/activity |
| Runtime PTY / InteractiveSession | EventEmitter events | Server broadcasts runtime, chat, raw terminal, replay metadata |
| HTTP route handlers | `broadcastTo(projectId, msg)` / `broadcastAll(msg)` | Best-effort live UI projection |
| Channel server | `onEvent(projectId, event)` callback | Broadcasts `channel-event` |
| Statusline hook HTTP POST | `/api/internal/statusline-data` | Persists statusline snapshot and broadcasts `statusline-snapshot` |

### Outbound integrations

| Outbound target | Owner | Contract |
|---|---|---|
| SQLite repos | `packages/db` | Durable product/runtime state; no live outbox |
| Runtime session files | `packages/runtime`, `ProjectRuntime` | `jsonl-events.jsonl`, `events.jsonl`, `transcript.log`, cursor metadata |
| React feature hooks | `apps/web/src/hooks/*` | `WsEnvelope[]` arrays plus per-feature extractors |
| Zustand stores | `apps/web/src/store/*` | Active project, WS epoch, statusline, unread state, chat UI state |
| Channel server | `apps/server/src/services/channel-server.ts` | Separate child-process registration and message delivery plane |

### Coupling and hidden dependencies

- `apps/server/src/index.ts` is the composition root for live events, route registration, runtime PTY handlers, channel server, sweeps, and project registry.
- Server event types are mostly string literals spread across routes/services.
- Web event types are manually mirrored in `apps/web/src/features/runtime/ws-types.ts`.
- `useResourceList` assumes envelopes contain full snapshots plus monotonic `version` or `rev` when configured.
- `useProjectWs` owns both chat timeline state and general feature event distribution, so non-chat resources depend on the chat socket buffer shape.
- Background unread depends on one socket per background project and reuses full runtime connect snapshots.

## 6. Data and State Model

### Owned by this subsystem

Current owned state:

- In-memory WebSocket subscribers: `ProjectWebSocketHub.subscribers`.
- Active socket diagnostics and event buffers in `useProjectWs`.
- Background socket buffers in `useAllProjectsWs` capped at 500 events.
- Per-project reconnect epoch in `useWsEpoch`.
- Runtime lifecycle projection map in `OrchestratorRuntimeSnapshots`.

### Durable state read or projected by this subsystem

| Durable state | Current storage | Projection |
|---|---|---|
| Projects, stages | `projects` table | `stages-changed`, HTTP project detail/list |
| Work items | `work_items` table | `work-item-changed` |
| Workflows | `workflows` table | `workflow-changed` |
| Workflow runs | `workflow_runs_v2` table | `workflow-v2-run-changed` |
| Agent runs | `agent_runs` table | `agent-run-changed` |
| Agent pods | `agents` and child tables | `pod-changed` |
| Orchestrator sessions | `orchestrator_sessions` table | `session-changed`, `runtime-state`, `session-replay` |
| Prompt send queue | `orchestrator_send_queue` table | `send-queue-snapshot`, `send-ack` |
| Statusline snapshots | `statusline_snapshots` table plus route-local latest map | `statusline-snapshot` |
| Runtime transcript events | session-local `jsonl-events.jsonl` | `jsonl`, `session-replay` |
| Agent inbox | `agent_inbox`, `agent_delivery_audit` | Not a canonical live-event source yet |

### Cache and lifecycle behavior

- `ProjectWebSocketHub` is rebuildable in memory; it owns no durable truth.
- Runtime replay is durable on disk per session.
- Non-runtime live events are not durably persisted as events.
- Feature hooks often keep local maps as caches and refetch HTTP truth on mount or recovery.
- `pendingAsks` for orchestrator ask replies is in memory only.
- `statusline` keeps both a route-local latest snapshot map and DB history.

### Concurrency concerns

- Versioned resources can handle out-of-order delivery only when envelopes carry monotonic fields:
  - work items: `version`;
  - workflow runs: `rev`;
  - pods: `rev`;
  - stages: project `stagesRev` stamped into each stage.
- `workflow-changed` rows do not carry a monotonic event/version field.
- `broadcastAll` events have no per-project tag or stable cursor.
- Server broadcast happens after DB write but outside a DB/outbox transaction, so a process crash between write and broadcast causes silent missed UI updates.

## 7. Invariants and Compatibility Requirements

Must remain true during migration:

- Existing `/ws?projectId=<id>&intent=chat` clients continue to receive runtime snapshots and can send chat/control messages.
- Existing `/ws?projectId=<id>&intent=activity` clients do not spawn orchestrator PTYs.
- WebSocket connect must not create or mutate orchestrator sessions by itself.
- Runtime chat replay remains available from `jsonl-events.jsonl` for active reconnect and historical sessions.
- Client-side resource hooks must continue to tolerate out-of-order and duplicate events.
- Existing envelope names must keep working until every feature migrates.
- `send` must still return `send-ack` and update send queue state.
- `projectId` scoping must prevent cross-project data leaks.
- Runtime/process handles stay in memory; durable product state remains in SQLite or per-session log files.

Compatibility constraints:

- Global resources currently use `broadcastAll`; a compatibility event contract must define whether global events are sent once per subscribed project with a project tag or use a separate global stream.
- Existing UI code expects `WsEnvelope[]`, not a normalized event bus object.
- Background unread logic expects replay snapshots on first background connect.
- Tests are currently absent from the working tree; rebuilding coverage should be part of the migration before risky changes.

## 8. Related Subsystem Docs

No prior subsystem handoff docs exist yet.

Expected future coordination:

| Related subsystem | Current dependency verified in code | Potential conflict | Coordination needed |
|---|---|---|---|
| Chat runtime and transcript UI | Chat timeline is built from `useProjectWs`, `chat-session-reducer`, runtime replay, and `jsonl` envelopes | Chat may want session-event contracts that differ from generic live events | Define whether chat replay uses the same envelope shell as live events or an adapter |
| Agents and agent runs | `agent-run-changed`, `channel-event`, agent inbox tables, liveness/reconcile sweeps | Agent delivery may move to mailbox while UI still consumes channel events | Separate agent delivery truth from UI visibility events |
| Workflows and workflow builder | `workflow-changed`, `workflow-v2-run-changed`, transient workflow-builder events | Workflow rows lack event versions and some builder events are transient-only | Define workflow event versions and replay expectations |
| MCP and tooling | MCP tools mutate resources and rely on HTTP/server broadcasts indirectly | MCP should not emit its own UI contracts | Route MCP through app services that write outbox events |
| Channel server replacement | `channel-event` shares UI WS but Channel has separate `/channel-register` process WS | Target mailbox may replace parts of Channel and agent inbox | Decide which mailbox facts become live UI events |

This document assumes none of those future recommendations are implemented.

## 9. Current Issues

### Issue 1: Non-runtime live events are best-effort only

- **Severity:** high.
- **Evidence:** `ProjectWebSocketHub` is an in-memory map; `broadcastTo` and `broadcastAll` only call `send`. No `outbox` or `live_events` table exists. `useWsEpoch` comments explicitly state the hub has no catch-up.
- **Impact:** A DB write can succeed while the UI misses the corresponding live update because the socket was closed, half-open, not subscribed yet, or the server crashed before broadcast.
- **Likely root cause:** Broadcast is treated as the event system rather than a projection of durable facts.
- **Suggested fix direction:** Add a durable live outbox table/service and cursor-based replay. Keep current broadcasts as low-latency fanout from outbox inserts.
- **Affected files/systems:** `apps/server/src/services/websocket-hub.ts`, `apps/server/src/index.ts`, route/service broadcast callers, `apps/web/src/hooks/use-project-ws.ts`, `apps/web/src/hooks/use-resource-list.ts`.

### Issue 2: `broadcastAll` events are dropped by current client filters

- **Severity:** high.
- **Evidence:** `ProjectWebSocketHub.broadcastAll` serializes payloads unchanged. `useProjectWs` and `useAllProjectsWs` both return early when `env.projectId !== projectId`. `pod-writer.ts` emits `pod-changed` without `projectId`; `workflow-routes.ts` emits global workflow changes through `broadcastAll`.
- **Impact:** Global pod/workflow changes can be invisible to active and background clients even though comments in hooks expect them.
- **Likely root cause:** The server comment says global events are unscoped, but the client subscription contract requires per-project tags.
- **Suggested fix direction:** Define a compatibility rule: either tag `broadcastAll` once per subscribed project, or introduce an explicit `scope: 'global'` event that client filters accept. Longer term, canonical event envelopes should carry both `projectId` and `scope`.
- **Affected files/systems:** `apps/server/src/services/websocket-hub.ts`, `apps/server/src/routes/pod-routes.ts`, `apps/server/src/routes/workflow-routes.ts`, `apps/web/src/hooks/use-project-ws.ts`, `apps/web/src/hooks/use-all-projects-ws.ts`, `apps/web/src/hooks/use-project-pods.ts`, `apps/web/src/hooks/use-project-workflows.ts`.

### Issue 3: No shared event contract across server and web

- **Severity:** high.
- **Evidence:** Server emits string-literal envelopes across many files; web manually mirrors types in `apps/web/src/features/runtime/ws-types.ts` with `WsEnvelope { type: string; [k: string]: unknown }`.
- **Impact:** Server/web shape drift is easy. Feature hooks rely on field names that are not centrally validated.
- **Likely root cause:** No `packages/contracts` package and no canonical live envelope.
- **Suggested fix direction:** Create shared browser-safe live-event contracts and import them from server emitters and web hooks. Start with current event names as payload variants.
- **Affected files/systems:** `apps/server/src/**/*`, `apps/web/src/features/runtime/ws-types.ts`, feature clients/hooks.

### Issue 4: Reconnect reconciliation is inconsistent by feature

- **Severity:** medium/high.
- **Evidence:** `useResourceList` refetches on `useWsEpoch`, but `useProjectStages` and `useProjectWorkflows` do not. `useProjectWs` bumps epoch only for the focused project socket.
- **Impact:** Workflows and stages can remain stale after missed events. Background project resources are not generally reconciled except unread.
- **Likely root cause:** Reconnect recovery lives in feature hooks instead of a shared live-event/query integration layer.
- **Suggested fix direction:** Move stages/workflows to `useResourceList` or an equivalent shared hook, and define reconnect behavior for background/global resources.
- **Affected files/systems:** `apps/web/src/hooks/use-project-stages.ts`, `apps/web/src/hooks/use-project-workflows.ts`, `apps/web/src/hooks/use-resource-list.ts`, `apps/web/src/store/ws-epoch.ts`.

### Issue 5: Project list changes have no live event

- **Severity:** medium.
- **Evidence:** `apps/server/src/features/projects/routes.ts` creates, patches, deletes, and reorders projects without `broadcastTo`/`broadcastAll`. `App.tsx` updates the local tab optimistically/directly after user actions.
- **Impact:** Other connected clients do not learn about project create/rename/delete/reorder until reload or manual refresh.
- **Likely root cause:** Project registry changes predate the current WS invalidation approach.
- **Suggested fix direction:** Add a `project-changed`/`projects-changed` contract backed by a project list query. In target architecture, emit it through the durable outbox.
- **Affected files/systems:** `features/projects/routes.ts`, `apps/web/src/App.tsx`, `ProjectRail`, project client.

### Issue 6: Background subscription model scales poorly and gets full runtime snapshots

- **Severity:** medium.
- **Evidence:** `useAllProjectsWs` opens one WebSocket per non-active project. Server connect sends `session-changed`, `runtime-state`, `session-replay`, and send queue snapshots for any connection with an active session, including `intent=activity`.
- **Impact:** Many projects can produce many sockets and replay payloads even when the UI only needs unread/activity nudges.
- **Likely root cause:** The only subscription primitive is per-project runtime WS; activity fanout is layered on top.
- **Suggested fix direction:** Add a live-events endpoint that supports project filters, entity filters, cursors, and a light activity mode.
- **Affected files/systems:** `use-all-projects-ws.ts`, `websocket-connect.ts`, `websocket-server.ts`, unread hook.

### Issue 7: Transient-session and ask events are not durable or standardized

- **Severity:** medium.
- **Evidence:** `features/transient-sessions/routes.ts` emits prefix-specific envelopes such as `agent-designer-jsonl`, `workflow-builder-state`, and `setup-wizard-exit`. `pendingAsks` is an in-memory resolver map in `chat-bridges/routes.ts`.
- **Impact:** A reconnect or server restart can lose modal/transient state or asks unless another subsystem rebuilds it.
- **Likely root cause:** Transient assistants were added as direct PTY adapters, not as durable runtime/message records.
- **Suggested fix direction:** Coordinate with chat/workflow/agent docs. Standardize transient-session envelopes and decide which facts must be persisted.
- **Affected files/systems:** `features/transient-sessions/routes.ts`, `features/chat-bridges/routes.ts`, modal components/hooks.

### Issue 8: Current working tree has no executable tests for this subsystem

- **Severity:** high for migration risk.
- **Evidence:** test/spec file search found no current test files; `git status` shows many `D` entries for previous server/runtime/websocket tests.
- **Impact:** Refactor work would have little regression protection unless tests are restored or recreated first.
- **Likely root cause:** The checkout appears to be in a planning/reset state with tracked tests removed.
- **Suggested fix direction:** Make test restoration or new focused test creation an early implementation phase before changing live-event behavior.
- **Affected files/systems:** all event propagation paths.

## 10. First-Principles Design

Ideal responsibilities:

- Durable state changes produce durable facts.
- Live sockets project facts; they are not the source of truth.
- Every live event has a stable envelope, type, entity, project scope, version/cursor, and timestamp.
- UI hooks consume shared contracts and choose patch vs refetch.
- Runtime process events are normalized and persisted before fanout.
- Reconnect is cursor-based, not "best-effort plus hope a refetch runs".

Ideal API shape:

```ts
interface LiveEvent<TPayload> {
  id: string;
  projectId: string | null;
  scope: 'project' | 'global';
  type: string;
  entity: string;
  entityId: string | null;
  version: number | null;
  cursor: string;
  createdAt: number;
  payload: TPayload;
}
```

Ideal flow:

1. Application service validates a command.
2. Service writes durable state in a DB transaction.
3. Same transaction inserts a live outbox event.
4. WS fanout sends the event to matching subscribers.
5. Client stores the cursor and applies a typed patch or refetches a typed query.
6. Reconnect asks for events after cursor; fallback is feature refetch.

Fit into the existing app:

- Runtime chat can keep `jsonl-events.jsonl` initially but should be wrapped in the same envelope family when sent over WS.
- Current event names can become payload variants under the canonical envelope.
- `ProjectWebSocketHub` can stay as fanout infrastructure.
- `useProjectWs` can stay as chat transport while feature event subscription is extracted behind `useLiveEvents`.
- Existing feature hooks can be migrated one by one.

## 11. Target Architecture Alignment

| Target cartridge part | Current alignment | Gap |
|---|---|---|
| contracts | Weak | Web has manual `ws-types.ts`; server emits literals |
| domain | Partial | Some version fields exist in domain/DB rows; event decisions live in routes/services |
| db repo | Strong for product state | No live-event/outbox repo |
| application service | Mixed | Work items and attachments have services; routes still emit some events directly |
| HTTP route | Present | Routes duplicate validation and broadcast concerns |
| live events | Present but ad hoc | No canonical envelope, cursor, or replay for non-runtime events |
| web client/hooks | Mixed | Some feature hooks are disciplined; others bespoke/direct |
| MCP adapter | Indirect | MCP mutations rely on route/service side effects, no shared event contract |
| tests | Currently absent in working tree | Need restore/rebuild focused coverage |

Cross-cutting target systems:

- **Shared contracts:** Not implemented.
- **Canonical live events:** Not implemented.
- **Durable mailbox:** Not directly implemented for UI events; `agent_inbox` exists for agent delivery but is not a general mailbox/live layer.
- **Runtime host boundary:** Runtime event source is still tied through `ProjectRuntime`, PTY handlers, and server composition root.
- **MCP adapter boundary:** MCP should call the same app services that create outbox events.
- **UI fetch discipline:** Mostly feature clients/hooks, but direct fetches remain in some components and feature clients manually shape responses.

Conflicts/uncertainties for synthesis:

- Whether runtime chat replay should move from session files into SQLite event tables or remain file-backed behind a contract adapter.
- How to represent global events without leaking project data or breaking per-project clients.
- Whether background activity should be per-project sockets, one multiplexed socket, or a query-backed notification feed.

## 12. Recommended Target Architecture

Practical architecture to build toward:

- **Keep:** `/ws` transport, heartbeat/backoff logic, runtime replay files, version-aware patching patterns, `useResourceList` concept.
- **Refactor:** event envelope construction, event emitters, feature hooks, background activity subscription, project-list freshness.
- **Split:** chat/runtime transport from generic feature live-event distribution.
- **Replace:** ad hoc best-effort invalidation with durable live outbox and cursor replay.
- **Merge/standardize:** all resource update hooks behind one typed live-query integration.

Recommended module boundaries:

```text
packages/contracts/src/live-events.ts
packages/contracts/src/{work-items,projects,workflows,agents,runtime}.ts
packages/db/src/repos/live-events.ts
packages/app-services/src/live-event-publisher.ts
apps/server/src/features/live-events/websocket.ts
apps/web/src/features/live/client.ts
apps/web/src/features/live/hooks.ts
```

Compatibility adapters:

- Current `broadcastTo(projectId, legacyEnvelope)` can wrap legacy envelopes into `LiveEvent` but also emit legacy shape until consumers migrate.
- Current resource hooks can accept both legacy and canonical events during migration.
- Runtime `jsonl`, `session-replay`, and `runtime-state` can initially stay legacy while the live envelope is introduced for non-runtime entities first.

Decisions requiring holistic synthesis:

- Final event table schema and retention policy.
- Runtime transcript storage: SQLite event log vs current session JSONL adapter.
- Mailbox/channel visibility events and whether they share the same outbox.
- Global event scoping semantics.

## 13. Migration Strategy

| Phase | Goal | Files likely affected | Dependencies | Risks | Verification | Rollback | Restart/reload |
|---|---|---|---|---|---|---|---|
| 0 | Restore/create focused tests before behavior changes | test folders, package scripts | None | Current tests absent | Unit tests for hub, hooks, emitters | Keep docs only | No app restart; test command only |
| 1 | Document and type current legacy envelopes in shared contracts | new `packages/contracts`, `ws-types.ts`, selected emitters | Package config | Build churn | Typecheck server/web | Revert package import changes | Dev server reload if running |
| 2 | Fix global event scoping compatibility | `websocket-hub.ts`, `use-project-ws.ts`, `use-all-projects-ws.ts`, pod/workflow hooks | Phase 0 tests | Could duplicate global events | Tests for `broadcastAll` delivery/filtering | Restore old `broadcastAll` behavior | Server reload required |
| 3 | Normalize reconnect refetch hooks | `useProjectStages`, `useProjectWorkflows`, `useResourceList`, `ws-epoch` | Phase 0 tests | Extra fetches | Hook tests and manual missed-event simulation | Revert hook migration | Renderer reload |
| 4 | Add project-list change event | project routes, App/project rail hooks | Event contract | Multi-tab project sync changes selection behavior | Multi-tab create/rename/delete/reorder tests | Keep local-only App updates | Server/renderer reload |
| 5 | Introduce durable live outbox for non-runtime resources | DB schema/repo, app services/routes, websocket server | Contract settled | Schema migration, duplicate events | Outbox insert/fanout/replay tests | Feature flag outbox fanout off | Server restart/migration |
| 6 | Add cursor replay client | live client/hook, websocket connect, server replay query | Phase 5 | Cursor bugs, missed/duplicate events | Reconnect-after-write tests | Fall back to HTTP refetch | Server/renderer reload |
| 7 | Wrap runtime events in canonical envelope | runtime-host WS files, chat reducer, runtime types | Chat subsystem plan | Chat regressions | Chat replay/live ordering tests | Keep legacy runtime path | Server/renderer reload |
| 8 | Replace background per-project sockets with multiplexed live subscription | new live socket/query, unread hook | Cursor replay | Activity/unread regressions | Many-project activity tests | Keep `useAllProjectsWs` | Server/renderer reload |

## 14. Acceptance Criteria

Functional:

- A state change committed to SQLite is represented by a durable event or an explicitly documented query invalidation.
- Reconnecting a client after a missed event refreshes or replays all affected visible state without manual reload.
- Global pod/workflow changes reach all relevant project views.
- Project create/rename/delete/reorder updates every connected client or is explicitly documented as local-only until migrated.
- Runtime chat reconnect still shows the correct active session, replay, send queue, and runtime snapshot.

Integration:

- Server emitters and web consumers use shared event contract types for migrated events.
- Feature hooks do not parse raw unknown envelopes directly after migration.
- MCP/HTTP/UI mutations converge on the same event emission path.

Regression:

- Duplicate/out-of-order events do not regress lists with versioned rows.
- Background activity does not spawn PTYs.
- A half-open socket is terminated and reconnected automatically.
- `send-ack` and queued prompt reconciliation still work.

Observability/debuggability:

- WS diagnostics include connection id, last cursor, last event type, reconnect count, and replay count.
- Server logs rejected/malformed subscription attempts.
- Live-event replay has clear error and fallback behavior.

Performance/reliability:

- Background activity does not require O(project count) sockets long-term.
- Event replay is bounded by cursor and retention policy.
- Large session replay is only sent to consumers that need chat history.

## 15. Test Plan

Existing tests in this working tree:

- None found by current file search. Many formerly tracked tests appear deleted in `git status`.

Required unit tests:

- `ProjectWebSocketHub`:
  - multiple subscribers per project;
  - closed socket pruning;
  - `broadcastAll` compatibility tagging/filtering decision.
- WebSocket server:
  - rejects missing/unknown `projectId`;
  - `intent=activity` does not attach/start PTY;
  - keepalive terminates stale clients;
  - `client-ping` gets `server-pong`.
- Event contract builders:
  - each resource emits required envelope fields;
  - version/cursor fields are monotonic where applicable.
- Web hooks:
  - `useResourceList` scans all new events and refetches on reconnect/unknown/terminal;
  - `useProjectStages` and `useProjectWorkflows` do not miss reconnect reconciliation after migration;
  - global events are accepted only when intended.

Required integration tests:

- DB write -> outbox row -> WS fanout -> UI hook patch.
- DB write while socket disconnected -> reconnect cursor replay or feature refetch.
- Global pod/workflow mutation reaches active and background project clients.
- Project list mutation updates a second connected client.
- Runtime active-session replay survives reconnect and duplicate messages are not rendered.

Manual verification steps:

- Open two browser clients on the same project; mutate work item/stage/workflow/agent pod in one; verify the other updates without refresh.
- Disconnect/reconnect WS while creating an agent run/workflow run; verify activity panel reconciles.
- Put the renderer in background, wait past heartbeat timeout, return to foreground, verify reconnect and refetch.
- Create/rename/delete/reorder projects in one client and verify another client's rail.
- Start/resume/close chat and verify session replay and send queue snapshots.

Hard-to-test areas:

- OS/network half-open sockets.
- Runtime process crash between JSONL persistence and broadcast.
- Server crash between DB write and live outbox insert unless transactionally modeled.
- Large multi-project background activity load.

## 16. Implementation Notes for Next Agent

Recommended starting point:

1. Recreate focused tests around the current behavior, especially the `broadcastAll`/client-filter mismatch.
2. Fix global event delivery compatibility before introducing bigger architecture.
3. Move `useProjectStages` and `useProjectWorkflows` onto reconnect-aware shared hook behavior.
4. Add project-list invalidation.
5. Then introduce shared contracts and outbox in a feature-by-feature migration.

Risky files to inspect before editing:

- `apps/server/src/index.ts`
- `apps/server/src/services/websocket-hub.ts`
- `apps/server/src/features/runtime-host/websocket-server.ts`
- `apps/server/src/features/runtime-host/websocket-connect.ts`
- `apps/server/src/features/runtime-host/websocket-message.ts`
- `apps/server/src/features/runtime-host/pty-handlers.ts`
- `apps/web/src/hooks/use-project-ws.ts`
- `apps/web/src/hooks/use-all-projects-ws.ts`
- `apps/web/src/hooks/chat-session-reducer.ts`
- `apps/web/src/hooks/use-resource-list.ts`
- `apps/web/src/features/runtime/ws-types.ts`

Patterns to follow:

- Versioned full-snapshot events from `work-item-writer.ts`, `workflow-run-writer.ts`, and `pod-writer.ts`.
- Runtime persist-before-broadcast pattern in `packages/runtime/src/pty-session.ts`.
- Reconnect refetch via `useWsEpoch` in `useResourceList`.

Things to avoid:

- Do not make WebSocket delivery the only source of truth.
- Do not add new untyped string-literal event families.
- Do not add another per-feature reconnect workaround when a shared live-query hook can own it.
- Do not silently change `intent=activity` into a PTY-spawning connection.
- Do not remove legacy envelope compatibility until every consumer has migrated.

## 17. Handoff Metadata

| Field | Value |
|---|---|
| Subsystem | UI refresh / WebSocket / event propagation |
| Primary owner area | `apps/server`, `apps/web`, `packages/runtime`, future `packages/contracts`/`packages/live` |
| Runtime process | Server process, renderer process, runtime PTY children |
| Owns state | Socket subscribers, WS client buffers, reconnect epoch, runtime lifecycle projection |
| Reads state from | SQLite repos, runtime session files, ProjectRuntime, channel server callbacks |
| Writes state to | WebSocket clients, client caches/stores, runtime cursor/session metadata |
| Inbound contracts | `/ws`, HTTP route broadcast hooks, PTY EventEmitter events, statusline POST, channel callback |
| Outbound contracts | `WsEnvelope` arrays, feature hooks, Zustand stores, legacy event shapes |
| Hard dependencies | Hono server, `ws`, `ProjectRuntime`, DB repos, React hooks |
| Soft dependencies | Channel server, statusline, rich-link cache, unread localStorage |
| Restart required for changes | Server restart for server/DB changes; renderer reload for web hook changes; no restart for planning docs |
| Migration risk | High |
| Target architecture status | Refactor, then split generic live events from chat runtime transport |
| Related docs consulted | `target-architecture.md`, `subsystem-architecture-handoff-prompt.md`, `refactor-tracker.md`; no prior subsystem docs |

## 18. Tracker Update

Update `refactor plan/refactor-tracker.md` row:

- `WebSocket/event propagation`
- Status: `needs synthesis`
- Baseline branch: `dev`
- Baseline commit: `d114fc2535c1116f6eb2d883f9cac2a9193a8254`
- Owner area: `apps/server`, `apps/web`, `packages/runtime`
- Runtime process: `Server/renderer/runtime`
- Migration risk: `high`
- Target recommendation: `refactor/split`
- Dependencies: runtime host, chat, project state, work items, workflows, agents, channel/mailbox
- Open questions:
  - What is the canonical durable live-event table/envelope?
  - How should global events be scoped and replayed?
  - Should runtime chat events move into SQLite or remain file-backed behind a live-event adapter?
  - Should background activity use one multiplexed subscription instead of one socket per project?

## 19. Open Questions

True blockers:

- Which event facts require durable outbox storage in the first implementation slice?
- How should global events be represented without conflicting with per-project filtering?
- Are the deleted tests intentionally removed, or should implementation agents restore tracked tests first?

Non-blocking uncertainties:

- Whether statusline latest snapshot should remain route-local memory plus DB history or become a standard query over DB only.
- Whether transient-session modal events need full replay or only reconnect refetch/status endpoints.
- Whether unread state should be backed by durable per-user read cursors instead of localStorage.

Product/design decisions:

- Should a project-list change in one window immediately alter the selected project in another window?
- Should background activity include full chat replay or only unread counters/nudges?

Technical decisions a builder can reasonably make:

- Introduce shared event builders before DB outbox.
- Add compatibility tags to global events before canonical envelope migration.
- Move bespoke hooks to `useResourceList` where the API already supports full-list refetch.
