# Workflows Builder Visualizer Pod Audit

Status: complete.

Owner: Codex.

Worktree: `E:\Claude Code Projects\Personal\PC-PTY-Chat-phase5`.

Branch: `codex/phase-5-hardening`.

## Ownership

Server route modules:

- `apps/server/src/routes/workflow-routes.ts`: DB-backed workflow row CRUD, audit, duplicate, promote-to-global, soft-delete, fire-by-id, definition normalization, and `workflow-changed` broadcasts.
- `apps/server/src/features/workflow-compat/routes.ts`: builder draft endpoints, failed-run dismissals, legacy v2 definition/run list/get, and review decision endpoint.
- `apps/server/src/features/transient-sessions/routes.ts`: generic transient PTY routes for the workflow-builder session.

Server services:

- `apps/server/src/services/project-runtime.ts`: workflow import bootstrap, visible workflow lookup, stage-move trigger firing, review application, builder PTY lifecycle, and builder draft store.
- `apps/server/src/services/dag-run-service.ts`: live DAG runner wiring for work items, subagent spawn, bash/script execution, worktree binding, review broadcasts, run persistence, and manual/stage-trigger fire.
- `apps/server/src/services/dag-executor.ts`: injected executor loop, review pause/resume, reject kick-back, and terminal status derivation.
- `apps/server/src/services/workflow-import.ts`: one-shot `.project-companion/workflows/*.yaml` to DB importer.
- `apps/server/src/services/workflow-builder-pod-content.ts`: stock `workflow-builder` pod prompt, model, tool allowlist, and dispatch guidance.
- `apps/server/src/services/workflow-subagent-handshake.ts`: workflow subagent MCP handshake callback registry.
- `apps/server/src/services/workflow-event-header.ts` and `orchestrator-review-step.ts`: older orchestrator-review channel event helpers still covered by tests.

Packages:

- `packages/workflows/src/serialize-v2.ts`: v2 YAML marker, parse, validate, and serialize helpers.
- `packages/workflows/src/registry-v2.ts`: legacy on-disk v2 registry kept for compatibility.
- `packages/workflows/src/dag/*`: pure DAG topology, validation, trigger matching, ref substitution, `when:` parsing, and state machine helpers.
- `packages/domain/src/workflow-v2.ts`: v2 graph, node, trigger, run, DAG state, and event contracts.
- `packages/domain/src/workflow-row.ts`: persisted workflow row and audit contracts.
- `packages/db/src/repos/workflows.ts`: workflow row CRUD, scope resolution, audit-on-mutate, duplicate, promote, soft-delete, restore, and dispatch resolution.
- `packages/db/src/repos/workflow-runs-v2.ts`: v2 run sidecar and event log repo.
- `packages/db/src/repos/workflow-audit.ts` and `failed-run-dismissals.ts`: workflow history and Activity dismissal state.
- `packages/mcp/src/tools/workflows.ts`: `pc_*` workflow authoring, draft, publish, fire, review, and row-management tools.

Web modules:

- `apps/web/src/features/workflows/client.ts`: workflow row, v2 run, v2 definition, fire, duplicate, promote, delete, and compatibility clients.
- `apps/web/src/features/workflows/types.ts`: web-side workflow row and run contracts.
- `apps/web/src/hooks/use-project-workflows.ts`: workflow row fetch and `workflow-changed` delta merge.
- `apps/web/src/hooks/use-project-workflow-v2-runs.ts`: run list fetch and `workflow-v2-run-changed` merge/refetch behavior.
- `apps/web/src/components/WorkflowsList.tsx`: Workflows tab rail, filters, detail tabs, run controls, YAML editor, row menu, inline run detail, and builder modal launch.
- `apps/web/src/components/WorkflowBuilderModal.tsx`: two-pane workflow-builder modal, edit-mode handoff, live draft sync, graph changes, and close-on-publish behavior.
- `apps/web/src/components/WorkflowBuilderChat.tsx`: workflow-builder chat adapter over the transient chat surface.
- `apps/web/src/components/WorkflowGraphV2.tsx`: visualizer/authoring canvas, node dragging, wire editing, run-state overlays, and node click handling.
- `apps/web/src/lib/workflow-layout.ts`: ELK/manual layout adapter for visualizer nodes and forward/reject edges.
- `apps/web/src/store/workflows-list-nav.ts`: cross-tab workflow/run navigation state.

## Public Entry Points

HTTP:

- `GET /api/workflows`
- `POST /api/workflows`
- `GET /api/workflows/:id`
- `PUT /api/workflows/:id`
- `DELETE /api/workflows/:id`
- `GET /api/workflows/:id/audit`
- `POST /api/workflows/:id/promote-to-global`
- `POST /api/workflows/:id/duplicate`
- `POST /api/workflows/:id/fire`
- `POST /api/projects/:projectId/workflow-builder/start`
- `POST /api/projects/:projectId/workflow-builder/send`
- `POST /api/projects/:projectId/workflow-builder/interrupt`
- `POST /api/projects/:projectId/workflow-builder/terminal-input`
- `POST /api/projects/:projectId/workflow-builder/resize`
- `DELETE /api/projects/:projectId/workflow-builder`
- `POST /api/projects/:projectId/workflow-builder/draft`
- `GET /api/projects/:projectId/workflow-builder/draft/:sessionId`
- `GET /api/projects/:projectId/workflow-v2/definitions`
- `GET /api/projects/:projectId/workflow-v2/definitions/:wfId`
- `GET /api/projects/:projectId/workflow-v2/runs`
- `GET /api/projects/:projectId/workflow-v2/runs/:runId`
- `POST /api/projects/:projectId/workflow-v2/review`
- `GET /api/projects/:projectId/failed-run-dismissals`
- `POST /api/projects/:projectId/workflow-runs/:runId/dismiss`

WebSocket outbound:

- `workflow-changed`
- `workflow-builder-state`
- `workflow-builder-jsonl`
- `workflow-builder-exit`
- `workflow-builder-draft`
- `workflow-v2-run-changed`
- `workflow-v2-review-pending`
- `workflow-v2-human-hold`
- `agent-run-changed`
- `work-items-changed`

MCP:

- `pc_save_workflow_draft`
- `pc_read_workflow_draft`
- `pc_publish_workflow`
- `pc_list_workflows`
- `pc_fire_workflow`
- `pc_complete_node`
- `pc_node_failed`
- `pc_create_workflow`
- `pc_update_workflow`
- `pc_delete_workflow`
- `pc_get_workflow`

Persisted data:

- SQLite `workflows`, `workflow_audit`, `workflow_runs_v2`, `workflow_run_events`, `failed_run_dismissals`, workflow-created `work_items`, `agent_runs`, and generated project worktrees.
- Legacy project files under `.project-companion/workflows/*.yaml` are import inputs only after the DB promotion.

## User Workflows

Workflow list and details:

1. `WorkflowsList` fetches `/api/workflows?projectId=<active>`.
2. `useProjectWorkflows` applies `workflow-changed` envelopes for visible project/global rows.
3. Detail tabs show graph, runs, and raw YAML.
4. YAML save calls `PUT /api/workflows/:id`, then refetches as a fallback to the primary WebSocket update.

Builder authoring:

1. User opens `WorkflowBuilderModal`.
2. Modal starts the workflow-builder transient PTY.
3. `WorkflowBuilderChat` sends conversation messages through transient session routes.
4. The stock workflow-builder pod calls `pc_save_workflow_draft`.
5. Server stores the draft by transient `PC_SESSION_ID` and broadcasts `workflow-builder-draft`.
6. Modal renders the draft through `WorkflowGraphV2`.
7. User drag/wire edits call `/workflow-builder/draft` directly, keeping the agent and graph in sync.
8. `pc_publish_workflow` creates or updates the DB row and broadcasts `workflow-changed`.

Edit mode:

1. Workflows detail opens builder with the current parsed definition.
2. Modal sends an edit-mode handoff to the builder once ready.
3. Published row changes close the modal only when the changed slug matches the edited workflow.

Run and review:

1. `POST /api/workflows/:id/fire` resolves a DB row and project id.
2. `ProjectRuntime.fireV2Workflow` calls `fireDagWorkflow`.
3. Manual runs create a workflow-root work item; stage-on-entry runs reuse the moved work item.
4. The DAG runner may create a worktree, spawn agent nodes, execute bash/script nodes, move the root card, or pause for review.
5. Run state is stored in `workflow_runs_v2` and broadcast as `workflow-v2-run-changed`.
6. Orchestrator reviews are resumed through `/workflow-v2/review` or `pc_complete_node`.

Stage-on-entry:

1. Work item move calls `ProjectRuntime.moveAndFireV2`.
2. Runtime commits the move, then selects matching active v2 workflows.
3. Each match fires with trigger `{ kind: 'stage-on-entry', stage }`.
4. Trigger errors are logged after the card move succeeds.

## Dependency Map

Imports into the pod:

- Work items provide root cards, child agent contract rows, status moves, and typed-field outputs.
- Project lifecycle provides project records, stage lists, project folders, runtime registry, and worktree paths.
- Agents/pods provide stock `workflow-builder`, dispatch pod rows, expected output defaults, and tool allowlists.
- Runtime/terminal provides `PtySession`, transient chat JSONL, and subagent spawning.
- Channel server carries orchestrator-review messages.
- MCP bridge exposes authoring and runtime workflow tools to agents.

Imports out of the pod:

- Work item stage moves can trigger workflows.
- Activity panel and agent-run surfaces consume workflow-spawned `agent-run-changed` records.
- Chat parses workflow event headers and can route users into workflow runs.
- Project context scaffolding still copies workflow templates into projects before import.

Cross-pod calls that should stay explicit:

- Workflow execution may create or move work items, but work-item validation stays in WorkItemService/repo.
- Workflow agent nodes may spawn pods, but pod resolution and MCP config materialization stay in pod-spawn services.
- Workflow-builder is a transient modal session, but generic transient PTY route wiring stays shared.
- Workflows own graph validation and run state; chat/runtime own display and delivery of PTY/JSONL envelopes.

## Dead Code And Drift

- Fixed: web `fireWorkflowRow` now types the success body as `{ ok, runId, rootWorkItemId }`, matching server, service, MCP docs, and tests.
- Workflow route create and update paths duplicate the same stage-on-entry collision scan before calling `validateWorkflowV2`.
- Legacy v2 compatibility routes and `WorkflowV2Registry` are still present. They may be intentional until all clients are on `/api/workflows`, but they are now secondary to DB rows.
- `orchestrator-review-step.ts` uses an older domain shape and channel body helper separate from `dag-run-service.ts` review dispatch.
- `pc_node_failed` MCP handler currently returns an acknowledgement; the actual node failure closure depends on transcript-side detection outside this handler.
- `human-review` is schema-valid and visible in the graph, but the workflow-builder prompt says its standalone approval UI is not wired.
- No safe deletes were proven during this initial pass.

## Tests And Gaps

Existing focused tests:

- `apps/server/test/workflow-routes.test.ts`: DB workflow CRUD, soft delete, duplicate, promote, fire, audit, and broadcast envelopes.
- `apps/server/test/workflow-compat-routes.test.ts`: builder draft, definition/run compatibility, dismissals, and review endpoint envelopes.
- `apps/server/test/workflow-builder-draft-store.test.ts`: runtime draft store and workflow-builder session cleanup behavior.
- `apps/server/test/workflow-import.test.ts`: YAML import, invalid rows, idempotence, cleanup, and missing directory handling.
- `apps/server/test/project-runtime-move-v2.test.ts`: stage-on-entry trigger selection and fire behavior on moves.
- `apps/server/test/dag-run-service.test.ts`: live DAG runner integration against fake deps, review pause/resume, move-work-item, worktree binding, and stdout refs.
- `apps/server/test/dag-executor.test.ts`: executor control flow, review pause/approve/reject, carry values, and terminal statuses.
- `apps/server/test/orchestrator-review-step.test.ts`: older orchestrator-review channel helper.
- `packages/workflows/test/*.test.ts`: v2 parse/serialize, registry, trigger matching, validation, topology, refs, and pure DAG step state.
- `packages/db/test/workflows-repo.test.ts`: workflow repo CRUD, scope, audit, duplicate, promote, delete, and resolution behavior.
- `packages/db/test/workflow-runs-v2.test.ts`: v2 run sidecar and event repo behavior.
- `packages/mcp/test/workflows-tools.test.ts`: MCP workflow tool metadata and handler behavior.
- `packages/domain/test/workflow-*.test.ts`: older workflow domain/catalog/ports/edges compatibility.

Missing tests or trace evidence:

- No focused web test pins the workflow fire response contract against server `rootWorkItemId`.
- No browser smoke verified Workflows tab rail, filters, YAML save, Run now, builder modal split, graph drag/wire, edit mode, or inline run detail in this session.
- No test proves `human-review` intentionally parks without an actionable UI.
- No test asserts the workflow-builder prompt/tool allowlist stays aligned with the actual MCP tool names and route behavior.
- No frontend canvas/layout screenshot or pixel check was run for `WorkflowGraphV2`.

## Cleanup Plan

Do not change DAG execution semantics, review behavior, stage-on-entry firing, worktree creation, or workflow-builder transient session lifecycle without a failing trace.

Small cleanup candidates:

- Done: aligned web `fireWorkflowRow` response type with server `rootWorkItemId`.
- Extract the duplicate workflow route stage-on-entry collision scan into a local helper and keep existing route tests as the guard.
- Consider a prompt/tool allowlist drift test for the workflow-builder stock pod after source cleanup.
- Leave compatibility routes and legacy registry in place unless a separate removal decision names all remaining consumers.

Verification commands to use before any cleanup patch:

- `pnpm --filter @pc/server exec tsx --test test/workflow-routes.test.ts test/workflow-compat-routes.test.ts test/workflow-builder-draft-store.test.ts test/workflow-import.test.ts test/project-runtime-move-v2.test.ts test/dag-run-service.test.ts test/dag-executor.test.ts test/orchestrator-review-step.test.ts`
- `pnpm --filter @pc/workflows test`
- `pnpm --filter @pc/db exec tsx --test test/workflows-repo.test.ts test/workflow-runs-v2.test.ts test/work-item-workflow-root.test.ts`
- `pnpm --filter @pc/mcp exec tsx --test test/workflows-tools.test.ts`
- `pnpm --filter @pc/server typecheck`
- `pnpm --filter @pc/web typecheck`
- `git diff --check`

## Completion Criteria

Kickoff status:

- This pod audit file exists and maps ownership, workflows, dependencies, drift, tests, and cleanup candidates.
- Runtime behavior has not been changed.
- No app, dev server, dogfood app, Vite server, channel server, or restart endpoint has been touched.

Commands run so far:

- `git status --short --branch`
- `Get-Content docs/pods/index.md`
- `rg --files` and `rg -n` for workflow, builder, visualizer, review, route, service, MCP, DB, domain, package, web, and test surfaces.
- `Get-Content` for workflow routes, compatibility routes, import, runtime, DAG runner/executor, workflow package helpers, domain contracts, repos, MCP tools, web clients/hooks/components/layout, and focused tests.
- `pnpm --filter @pc/server exec tsx --test test/workflow-routes.test.ts test/workflow-compat-routes.test.ts test/workflow-builder-draft-store.test.ts test/workflow-import.test.ts test/project-runtime-move-v2.test.ts test/dag-run-service.test.ts test/dag-executor.test.ts test/orchestrator-review-step.test.ts`
- `pnpm --filter @pc/workflows test`
- `pnpm --filter @pc/db exec tsx --test test/workflows-repo.test.ts test/workflow-runs-v2.test.ts test/work-item-workflow-root.test.ts`
- `pnpm --filter @pc/mcp exec tsx --test test/workflows-tools.test.ts`
- `pnpm --filter @pc/server exec tsx --test test/workflow-routes.test.ts`
- `pnpm --filter @pc/server typecheck`
- `pnpm --filter @pc/web typecheck`
- `git diff --check`

Verification results:

- Focused server workflow audit tests: 73 passed, 0 failed.
- Workflow package tests: 88 passed, 0 failed.
- DB workflow repo/run/root tests: 23 passed, 0 failed.
- MCP workflow tool tests: 4 passed, 0 failed.
- Focused workflow route cleanup tests: 22 passed, 0 failed.
- Server typecheck: passed.
- Web typecheck: passed.
- Diff whitespace check: passed.

Manual workflow checks run:

- None. Browser smoke has not been attempted for this pod.

Open risks:

- Workflows UI behavior remains source-audited only.
- Builder modal, graph authoring, and run overlays remain unverified in a browser.
- Human-review workflow nodes may pause runs without a usable human approval surface.
