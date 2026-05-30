# Workflows and Workflow Builder Architecture Handoff

## 1. Executive Summary

The workflow subsystem already has several strong foundations: workflow definitions are stored in SQLite, the DAG validation/execution core is mostly isolated in `packages/workflows`, run state is persisted in `workflow_runs_v2`, and the web UI has a usable workflow list, run detail panel, graph renderer, and transient builder modal. The practical refactor should keep those assets and split the subsystem around durable workflow definition ownership, durable workflow run ownership, a shared contract layer, canonical live events, and a clearly bounded builder service.

The risky parts are identity, cancellation, recovery, review handling, and cross-subsystem contracts. Current workflow runs identify their workflow by slug rather than by workflow row/version, duplicate definitions can fire under the source workflow id, cancellation marks rows cancelled without stopping active work, non-terminal runs have no boot reconciliation, review decisions are accepted without enough state validation, and the builder/review paths rely on transient events that are not durable facts. These issues cross into WebSocket projection, agents, work items, MCP, and the future mailbox/inbox design, so this subsystem should be marked ready for synthesis rather than independently "solved" in this document.

Recommended next architecture: introduce a server-owned `WorkflowDefinitionService` and `WorkflowRunService`, persist workflow run identity against a stable workflow definition row/version, make `WorkflowRunService` the only writer of run status/review decisions/cancellation, keep `@pc/workflows` as the pure DAG package, generate or share typed contracts for web and MCP clients, and route all workflow live updates through the same fact/event projection model planned for UI refresh.

## 2. Baseline

| Field | Value |
| --- | --- |
| Branch | `dev` |
| Commit | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` |
| Commit subject | `fix(web): reconcile agent/workflow lists on every WS (re)connect -- no more refresh` |
| Working tree note | Dirty before this document was created; many deleted tests/docs and untracked `refactor plan/` files were present. |
| Evidence exclusions | `archive/` was not searched, read, cited, or used. |

## 3. Scope and Non-Goals

In scope:

| Area | Files and symbols |
| --- | --- |
| Workflow definition model | `packages/domain/src/workflow-v2.ts`, `packages/domain/src/workflow-row.ts`, `packages/workflows/src/serialize-v2.ts`, `packages/workflows/src/registry-v2.ts` |
| DAG validation/runtime brain | `packages/workflows/src/dag/validate.ts`, `packages/workflows/src/dag/step.ts`, `packages/workflows/src/dag/triggers.ts`, `packages/workflows/src/dag/topo.ts`, `packages/workflows/src/dag/when.ts`, `packages/workflows/src/dag/refs.ts` |
| Workflow persistence | `packages/db/src/schema.ts`, `packages/db/src/repos/workflows.ts`, `packages/db/src/repos/workflow-runs-v2.ts`, `packages/db/src/repos/workflow-audit.ts` |
| Server workflow APIs | `apps/server/src/routes/workflow-routes.ts`, `apps/server/src/features/workflow-compat/routes.ts` |
| Workflow runtime | `apps/server/src/services/project-runtime.ts`, `apps/server/src/services/dag-run-service.ts`, `apps/server/src/services/dag-executor.ts`, `apps/server/src/services/workflow-run-writer.ts`, `apps/server/src/services/workflow-import.ts`, `apps/server/src/services/workflow-subagent-handshake.ts` |
| Workflow builder | `apps/server/src/services/project-runtime.ts`, `apps/server/src/services/workflow-builder-pod-content.ts`, `apps/server/src/features/transient-sessions/routes.ts`, `apps/web/src/components/WorkflowBuilderModal.tsx`, `apps/web/src/components/WorkflowBuilderChat.tsx`, `apps/web/src/components/WorkflowGraphV2.tsx` |
| Web workflow UI | `apps/web/src/features/workflows/client.ts`, `apps/web/src/hooks/use-project-workflows.ts`, `apps/web/src/hooks/use-project-workflow-v2-runs.ts`, `apps/web/src/components/WorkflowsList.tsx`, `apps/web/src/store/workflows-list-nav.ts` |
| MCP workflow adapter | `packages/mcp/src/tools/workflows.ts`, `packages/runtime/src/subagent-spawner.ts` |

Non-goals:

- Implementing code refactors.
- Redesigning the entire work item/stage system.
- Replacing Channel directly; this document records where workflow review/messaging depends on that future subsystem.
- Treating previous subsystem recommendations as implemented behavior unless verified in code.

## 4. Current System Trace

### Definition Load and Import

Verified behavior:

1. `ProjectRuntime.bootstrap()` calls `importV2WorkflowsFromDisk()` once per runtime in `apps/server/src/services/project-runtime.ts`.
2. Imported and API-created workflows land in SQLite through `packages/db/src/repos/workflows.ts`.
3. The `workflows` table stores `scope`, `projectId`, `slug`, `name`, raw `yaml`, `yamlHash`, parsed JSON `parsedDefinition`, `status`, `parseError`, `disabled`, and soft-delete timestamps.
4. `workflow_audit` records create/update/delete/promote/duplicate-style mutations.
5. `ProjectRuntime.listV2Workflows()` maps DB rows into the legacy valid/invalid workflow shape expected by older server and web code.
6. `ProjectRuntime.findV2WorkflowBySlug()` resolves a project-scoped row first, then falls back to global.

Inference:

- The current system is already closer to the target direction than the old disk-owned workflow model, but the compatibility surface still treats slug as the durable identity.

### Definition CRUD and Fire

Verified behavior:

1. `apps/server/src/routes/workflow-routes.ts` exposes `/api/workflows` list/get/audit/create/update/delete/promote/duplicate/fire.
2. `normaliseDef()` accepts either a parsed `def` or raw `yaml`.
3. Create/update/duplicate/promote paths call `emitChanged()`, which broadcasts `workflow-changed`.
4. For project-scoped workflow rows, `emitChanged()` uses `broadcastTo(projectId, ...)`.
5. For global workflow rows, `emitChanged()` uses `broadcastAll(...)`.
6. `POST /api/workflows/:id/fire` validates the row is active and not disabled, rejects project-scoped pod workflows, then calls `deps.fireWorkflow(projectId, def, trigger)`.
7. Compatibility routes in `apps/server/src/features/workflow-compat/routes.ts` still serve workflow definitions and runs under `/api/projects/:projectId/workflow-v2/...`.

Conflict:

- The new CRUD/fire surface is `/api/workflows`, while run and review operations still use compatibility routes. This preserves behavior but splits the API contract for the same domain.

### Stage Entry Trigger

Verified behavior:

1. `ProjectRuntime.moveAndFireV2()` moves a work item to a stage.
2. It calls `selectStageEntryWorkflows()` to find active workflows whose trigger matches the target stage.
3. It fires all matching workflows and logs individual fire errors without rolling back the work item move.
4. `moveWorkItem()` inside the DAG executor intentionally avoids firing stage-entry workflows when a workflow moves a card.

Inference:

- This avoids recursive workflow loops, but it is an implicit runtime invariant rather than a contract visible to workflow authors or validators.

### Run Creation and Execution

Verified behavior:

1. `ProjectRuntime.fireV2Workflow()` calls `fireDagWorkflow()` and attaches only `res.done.catch(console.error)` to the async execution.
2. `fireDagWorkflow()` may create a root work item, ensures a worktree, creates a `workflow_runs_v2` row, marks it started, broadcasts via `announceRunCreated()`, then starts `DagExecutor.advance()` asynchronously.
3. `workflow_runs_v2` stores `id`, `workflowId`, `workflowName`, `projectId`, `workItemId`, `trigger`, `stageId`, `workflowYamlSnapshot`, `worktreePath`, `dagState`, `rev`, and timestamps.
4. The schema comment states `workflow_runs_v2.workflowId` is the workflow slug/id from YAML.
5. `workflow_run_events` records event history, but the execution source of truth is the sidecar `dagState` in `workflow_runs_v2`.
6. `apps/server/src/services/workflow-run-writer.ts` is the main run write door and broadcasts `workflow-v2-run-changed` with `{ type, projectId, run }`.

Recommendation:

- Keep sidecar snapshots during migration, but make the run row reference a stable workflow definition row/version and make `workflow_run_events` either a true event log or explicitly observability-only.

### DAG Executor

Verified behavior:

1. `DagExecutor` is injected with dependencies for status changes, agent dispatch, shell/script execution, work item movement, review requests, and persistence.
2. `advance()` checks cancellation only between layers.
3. Non-review nodes in the same ready layer can run concurrently.
4. Review nodes pause the run after `requestReview()`.
5. `onReviewDecision()` applies the decision and advances, but does not validate that the run is currently paused or that the node is currently awaiting review.

Inference:

- `DagExecutor` is a good candidate to remain pure and injected. State transition validation should move to a service/repository boundary around it rather than be spread across route handlers and executor callbacks.

### Agent and Command Steps

Verified behavior:

1. `makeExecutorDeps().dispatchAgent()` creates a child work item for a workflow node.
2. It prepares a project-scoped pod and inserts an `agent_runs` row manually.
3. It broadcasts `agent-run-changed`.
4. It runs either `spawnSubagent()` or a host-backed workflow spawner.
5. It verifies and terminalizes the `agent_runs` row when the subagent completes.
6. `runCommand()` executes shell/script nodes through `execFileAsync` for bash, node, or python.

Conflict:

- Workflow subagents use the agent run table and agent live events, but they are not owned by the normal agent active-run registry. This creates a cancellation/recovery mismatch between agent runs started from the agent UI and agent runs started by workflows.

### Review Steps

Verified behavior:

1. `requestReview()` posts a Channel message for `orchestrator-review`.
2. It broadcasts `workflow-v2-review-pending` for both `human-review` and `orchestrator-review`.
3. `applyV2ReviewDecision()` loads the run and calls `DagExecutor.resume(...).onReviewDecision(...)`.
4. `workflow-builder-pod-content.ts` explicitly tells the builder that standalone `human-review` approval UI is not wired and defaults to `orchestrator-review`.
5. No durable human review inbox consumer was found in the workflow UI.

Conflict:

- `human-review` appears in the workflow schema/runtime vocabulary, but the app does not provide a durable actionable UI for it.

### Workflow Builder

Verified behavior:

1. `WorkflowBuilderModal` starts a `workflow-builder` transient session when mounted and stops it on cleanup.
2. The server routes transient session events with prefixes including `workflow-builder-raw`, `workflow-builder-state`, `workflow-builder-event`, `workflow-builder-jsonl`, and `workflow-builder-exit`.
3. `ProjectRuntime` keeps builder drafts in an in-memory `workflowBuilderDrafts` map.
4. User graph edits POST draft state back to the server.
5. The modal listens for `workflow-builder-state`, `workflow-builder-exit`, `workflow-builder-draft`, and `workflow-changed`.
6. The graph editor uses `WorkflowGraphV2` plus `apps/web/src/lib/workflow-layout.ts`; graph editing supports drag, wiring, and edge deletion.

Inference:

- The builder is a transient authoring assistant, not a durable workflow definition service. Draft state and assistant session state should be separate from published workflow state.

### Web Client and Live Updates

Verified behavior:

1. `apps/web/src/features/workflows/client.ts` uses `/api/workflows` for workflow rows CRUD/fire.
2. The same client still uses `/api/projects/:projectId/workflow-v2/runs` and `/runs/:runId` for runs.
3. `useProjectWorkflows()` fetches `/api/workflows?projectId=...` and applies `workflow-changed` events to a local map.
4. `useProjectWorkflowV2Runs()` uses `useResourceList` with `workflow-v2-run-changed`, snapshot semantics, and `run.rev`.
5. `WorkflowsList` filters runs by `r.workflowId === selectedRow.slug`.
6. `RunInlineDetail` defines a local `V2RunChangedEnvelope` expecting top-level `runId`, `status`, and `dagState`, but the server sends nested `run`.

Conflict:

- The workflow list hook is bespoke and lacks the reconnect epoch pattern described by the UI refresh handoff, while run updates use a more canonical resource-list hook.

### MCP Adapter

Verified behavior:

1. `packages/mcp/src/tools/workflows.ts` implements workflow MCP tools as direct HTTP calls with hand-written request/response schemas.
2. `pc_publish_workflow` upserts by listing `/api/workflows` and then POSTing or PUTing a row.
3. `pc_fire_workflow` resolves a slug by listing `/api/workflows`, then POSTs `/api/workflows/:id/fire`.
4. `pc_complete_node` posts to the compatibility review endpoint.
5. `pc_node_failed` does not mutate server state itself; `packages/runtime/src/subagent-spawner.ts` detects the JSONL tool call and marks node failure from the tool input.

Conflict:

- MCP currently knows product API details directly. This conflicts with the target architecture where MCP should adapt shared contracts/services instead of acting as a second product API.

## 5. Integration Map

| Producer/Owner | Consumer | Contract/Event | Current state |
| --- | --- | --- | --- |
| `workflows` DB repo | Server routes, runtime, web list, MCP | Workflow row with `scope`, `projectId`, `slug`, `yaml`, `parsedDefinition` | Durable but slug-heavy |
| `WorkflowRunWriter` | Web run hooks, route readers | `workflow_runs_v2` row and `workflow-v2-run-changed` | Durable row, best-effort live event |
| `ProjectRuntime.moveAndFireV2()` | Work item stage flow | Stage-entry workflow trigger | Implicit; no stage-reference guard |
| `DagExecutor` | DB repos, agents, work items, Channel | Injected side effects | Good isolation, weak outer state ownership |
| Workflow review runtime | Channel and web | Channel message, `workflow-v2-review-pending`, compat review POST | Not durable enough for human-review |
| Workflow builder transient session | Web modal | `workflow-builder-*` WS events and in-memory draft | Transient-only |
| Workflow MCP tools | Server HTTP routes | Hand-written HTTP contract | Adapter bypasses shared app service |
| Workflow subagent runtime | Agent runs table, runtime host | `agent_runs`, MCP tool-call JSONL | Cross-owned lifecycle |

## 6. Data and State Model

| State | Current owner | Durability | Notes |
| --- | --- | --- | --- |
| Published workflow definition | `workflows` SQLite table | Durable | Good direction; needs stable row/version identity in runs. |
| Workflow YAML snapshot for a run | `workflow_runs_v2.workflowYamlSnapshot` | Durable | Useful compatibility and audit boundary. |
| DAG node state | `workflow_runs_v2.dagState` | Durable snapshot | Execution source of truth today. |
| Workflow run events | `workflow_run_events` | Durable | Observability/audit only today; not replay source. |
| Active executor process | In-memory async promise | Volatile | No registry or recovery handle was found. |
| Shell/script child process | `execFileAsync` call | Volatile | Cancellation does not propagate into child process. |
| Workflow subagent process | Runtime host / spawned subagent | Volatile plus `agent_runs` row | Not owned by normal agent active-run registry. |
| Builder session | Transient session/PTY | Volatile | Explicitly stopped on modal cleanup. |
| Builder draft | `ProjectRuntime.workflowBuilderDrafts` map | Volatile | Lost on server restart and session cleanup. |
| Review request | Channel message and WS event | Partly durable through Channel | Human review app surface is not wired. |
| Web workflow list state | React hook map | Volatile | Applies WS deltas; no reconnect epoch refetch. |

## 7. Invariants and Compatibility Requirements

Verified invariants:

- Workflow definitions are selected project-first, then global fallback.
- Workflow-driven work item moves do not trigger stage-entry workflows.
- Run state changes increment `rev` and broadcast `workflow-v2-run-changed`.
- Workflow definitions can be active/inactive, disabled, soft-deleted, global, or project-scoped.
- Builder sessions are transient and are not the source of published workflow truth.

Required compatibility:

- Preserve `/api/workflows` for current web and MCP CRUD/fire callers during migration.
- Preserve `/api/projects/:projectId/workflow-v2/runs` and review compatibility endpoints until web/MCP clients move to shared contracts.
- Keep existing YAML format and `@pc/workflows` DAG semantics compatible for published workflow definitions.
- Keep `workflowYamlSnapshot` or an equivalent immutable definition snapshot on runs for audit/debugging.
- Keep `workflow-v2-run-changed` semantics stable until the live-event projection refactor provides a versioned replacement.

Recommended new invariants:

- A workflow run must reference a stable workflow definition row/version, not only a slug.
- A review decision can only apply to a run that is paused at the target review node.
- Cancellation must either stop active work or mark the run as cancellation-requested until all active work reaches a terminal state.
- Boot must reconcile every non-terminal workflow run into a known recoverable, paused, cancelled, or failed state.
- Builder drafts must not be confused with published definitions or run snapshots.

## 8. Related Subsystem Docs

| Doc | Relevant context |
| --- | --- |
| `refactor plan/refactor plan docs/ui-refresh-websocket-event-propagation.md` | `workflow-changed`, `workflow-v2-run-changed`, and `workflow-builder-*` events are best-effort projections. Global workflow events may be filtered out by project-scoped web clients. |
| `refactor plan/refactor plan docs/chat-runtime-and-transcript-ui.md` | Chat groups workflow events and pending approvals. Review prompts intersect with chat/approval contracts. |
| `refactor plan/refactor plan docs/agents-and-agent-runs.md` | Workflows dispatch agent-shaped child work and write `agent_runs`; lifecycle ownership differs from normal agent runs. |

## 9. Current Issues

| Severity | Issue | Evidence | Impact | Fix direction |
| --- | --- | --- | --- | --- |
| High | Workflow runs identify definitions by slug only. | `workflow_runs_v2.workflowId` stores workflow slug/id from YAML; `WorkflowsList` filters runs by `r.workflowId === selectedRow.slug`; global and project workflow rows can share slugs. | Runs can be misattributed across global/project collisions, delete/cancel checks can target the wrong logical workflow, and deleted/recreated rows can inherit visible history by slug. | Add stable workflow definition row/version references to run rows; keep slug/name as display fields. |
| High | Duplicate workflow rows keep source definition id. | `duplicateWorkflow()` assigns a new row slug/name but copies `yaml` and `parsedDefinition` unchanged. | Firing a duplicate can create runs under the source workflow id and confuse list/run matching. | Rewrite `def.id` and YAML during duplicate, or force reserialization through a definition service. |
| High | Cancellation is row-only and does not stop active work. | `apps/server/src/index.ts` cancel path writes cancelled status; no active workflow-run registry was found; `DagExecutor.isCancelled()` is checked only between layers. | Shell commands, subagents, and active executor work can continue after UI/API cancellation. | Add `WorkflowRunService` active handle registry and propagate cancellation to executor, subprocesses, and subagents. |
| High | Non-terminal workflow runs have no boot reconciliation. | `ProjectRuntime.bootstrap()` imports definitions; no workflow-run boot recovery/reconcile path was found. | Restart can leave rows pending/running/paused forever with no executor. | Reconcile non-terminal workflow runs at boot into failed/cancelled/paused-recoverable states, with explicit host reattach only if supported. |
| High | Review decisions can apply out of state. | `applyV2ReviewDecision()` loads a run and calls `DagExecutor.resume(...).onReviewDecision(...)`; executor applies decisions without validating paused/current awaiting-review state. | Late, duplicate, or wrong-node review decisions can mutate DAG state incorrectly. | Validate run status and target node state atomically before applying a decision. |
| High/Medium | Async executor failures can leave rows running. | `ProjectRuntime.fireV2Workflow()` only logs `res.done.catch(console.error)`; executor side-effect failures can reject outside a final status writer. | Failed advances can strand run status. | Own executor promise in a run service and finalize failed on unhandled advance errors. |
| High/Medium | `human-review` is expressible but not product-wired. | `workflow-builder-pod-content.ts` says standalone approval UI is not wired; `workflow-v2-review-pending` has no durable workflow review inbox consumer found. | Workflow authors can create definitions with review steps that have no reliable human action surface. | Disallow publish/fire of `human-review` until implemented, or create a durable review inbox tied to mailbox/channel replacement. |
| High/Medium | Global workflow live events can be dropped by project-scoped clients. | `emitChanged()` uses `broadcastAll()` for global rows; UI refresh doc notes missing `projectId` events are filtered by project clients. | Global workflow create/update/delete may not refresh open project views. | Use canonical project-aware projection events or reconnect-aware refetch. |
| Medium | Workflow list hook does not follow reconnect epoch pattern. | `useProjectWorkflows()` is bespoke; `useProjectWorkflowV2Runs()` uses `useResourceList`. | Reconnects can leave stale workflow definitions. | Move workflow rows to shared resource-list/live-query hook. |
| Medium | Stage references are not validated against project stages. | `validateWorkflowV2()` checks shape/cycles/refs but not actual project stage ids; stage PATCH route only guards work item orphaning. | Stage renames/deletes can silently break triggers and move nodes. | Add shared stage-reference validator and stage update guard. |
| Medium | Invalid raw YAML create path cannot persist invalid rows as intended. | `normaliseDef()` may return empty slug for invalid YAML; POST then rejects `def.id required`. | Users cannot save invalid YAML drafts through the row API despite route-level invalid-row support. | Extract raw id/name before full parse or separate draft storage from published definitions. |
| Medium | Inline run detail listens for an obsolete event shape. | `RunInlineDetail` local `V2RunChangedEnvelope` expects top-level run fields, but `WorkflowRunWriter` broadcasts nested `run`. | Inline graph overlay can miss live updates. | Use shared `WorkflowV2RunChangedEnvelope` type and nested `run`. |
| Medium | MCP/web/server contracts are duplicated by hand. | `packages/mcp/src/tools/workflows.ts` hand-rolls HTTP calls and schemas. | API drift risk and duplicated validation. | Generate/share contracts and expose MCP as an adapter over app services. |
| Medium/Low | Stock pod prompt lists removed workflow endpoints. | `apps/server/src/services/stock-pod-seed.ts` references old workflow-v2 POST endpoints not present in compat routes. | Agents may call stale APIs or receive bad guidance. | Update prompt/tool catalog after workflow contracts are settled. |
| High for migration | Current test tree lacks active test files. | `rg --files --glob "!archive/**" | rg "(test|spec)\.(ts|tsx|js|mjs)$"` found no current test files; git status showed deleted workflow tests. | Refactor has little executable safety net in the current worktree. | Restore or recreate focused workflow tests before implementation. |

## 10. First-Principles Design

The workflow subsystem has four distinct concerns:

| Concern | Principle |
| --- | --- |
| Definition authoring | A workflow definition is a durable, versioned app object. Drafts and assistant sessions are not published definitions. |
| Run execution | A workflow run is a durable process record with explicit lifecycle ownership, idempotent state transitions, and recoverable terminalization. |
| Live UI | WebSocket events are projections of persisted facts, not the source of truth. Reconnect means refetch/reconcile. |
| Adapters | Web, MCP, builder assistants, and agent hosts should speak shared app contracts rather than hand-written product-specific variants. |

A durable workflow run should answer these questions without process memory:

- Which workflow definition row/version was executed?
- What immutable definition snapshot was executed?
- Which project/work item/stage/trigger caused the run?
- Which DAG nodes are pending, running, completed, failed, skipped, or awaiting review?
- Which external processes or child agent runs are attached?
- What cancellation/recovery state applies after restart?
- Which human or orchestrator action is currently required?

## 11. Target Architecture Alignment

| Target architecture principle | Current alignment | Gap |
| --- | --- | --- |
| Durable state lives in SQLite/server services | Definitions and runs are already in SQLite. | Active process lifecycle, builder drafts, and review pending state are still volatile or split. |
| Runtime processes emit facts | Runs write snapshots and events. | Events are not a canonical replayable fact stream; unhandled failures can skip terminal facts. |
| WebSocket projects facts to UI | `workflow-changed` and `workflow-v2-run-changed` project updates. | Events are best-effort and not consistently reconnect-safe. |
| Chat is view over durable conversation/runtime events | Workflow review and activity intersect with chat. | Review prompts are still Channel/live-event dependent. |
| Agents/workflows use explicit contracts | Workflows dispatch agent runs. | Agent lifecycle ownership and cancellation are split. |
| Channel replaced by durable mailbox/inbox | Workflow review needs this direction. | `human-review` lacks a durable inbox. |
| MCP adapter over shared services/contracts | MCP exposes workflow tools. | MCP currently hand-rolls HTTP product API details. |

## 12. Recommended Target Architecture

### Server Boundaries

| Service | Responsibilities |
| --- | --- |
| `WorkflowDefinitionService` | Create/update/delete/promote/duplicate/list/get definitions; parse/validate YAML; manage scope/project/global precedence; write audit; emit definition facts. |
| `WorkflowRunService` | Fire runs; own active handles; persist lifecycle transitions; apply review decisions; request cancellation; reconcile boot state; emit run facts. |
| `WorkflowReviewService` | Create review requests, bind them to run/node state, bridge to mailbox/Channel during migration, validate decisions. |
| `WorkflowBuilderService` | Own transient assistant sessions and optional durable drafts; publish only through `WorkflowDefinitionService`. |
| `WorkflowContracts` package or module | Shared route schemas, live event envelopes, MCP/web client types, and validation results. |

### Durable Model Changes

Recommended additions:

- Add `workflowDefinitionRowId` or equivalent stable foreign key to `workflow_runs_v2`.
- Add `workflowDefinitionVersion` or immutable snapshot hash to distinguish same-row edits.
- Keep `workflowId` slug as a compatibility/display column until migrated.
- Add explicit run lifecycle columns for `cancellationRequestedAt`, `recoveredAt`, `terminalReason`, or equivalent.
- Add a durable review request table or mailbox-backed record keyed by `runId` and `nodeId`.
- Decide whether `workflow_run_events` becomes append-only source-of-truth or remains audit-only. Do not leave it ambiguous.

### Live Event Shape

Recommended event families:

| Event | Source fact | Notes |
| --- | --- | --- |
| `workflow.definition.changed` | Definition row mutation | Include `projectId`, scope, row id, slug, rev/version, mutation type. |
| `workflow.run.changed` | Run row mutation | Include `projectId`, run id, workflow row/version, run rev, status. |
| `workflow.review.changed` | Review request mutation | Include `projectId`, run id, node id, review status/action target. |
| `workflow.builder.changed` | Builder session/draft mutation | Keep clearly transient unless drafts become durable. |

Compatibility can map these to existing `workflow-changed`, `workflow-v2-run-changed`, and `workflow-builder-*` while clients migrate.

### Web Architecture

Recommended shape:

- Replace `useProjectWorkflows()` with a resource-list/live-query hook aligned with `useProjectWorkflowV2Runs()`.
- Use shared workflow event envelopes; remove local event type redefinitions.
- Treat global workflow rows as visible project resources with project-aware projection or deterministic refetch.
- Keep `WorkflowGraphV2` as the renderer/editor, but separate visual draft state from published definition state.
- Add a durable pending review surface only after review records/mailbox contract exists.

### MCP Architecture

Recommended shape:

- MCP workflow tools call shared workflow client/contracts, not hand-written endpoint strings.
- `pc_publish_workflow` returns definition row id/version plus validation status.
- `pc_fire_workflow` accepts slug for UX but resolves to row/version through `WorkflowDefinitionService`.
- `pc_complete_node` and `pc_node_failed` target `WorkflowRunService` review/node transition contracts.
- Subagent-spawner JSONL detection should become a temporary adapter, not the canonical way node completion is recorded.

## 13. Migration Strategy

| Phase | Work | Acceptance |
| --- | --- | --- |
| 0. Safety tests | Restore/recreate focused tests for DAG validation, duplicate identity, run creation, cancellation, review decisions, live envelope shape, and MCP publish/fire. | Tests fail on current high-risk identity/review/cancellation cases where appropriate. |
| 1. Contract consolidation | Define shared workflow row, run, review, and event schemas. Move web and MCP clients to shared types without behavior changes. | No route behavior change; duplicate local event types removed. |
| 2. Definition service | Route create/update/delete/promote/duplicate through `WorkflowDefinitionService`. Fix duplicate id/YAML rewrite. | Duplicate firing creates runs under the duplicate identity. |
| 3. Run identity migration | Add workflow row/version reference to run rows and backfill from slug/scope where possible. Keep slug display compatibility. | Web run filtering uses stable row/version; slug collisions do not misattribute runs. |
| 4. Run service lifecycle | Introduce `WorkflowRunService` as only lifecycle writer. Own active handles, async failure terminalization, and cancellation requests. | Cancellation stops or explicitly drains active work; unhandled executor failures produce terminal rows. |
| 5. Boot reconciliation | Reconcile non-terminal workflow runs at server/project runtime boot. | Restarted app has no orphaned running rows without a recovery state. |
| 6. Review hardening | Persist review requests and validate decisions against paused run/node state. Bridge to Channel/mailbox as needed. | Duplicate/wrong-node decisions are rejected; pending review survives reconnect/restart. |
| 7. Live-event migration | Emit canonical workflow facts/projections and adapt old events during rollout. | Reconnect refetch and global workflow updates are deterministic. |
| 8. Builder durability decision | Either keep builder explicitly transient or add durable draft table. Publish only through definition service. | Modal close/restart behavior is intentional and documented. |
| 9. Compatibility cleanup | Remove obsolete compat routes/prompts after all clients migrate. | Stock pod prompts and MCP tools reference only supported contracts. |

## 14. Acceptance Criteria

- A workflow run records stable workflow definition identity and immutable executed definition version/snapshot.
- Global/project workflows with the same slug do not cross-contaminate run lists, delete guards, or fire results.
- Duplicating a workflow produces a definition whose `def.id`, YAML, row slug, and fired run identity agree.
- Cancelling a running workflow stops or coordinates every active executor, subprocess, and workflow subagent, or records a clear cancellation-requested/draining state.
- Server boot reconciles every non-terminal workflow run.
- Review decisions are accepted only for the current awaiting review node on a paused run.
- `human-review` is either rejected as unsupported or backed by a durable review inbox.
- Workflow list and run UI recover correctly after WebSocket reconnect.
- Web and MCP clients use shared workflow contracts rather than duplicated hand-written schemas.
- Compatibility routes remain until their current callers are migrated.

## 15. Test Plan

| Test layer | Cases |
| --- | --- |
| Unit: DAG validation | Cycles, missing refs, `when`, trigger shape, move node stage refs, review node shape. |
| Unit: definition service | Create/update invalid YAML, duplicate id rewrite, promote global/project precedence, audit writes. |
| Unit: run service | Fire row identity, async failure terminalization, cancellation request semantics, boot reconciliation. |
| Unit: review service | Accept current paused node, reject wrong node, reject duplicate decision, reject non-paused run. |
| Integration: server routes | `/api/workflows` CRUD/fire, compat run/review routes, validation errors, disabled/inactive workflows. |
| Integration: live events | `workflow-changed` compatibility, canonical run change envelope, global workflow visibility, reconnect refetch. |
| Integration: web hooks | Workflow list refetch on reconnect, run list snapshot updates, inline run detail uses nested `run`. |
| Integration: MCP | Publish/fetch/fire/complete-node through shared contracts; stale endpoint prompt regression. |
| Runtime | Cancellation of long shell command, workflow subagent cancellation, restart reconciliation of running/paused rows. |

Current test gap:

- No active test files were found in the current non-archive worktree. Restore or recreate tests before implementation.

## 16. Implementation Notes for the Next Agent

- Keep `packages/workflows` as the pure DAG package. It is one of the cleanest existing boundaries.
- Do not make `DagExecutor` know HTTP, WebSocket, or MCP. Put lifecycle validation in a service around it.
- Fix duplicate identity before or with run identity migration; otherwise migrated rows may preserve bad slug linkage.
- Treat workflow review as a cross-subsystem dependency on mailbox/channel synthesis. Do not silently invent a separate one-off inbox.
- Use `WorkflowRunWriter` or its replacement as the only write/broadcast path for run rows.
- Preserve compatibility events until web and MCP clients are migrated.
- Be careful with stage-entry triggers: workflow-driven stage moves currently do not recursively fire workflows.
- Do not use old endpoint references in `stock-pod-seed.ts` as evidence of supported API behavior; verified routes do not include the old POST workflow-v2 definition/fire endpoints.
- The builder should publish through the same definition service as manual CRUD. Assistant output should not bypass validation/audit.

## 17. Handoff Metadata

| Field | Value |
| --- | --- |
| Created | 2026-05-30 |
| Author | Codex |
| Baseline branch | `dev` |
| Baseline commit | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` |
| Subsystem status | Ready for holistic synthesis |
| Recommendation | Refactor around durable definition/run/review services, shared contracts, canonical live events, and explicit builder boundaries. |
| Highest risks | Run identity, cancellation, boot recovery, review state, WebSocket projection, MCP/API drift. |

## 18. Tracker Update

Update `refactor plan/refactor-tracker.md`:

- Set `Workflows and workflow builder` to `needs synthesis`.
- Baseline branch: `dev`.
- Baseline commit: `d114fc2535c1116f6eb2d883f9cac2a9193a8254`.
- Migration risk: `high`.
- Recommendation: split/refactor, preserving the DAG package and current UI pieces while introducing durable services and shared contracts.
- Notes: cross-subsystem conflicts remain with UI live events, agent run lifecycle, work item stages, MCP, transient sessions, and mailbox/review inbox design.

## 19. Open Questions

- Should `workflow_runs_v2` reference the mutable workflow row plus a version, or an immutable workflow definition revision table?
- Should workflow execution be recoverable after restart, or should every active run be terminalized with a clear restart failure reason?
- What is the product decision for `human-review`: disable it until mailbox exists, or implement a minimal durable review inbox first?
- Should builder drafts remain intentionally volatile, or become durable drafts tied to workflow definition rows?
- How should cancellation propagate through host-backed workflow subagents versus locally spawned subagents?
- Should `workflow_run_events` become the source event log, or should a new runtime event/fact table own replay/projection?
- How should stage rename/delete operations surface workflows that reference those stages?
- When can compatibility routes under `/api/projects/:projectId/workflow-v2/...` be removed?
