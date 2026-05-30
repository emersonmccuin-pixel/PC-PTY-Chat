# Agents and Agent Runs Architecture Handoff

## 1. Executive Summary

- **Verified behavior:** This subsystem owns agent pod definitions, agent dispatch, run lifecycle, pause/resume, terminal verification, run inspection/kill controls, transcript backfill, and agent-to-orchestrator delivery.
- **Why it matters:** Agent runs are a core reliability path. They connect MCP tools, pod materialization, runtime processes, SQLite state, WebSocket activity panels, work-item verification, and Channel delivery.
- **Current health:** Medium/high risk. The system has durable `agent_runs`, `pending_asks`, and `agent_inbox` tables, but lifecycle ownership is split across server services, runtime wrappers, optional agent host, Channel, MCP, and UI adapter types.
- **Recommendation:** Keep the durable DB-first direction, but introduce a single agent-run application service and shared contracts before deeper runtime/host changes. Treat WebSocket and Channel events as projections, not lifecycle truth.

## 2. Baseline

| Field | Value |
|---|---|
| Date | 2026-05-30 |
| Branch | `dev` |
| Commit | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` |
| Commit subject | `fix(web): reconcile agent/workflow lists on every WS (re)connect - no more refresh` |
| Codebase state | Current worktree only. Startup status showed a large pre-existing dirty tree and `refactor plan/` as untracked. |
| Assumed implemented recommendations from other docs | None. `refactor plan/refactor plan docs/ui-refresh-websocket-event-propagation.md` exists and is treated as context only, not implemented truth. |
| Excluded paths | `archive/` ignored completely. |

## 3. Scope and Non-Goals

Included:

- Agent pod catalog and spawn resolution: `packages/db/src/repos/pods.ts`, `apps/server/src/routes/pod-routes.ts`, `apps/server/src/services/pod-spawn.ts`.
- Agent-run lifecycle and persistence: `packages/runtime/src/agent-run.ts`, `packages/runtime/src/agent-run-registry.ts`, `packages/db/src/schema-agent-system.ts`, `packages/db/src/repos/agent-runs.ts`.
- Dispatch, continuation, pause/resume, terminal effects, verification, liveness, and reattach services under `apps/server/src/services/agent-*.ts`.
- HTTP API: `apps/server/src/features/agent-runs/routes.ts`.
- MCP adapter: `packages/mcp/src/tools/agent-runs.ts`.
- UI projection: `apps/web/src/features/agent-runs/*`, `apps/web/src/hooks/use-project-agent-runs.ts`, `apps/web/src/components/ActivityPanel.tsx`, `apps/web/src/components/AgentTranscriptModal.tsx`.

Non-goals:

- Do not refactor implementation code in this planning pass.
- Do not design the whole Channel replacement here; record dependencies for the channel/mailbox handoff.
- Do not redesign workflow DAG execution except where it calls agent runs.
- Do not treat deleted test files in the current worktree as available coverage.

## 4. Current System Trace

### 4.1 Agent Definition and Spawn Preparation

- **Verified behavior:** Pods are persisted in `agents`, `agent_knowledge`, `agent_secrets`, `agent_mcp_servers`, and `agent_audit` in `packages/db/src/schema.ts`.
- **Verified behavior:** `packages/db/src/repos/pods.ts` provides CRUD/audit and dispatch resolution:
  - `resolveAgentForDispatch(name, projectId)` prefers project-scoped pods, then global pods.
  - `getPodForSpawn(name, projectId)` returns the resolved agent plus scope-specific knowledge, secrets, and MCP servers.
- **Verified behavior:** `apps/server/src/services/pod-spawn.ts::preparePodSpawn` materializes a per-run plugin, MCP config, settings file, secrets env vars, and optional work-item assignment prompt. It returns `podScope` and `podProjectId` for callers that need exact pod revision scope.
- **Verified behavior:** Pod routes live in legacy route layout at `apps/server/src/routes/pod-routes.ts`, not under `apps/server/src/features/agents`.

### 4.2 Dispatch Flow

1. **Inbound MCP:** `packages/mcp/src/tools/agent-runs.ts::pc_invoke_agent` posts to `/api/projects/:projectId/agents/:name/invoke` with `input`, `dispatcherSessionId`, depth, and optional work-item IDs.
2. **HTTP route:** `apps/server/src/features/agent-runs/routes.ts` validates project, agent name, input, dispatcher session, and invoke depth.
3. **Application-ish service:** `apps/server/src/services/agent-run-factory.ts::dispatchFreshAgent`:
   - resolves pod with `resolveAgentForDispatch`;
   - creates run scratch dir under `data/projects/<projectId>/agent-runs-v2/<runId>`;
   - validates assigned work item and expected output when `workItemId` is supplied;
   - calls `preparePodSpawn`;
   - computes `podRevisionAtDispatch`;
   - inserts `agent_runs` row as `queued`;
   - writes `work_items.assigned_agent_run_id` for contract dispatches;
   - starts either in-process `AgentRun` or host-backed run.
4. **Runtime lifecycle:** `packages/runtime/src/agent-run.ts::AgentRun` moves `queued -> spawning -> running -> paused/completed/failed/cancelled`, owns timers and `LowLevelSpawn` lifecycle, emits `state`, `jsonl-event`, `queued-started`, and `terminal`.
5. **Persistence/projection:** `agent-run-factory.ts::constructAndStart` mirrors state into `agent_runs`, stamps PID/activity, broadcasts `agent-run-changed`, broadcasts `agent-jsonl-event`, and applies terminal effects.
6. **Delivery:** terminal and queued-started notices use `apps/server/src/services/agent-delivery.ts::enqueueAndPush`, which writes `agent_inbox` unless `PC_DELIVERY_TRANSPORT=channel-only`, then attempts Channel delivery.

### 4.3 Continue Flow

- **Verified behavior:** `pc_continue_agent` posts to `/api/projects/:projectId/agent-runs/:runId/continue`.
- **Verified behavior:** Route enforces same project and same `dispatcherSessionId`.
- **Verified behavior:** `apps/server/src/services/pause-resume.ts::continueAgent` requires parent run status `completed` or `failed`, rejects concurrent non-terminal continuations, requires the parent JSONL file to exist, inserts a new `agent_runs` row with `continues=<parent>`, and reuses the parent `ccSessionId`.
- **Verified behavior:** `dispatchContinueAgent` materializes the same pod and starts a new `AgentRun` in `resume` mode with follow-up input.

### 4.4 Pause/Resume Flow

- **Verified behavior:** Worker-side MCP tools `pc_ask_orchestrator`, `pc_ask_user`, and `pc_request_approval` post to `/api/projects/:projectId/agent-pending-asks`.
- **Verified behavior:** `recordExplicitPause` looks up the active run in the process-wide registry, requires `running`, inserts a `pending_asks` row with status `open`, calls `entry.run.markPaused`, persists `agent_runs.status='paused'`, and delivers an `agent-asks-*` Channel/inbox event.
- **Verified behavior:** `pc_answer_pending` posts to `/api/projects/:projectId/agent-pending-asks/:askId/answer`. `answerPendingAsk` flips the pending ask `open -> answered`, looks up the active run, persists `spawning` plus `podRevisionAtResume`, then calls `entry.run.resumeWithAnswer(answer)`.
- **Verified behavior:** Paused runs depend on an active registry handle for answer/resume in the in-process path.

### 4.5 Terminal Effects and Verification

- **Verified behavior:** `apps/server/src/services/agent-run-terminal-effects.ts::applyAgentRunTerminalEffects` idempotently marks the DB row terminal, unregisters active handles, runs async terminal follow-up, and broadcasts an `agent-run-changed` terminal snapshot.
- **Verified behavior:** `apps/server/src/services/agent-verification.ts::runVerificationOnTerminal` applies work-item verification for assigned agent-task work items:
  - `failed` run -> work item failed;
  - `cancelled` run -> no automatic work-item update;
  - `completed` run -> tier-specific verification and optional auto-advance to done stage.
- **Verified behavior:** `apps/server/src/services/agent-verification-review.ts` lets approve/reject work items parked in `awaiting-verification`; reject dispatches a continuation of `assignedAgentRunId`.

### 4.6 Recovery, Inspection, and Kill

- **Verified behavior:** Server boot calls `reattachAgentRunsDuringServerBoot` in `apps/server/src/index.ts`. Without an agent host client it uses legacy reconciliation and marks every non-terminal row failed with `server-restart`.
- **Verified behavior:** With a host client, `agent-host-reattach.ts` compares host snapshots to DB rows, registers `HostBackedActiveRunHandle`s, backfills JSONL events, and subscribes to host events.
- **Verified behavior:** In-process liveness sweep runs every 30 seconds when no host client exists. It finalizes dead-pid or idle rows through terminal effects.
- **Verified behavior:** `/inspect` reads DB row, process liveness, JSONL mtime, and last JSONL action. `/kill` kills by persisted PID and finalizes through terminal effects.

### 4.7 UI Projection

- **Verified behavior:** `useProjectAgentRuns` uses `/api/projects/:id/agent-runs` for active rows and applies `agent-run-changed` WS envelopes via `useResourceList`.
- **Verified behavior:** `useResourceList` discards incoming snapshots whose `rev <= stored rev`.
- **Verified behavior:** `AgentTranscriptModal` loads `/agent-runs/:runId/events` and merges live `agent-jsonl-event` envelopes with backfill events.
- **Verified behavior:** Web agent-run DTOs are hand-written in `apps/web/src/features/agent-runs/types.ts`, not imported from shared contracts.

## 5. Integration Map

| Direction | Integration | Contract/State | Failure Boundary |
|---|---|---|---|
| Inbound | MCP `pc_invoke_agent`, `pc_continue_agent`, `pc_answer_pending`, pause tools | Hand-written tool schemas and HTTP payloads | MCP returns text errors; no shared contract validation |
| Inbound | Web Activity Panel | `/api/projects/:id/agent-runs`, `/events`, `/inspect`, `/kill`, WS events | WS has no durable replay; UI refetches on reconnect |
| Inbound | Work-item verification review | `dispatchContinueAgent` | Reject can flip work item before continuation succeeds |
| Inbound | Workflow DAG/service | `dag-run-service.ts` emits agent-run-shaped activity | Coupled to Activity Panel shape |
| Outbound | SQLite | `agent_runs`, `pending_asks`, `agent_inbox`, `agent_delivery_audit`, pod tables, work items | Durable state mixed with in-memory active handles |
| Outbound | Runtime process | `AgentRun`, `LowLevelSpawn`, optional `AgentHostService` | Process events are adapter-local and then mirrored |
| Outbound | Channel | `enqueueAndPush`, `ChannelServer.emitToSession` | Best-effort delivery; durable inbox is not full mailbox |
| Outbound | WebSocket | `agent-run-changed`, `agent-jsonl-event`, `channel-event` | Project-scoped fanout only; no canonical cursor/outbox |
| Outbound | Filesystem | Scratch dirs, transcript.log, Claude JSONL path | JSONL retention can prevent continuation |

## 6. Data and State Model

Owned durable state:

- `agent_runs`: lifecycle status, dispatcher/session IDs, pod name/revisions, lineage, parent work item, input/result, PID/activity timestamps, terminal fields, `rev`.
- `pending_asks`: one durable pause request per explicit pause event; answer/cancel status is atomic via `WHERE status='open'`.
- `agent_inbox` and `agent_delivery_audit`: durable-ish delivery rows and successful delivery audit.
- Agent pod tables: `agents`, `agent_knowledge`, `agent_secrets`, `agent_mcp_servers`, `agent_audit`.

Runtime/in-memory state:

- `AgentRunRegistry` global concurrency cap and FIFO queue.
- `ActiveRunRegistry` map by run ID and CC session ID.
- `AgentHostService` maps live host-owned runs, workflow subagents, and an in-memory event buffer.
- `ProjectWebSocketHub` connected browser sockets by project.
- Channel registrants by `(projectId, sessionId)`.

Read/mutated external state:

- `projects` for folder path/slug.
- `work_items` for agent contracts, assignment, verification state, and auto-advance.
- Claude JSONL files under provider project paths.
- Scratch/transcript files under `PC_DATA_DIR`.

Concurrency concerns:

- `agent_runs.rev` exists for versioned UI discard, but not every broadcast path reads the post-update rev.
- `pending_asks` answer/cancel flips are atomic at row level, but service ordering can mark an ask answered before verifying that resume can actually happen.
- Active handles are process-local unless host mode is active and successfully reattached.

## 7. Invariants and Compatibility Requirements

- `agent_runs.status` must remain closed-world: `queued | spawning | running | paused | completed | failed | cancelled`.
- A run must never be terminalized twice with different results.
- `pc_continue_agent` must only continue `completed` or `failed` runs and must reject concurrent continuations.
- `dispatcherSessionId` ownership must continue to gate continuation and delivery back to the original orchestrator.
- `agent_runs.rev` must be monotonic and WS snapshots must carry the current value.
- `agent-jsonl-event` live events plus `/events` backfill must keep transcript modal usable.
- `pc_invoke_agent` must remain async on the wire.
- Agent work-item verification must not mutate non-agent-task work items.
- Secrets must not be returned through pod read routes.
- Project-scoped pod overrides must win over global pods at dispatch/materialization.
- Existing MCP tool names and response shapes need compatibility wrappers during migration.

## 8. Related Subsystem Docs

| Related Subsystem | Current Dependency Verified in Code | Recommendation in That Doc | Assumed Implemented? | Potential Conflict | Coordination Needed |
|---|---|---|---|---|---|
| WebSocket/event propagation | `broadcastTo` sends `agent-run-changed` and `agent-jsonl-event` through `ProjectWebSocketHub`. | Documented in `refactor plan/refactor plan docs/ui-refresh-websocket-event-propagation.md` and marked `needs synthesis`. | No | Agent-run events need canonical envelope/cursor, but current UI expects raw shapes. | Align agent-run event migration with live-event contract/outbox decisions during synthesis. |
| Chat runtime and transcript UI | Channel events land in chat/orchestrator context; agent JSONL feeds transcript modal. | Not yet documented. | No | Chat may become view over durable runtime events, while agent runs currently read provider JSONL directly. | Decide shared transcript/event storage. |
| Workflows and workflow builder | Workflows can dispatch agents and emit agent-run-shaped activity. | Not yet documented. | No | Workflow subagents use host protocol but not `agent_runs` in the same way. | Separate workflow-run vs agent-run ownership. |
| MCP and tooling | MCP tools hand-roll HTTP payloads for agents/runs. | Not yet documented. | No | Target says MCP adapter over shared contracts, current tools duplicate routes. | Move after contracts exist. |
| Channel server replacement | Agent delivery uses Channel plus `agent_inbox`. | Not yet documented. | No | Target mailbox should replace Channel/inbox hybrid. | Preserve `pc_answer_pending` delivery semantics during mailbox migration. |

## 9. Current Issues

| Severity | Issue | Evidence | Impact | Likely Root Cause | Suggested Direction |
|---|---|---|---|---|---|
| High | Pending ask can become answered even when resume cannot happen. | `answerPendingAsk` calls `markPendingAskAnswered` before checking active run exists/state and before `resumeWithAnswer`; failures return `unknown-run`, `wrong-state`, or `resume-failed` after the row is answered. | User/orchestrator cannot retry the answer cleanly; run can remain paused/spawning inconsistently. | DB flip and runtime command are not one application-service transaction/saga. | Validate active resumability first, then flip and resume in a recoverable transaction/state machine; terminalize or restore explicitly on resume failure. |
| High | Cancelling a pending ask without an active handle can leave a paused run row stranded. | `cancelPendingAsk` marks ask cancelled, then only calls `entry.run.cancel()` if registry entry exists; no DB terminal effect if entry is missing. | A paused row may survive as non-terminal with no open ask and no active process until liveness/boot cleanup. | Pause lifecycle still depends on in-memory active handle. | Route cancel through a durable run command that can finalize the DB row even for phantom paused runs. |
| High | Host-mode state broadcasts can carry stale `rev`. | `agent-host-reattach.ts::applyAgentHostEvent` and `reconcileAgentRunsAgainstHost` update DB then call `agentRunRecordFor(row, hostRun)` using the pre-update row; UI discards snapshots with `rev <= stored rev`. | Activity panel can miss host-mode state transitions. | Broadcast adapter builds DTO from stale pre-update row. | Read row after update or have repo return updated row/rev in one command. |
| High | Agent-run events are not canonical live events. | Current envelopes are ad hoc: `agent-run-changed`, `agent-jsonl-event`, `channel-event`; no outbox/cursor schema. | Reconnect recovery depends on refetch and JSONL backfill, not durable event replay. | Live event layer predates target envelope. | Introduce canonical outbox/live envelope and map old shapes during migration. |
| Medium | Project-scoped pod revision drift detection is incomplete in pause/continue helpers. | `pause-resume.ts::lookupPodScope` always returns `null`, while `preparePodSpawn` already knows `podScope`/`podProjectId`. | Drift can be missed for project-scoped pod overrides during resume/continue. | Revision scope was not threaded through all paths. | Persist resolved pod ID/scope on `agent_runs` or pass scope from materialization into pause/continue logic. |
| Medium | Web pending-ask client does not match server routes/types. | Web client has `listAgentPendingAsks` GET `/agent-pending-asks`, but `agent-runs/routes.ts` only registers POST/answer/cancel; web types use `ask-orchestrator`/`waiting`, server uses `orchestrator`/`open`. | Any UI surface using that client would 404 or misinterpret rows. | Manually mirrored contracts drifted. | Add shared contracts and either implement GET projection or remove dead client API until the UI is built. |
| Medium | Pod routes are outside the feature cartridge layout. | `apps/server/src/routes/pod-routes.ts` owns pod API while web client lives in `apps/web/src/features/agents/client.ts`. | Agent catalog refactor will cross old/new route layouts. | Historical route organization. | Move behind `features/agents` route/service facade after contracts are introduced. |
| Medium | Agent delivery is durable-inbox plus Channel, not a full mailbox. | `agent-delivery.ts` writes `agent_inbox` then best-effort Channel push; inbox has only `pending/delivered`, no leases, ack/retry/dead-letter. | Delivery is more reliable than pure Channel but not target mailbox semantics. | Incremental hardening before mailbox design. | Treat as compatibility bridge for mailbox replacement. |
| Medium | Current worktree has no readable test files. | `rg --files --glob '!archive/**' | rg '(test|spec)\\.(ts|tsx|js|mjs)$'` returned none; git status reports many deleted tests. | Regression coverage cannot be verified from working tree. | Pre-existing dirty tree removed tests. | Restore/port focused tests before implementation work. |
| Low | Model and startedAt values in agent-run UI DTOs are adapter shims. | Multiple builders set `model: 'opus'`; `broadcastAgentRunChanged` uses current `Date.now()` as `startedAt` on some paths. | UI metadata can be inaccurate. | Legacy Activity Panel shape. | Shared DTO should distinguish stored lifecycle timestamps from display fallbacks. |

## 10. First-Principles Design

- **Recommendation:** Agent runs should be a durable command/state machine with runtime adapters, not a runtime wrapper that several adapters mirror manually.
- Responsibilities:
  - `agent definitions`: own pod catalog, scope resolution, content, secrets, MCP server bindings, audit.
  - `agent-run service`: own dispatch/continue/pause/answer/cancel/kill/inspect commands and query DTOs.
  - `runtime adapter`: own spawn, PTY/host protocol, JSONL tailing, process liveness, and raw event normalization.
  - `delivery/mailbox`: own durable recipient messages, delivery attempts, ack/retry/dead-letter.
  - `live projection`: publish canonical, resumable events derived from DB changes and normalized runtime events.
- Data model:
  - Keep `agent_runs` and `pending_asks`, but add explicit fields if needed for resolved pod ID/scope, host ownership, and event cursor.
  - Move delivery from `agent_inbox` to target mailbox tables when the channel replacement plan is ready.
- Error handling:
  - Mutating commands should be idempotent and return typed causes.
  - Cross-boundary operations should be modeled as recoverable state transitions, not best-effort side effects after irreversible flips.
- Observability:
  - Every command should record a durable transition/audit row and emit one canonical live event.
  - Inspect/kill should remain operator-grade diagnostics.

## 11. Target Architecture Alignment

| Target Cartridge Part | Current Status | Gap |
|---|---|---|
| contracts | Missing shared package. Domain types exist, web/MCP/server DTOs are hand-written. | Introduce browser-safe contract schemas for agent pods, runs, pending asks, transcript events. |
| domain | `@pc/domain` owns statuses, row shapes, agent comms, pod validation. | Domain includes persisted row shapes, but command rules live in server services. |
| db repo | Strong coverage in `@pc/db` for pods, runs, asks, inbox. | Some commands need transactional repo APIs that return updated rows/revs. |
| application service | Partial in `agent-run-factory`, `pause-resume`, terminal effects. | Split across route-ish services and runtime-specific concerns. |
| HTTP route | `features/agent-runs/routes.ts` and legacy `routes/pod-routes.ts`. | Pod routes should move behind feature/service shape. |
| live events | Ad hoc WS events via `broadcastTo`. | No canonical event envelope, outbox, cursor, or replay. |
| web client/hooks | Feature clients/hooks exist. | Types duplicate server/domain; some pending-ask APIs drift. |
| MCP adapter | Agent-run tools exist. | MCP hand-rolls HTTP schemas and error parsing. |
| tests | Test files are absent in current worktree. | Need focused tests restored/created before implementation. |

Cross-cutting alignment:

- **Shared contracts:** Required before route/MCP/UI refactor.
- **Canonical live events:** Required for reliable Activity Panel and transcript recovery.
- **Durable mailbox:** Required to replace Channel/inbox hybrid.
- **Runtime host boundary:** Agent host exists, but ownership with in-process path is not yet clean.
- **MCP adapter boundary:** Should call shared app service/typed client, not duplicate HTTP details.
- **UI fetch discipline:** Agent-run UI mostly uses feature client/hook; pending-ask client is ahead of server route.

## 12. Recommended Target Architecture

- Keep:
  - `agent_runs`, `pending_asks`, pod tables, verification services, operator inspect/kill concepts.
  - `AgentRun` runtime wrapper as a process adapter, not application service.
  - `preparePodSpawn` materialization boundary.
- Refactor:
  - Create `packages/contracts/agent-runs.ts` and `packages/contracts/agents.ts`.
  - Create `packages/app-services` or server-local service facade for agent-run commands first if package split waits.
  - Collapse dispatch/pause/continue/terminal command orchestration behind one `AgentRunService`.
  - Have repo/service methods return updated row snapshots with current `rev`.
  - Move pod HTTP route composition into `features/agents`.
- Replace later:
  - Channel/inbox delivery with mailbox; keep `enqueueAndPush` as compatibility adapter until mailbox is live.
  - Ad hoc WS envelopes with canonical live events plus legacy adapter emissions.
- Decisions for holistic synthesis:
  - Whether chat transcript storage and agent transcript storage converge on one durable runtime-event table.
  - Whether agent host becomes mandatory for long-lived runs or remains optional.
  - How mailbox recipients address orchestrator sessions vs agent runs.

## 13. Migration Strategy

| Phase | Goal | Files Likely Affected | Dependencies | Risks | Verification | Restart/Reload |
|---|---|---|---|---|---|---|
| 1 | Restore/establish focused tests and contract inventory. | `apps/server/test/*agent*`, `packages/db/test/*agent*`, `packages/runtime/test/*agent*` or new test paths. | Current test tree state must be resolved. | Dirty tree may hide deleted tests. | Unit tests for answer/cancel/rev/pending ask. | No app restart. |
| 2 | Add shared contracts for run/pending-ask DTOs and route payloads. | New `packages/contracts`, `agent-runs/routes.ts`, web client, MCP tools. | Package layout decision. | Wide imports. | Typecheck plus route/client contract tests. | Server reload for implementation. |
| 3 | Fix command atomicity around pending asks. | `pause-resume.ts`, pending-ask repo, agent-run terminal effects. | Tests from phase 1. | Resume behavior is user-visible. | Simulate missing active handle, wrong state, resume throw. | Server reload. |
| 4 | Normalize row update + broadcast current rev. | `agent-host-reattach.ts`, `agent-run-factory.ts`, `agent-run-boot-reconcile.ts`, repos. | Contract DTOs helpful but not required. | UI could regress stale discard. | Host-mode state-event tests; `useResourceList` stale rev scenario. | Server reload. |
| 5 | Introduce agent-run application service facade. | `agent-run-factory.ts`, `pause-resume.ts`, `agent-run-control.ts`, routes, MCP adapter. | Contract DTOs. | Large behavioral surface. | Dispatch/continue/pause/cancel/kill integration tests. | Server reload. |
| 6 | Canonical live event adapter. | `websocket-hub`, agent-run service, web hooks. | WebSocket subsystem plan. | UI update regressions. | Reconnect/refetch/backfill tests. | Server reload/web reload. |
| 7 | Mailbox migration. | `agent-delivery.ts`, `agent_inbox` repos/schema, Channel code, MCP/orchestrator prompt path. | Channel replacement plan. | Delivery semantics to running orchestrators. | Delivery retry/ack/replay tests. | Server/Channel reload. |

Rollback notes:

- Keep legacy HTTP and WS shapes until the web and MCP adapters are migrated.
- Keep `agent_inbox` and `enqueueAndPush` behind a transport-mode flag until mailbox proves equivalent.
- Avoid changing `AgentRun` state names without a compatibility layer.

## 14. Acceptance Criteria

- Dispatch, continue, pause, answer, cancel, inspect, kill, and terminal verification have shared typed contracts.
- Every agent-run status mutation updates SQLite and emits one current-version live event.
- A stale WS event cannot override a newer UI snapshot.
- A failed resume attempt cannot silently consume a pending ask without a recoverable run state.
- A cancelled pending ask always leaves the associated run terminal or explicitly recoverable.
- Project-scoped pod overrides have correct revision tracking across dispatch/resume/continue.
- Transcript modal can recover with backfill plus live events after reconnect.
- MCP tools and web clients no longer maintain divergent request/response types.
- Channel compatibility remains until mailbox replacement is implemented.

## 15. Test Plan

Existing tests:

- **Verified current worktree:** no test/spec files are currently discoverable outside `archive/`.
- **Inference:** Many agent-related tests existed in tracked history based on `git status` deleted paths, but they are not available as current worktree evidence.

Required unit tests:

- `answerPendingAsk` does not mark ask answered when active run is missing or wrong state.
- Resume failure leaves pending ask/run in a documented recoverable state.
- `cancelPendingAsk` finalizes or explicitly recovers a paused run with no active handle.
- Host event state update broadcasts current `rev`.
- `computePodRevision` uses project scope for project-scoped pods.
- `AgentRun` state/timer behavior remains stable for queued cancel, running cancel, pause, resume first-turn timeout, and late success.

Required integration tests:

- MCP `pc_invoke_agent` -> HTTP route -> row insert -> activity broadcast.
- `pc_continue_agent` ownership, JSONL retention, and concurrent continuation guards.
- Agent terminal -> work-item verification -> channel/inbox delivery -> activity broadcast.
- Transcript modal backfill endpoint with missing/empty/ready JSONL.
- Boot reconcile/liveness behavior in host and non-host modes.

Manual verification:

- Dispatch an agent from orchestrator, observe Activity Panel queued/running/terminal transitions.
- Open transcript before and after terminal.
- Pause via `pc_ask_orchestrator`, answer via `pc_answer_pending`, verify run resumes.
- Kill a deliberately wedged run with inspect/kill controls.

## 16. Implementation Notes for Next Agent

- Start with tests around `apps/server/src/services/pause-resume.ts`; the highest-risk bugs are local and testable without running the app.
- Read `apps/server/src/features/agent-runs/routes.ts` and `apps/server/src/services/agent-run-factory.ts` together; neither alone shows the full command contract.
- Treat `AgentRun` in `packages/runtime/src/agent-run.ts` as runtime adapter code. Avoid moving product rules into it.
- Preserve `PC_AGENT_RUN_ID`, `PC_DISPATCHER_SESSION_ID`, `PC_PROJECT_ID`, and `PC_AGENT_WORK_ITEM_ID` env vars while MCP compatibility exists.
- Do not remove `agent-run-changed` or `agent-jsonl-event` until web adapters are migrated.
- Be careful with terminal effects: `applyAgentRunTerminalEffects` intentionally runs verification asynchronously after the DB terminal flip.
- Watch for project-scoped pod shadowing. Use resolved pod ID/scope instead of recomputing by name when possible.
- Do not use `archive/` for test recovery or evidence.

## 17. Handoff Metadata

| Field | Value |
|---|---|
| Subsystem | Agents and agent runs |
| Primary owner area | `apps/server`, `packages/runtime`, `packages/db`, `packages/domain`, `packages/mcp`, `apps/web` |
| Runtime process | Server process; optional agent-host process; Claude/PTY child process |
| Owns state | `agent_runs`, `pending_asks`, agent pod tables, agent delivery rows |
| Reads state from | `projects`, `work_items`, Claude JSONL files, active run registries, Channel registrants |
| Writes state to | `agent_runs`, `pending_asks`, `agent_inbox`, `agent_delivery_audit`, `work_items`, scratch/transcript files |
| Inbound contracts | MCP tools, HTTP routes, web Activity Panel/client, workflow verification review |
| Outbound contracts | Runtime/host protocol, WebSocket events, Channel events, work-item verification updates |
| Hard dependencies | SQLite, runtime spawn, project folder path, pod materialization, MCP env contract |
| Soft dependencies | Agent host, Channel, WebSocket UI projection, JSONL retention settings |
| Restart required for implementation changes | Server reload for route/service/runtime changes; web reload for client/hook changes; no restart for this doc |
| Migration risk | High |
| Target architecture status | Refactor, then split/merge around contracts/app-service/live/mailbox |
| Related docs consulted | `target-architecture.md`, `subsystem-architecture-handoff-prompt.md`, `refactor-tracker.md`, `refactor plan docs/README.md` |

## 18. Tracker Update

- Update `Agent runs` row to `needs synthesis`.
- Baseline branch: `dev`.
- Baseline commit: `d114fc2535c1116f6eb2d883f9cac2a9193a8254`.
- Owner area: `apps/server`, `packages/runtime`, `packages/db`, `packages/domain`, `packages/mcp`, `apps/web`.
- Runtime process: server/runtime/optional agent-host/Claude child.
- Migration risk: high.
- Target recommendation: refactor behind shared contracts and an app-service boundary; keep DB-first run state; replace Channel delivery through mailbox in a coordinated plan.
- Dependencies/open questions: WebSocket canonical events, chat transcript ownership, workflow dispatch semantics, MCP contracts, mailbox replacement, test tree restoration.

## 19. Open Questions

- **Open question:** Should agent host become mandatory for durable run survival across server restart, or should in-process paused runs become resumable from DB/JSONL without a host?
- **Open question:** Should `agent_runs` store resolved pod ID/scope instead of only `podName` and revision strings?
- **Open question:** Should agent transcript events be persisted into a PC-owned event table, or is provider JSONL plus backfill acceptable during migration?
- **Open question:** What is the final mailbox recipient identifier: orchestrator PC session, agent run ID, workflow run node, or all of them?
- **Open question:** Should pending asks have a first-class UI route/surface, or remain orchestrator-mediated through chat?
- **Open question:** How should work-item verification rollback behave when reject flips a work item but continuation dispatch fails?
- **Conflict:** Target architecture wants canonical live events and mailbox; current implementation depends on raw WS event kinds plus Channel-delivered prompt blocks. This must be resolved in synthesis, not locally in the agent-run subsystem.
