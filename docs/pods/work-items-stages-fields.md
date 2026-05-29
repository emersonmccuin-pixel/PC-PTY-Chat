# Work Items Stages Fields Pod Audit

Status: complete.

Owner: Codex.

Worktree: `E:\Claude Code Projects\Personal\PC-PTY-Chat-phase5`.

Branch: `codex/phase-5-hardening`.

## Ownership

Server route modules:

- `apps/server/src/features/work-items/routes.ts`: HTTP routes for work-item list/create/update/move/get/archive/restore, agent contract create, approve/reject, attachments, stage replacement, and field schemas.

Server services:

- `apps/server/src/services/work-item.ts`: project-scoped work-item facade, field validation, stage assertion, optimistic concurrency, list pagination, callsign/ULID resolution, archive/restore, and broadcasts.
- `apps/server/src/services/field-schema.ts`: project-scoped field-schema list/replace facade and `field-schemas-changed` broadcast.
- `apps/server/src/services/attachment.ts`: project-scoped attachment facade and `attachment-changed` broadcast.
- `apps/server/src/services/agent-work-item.ts`: agent contract work-item creation, expected output defaults, acceptance criteria derivation, verification tier validation, and ephemeral/worktree fields.
- `apps/server/src/services/agent-verification-review.ts`: approve/reject flows for agent work items awaiting verification.
- `apps/server/src/services/ephemeral-work-item-sweep.ts`: boot-time auto-archive of old completed ephemeral agent contracts.
- `apps/server/src/services/stage-flags-backfill.ts`: one-time project stage flag backfill.
- `apps/server/src/services/create-work-item-step.ts`, `update-work-item-step.ts`, `attach-to-work-item-step.ts`: workflow step wrappers around the work-item and attachment services.

DB/domain modules:

- `packages/db/src/repos/work-items.ts`: work-item row CRUD, callsign assignment, stage moves, field merge, status updates, archive/restore, children, verification writes, assigned agent run id, workflow run outcome, stage reassignment, and sweep candidates.
- `packages/db/src/repos/field-schemas.ts`: field schema list/replace.
- `packages/db/src/repos/attachments.ts`: attachment create/list/get/delete.
- `packages/domain/src/work-item.ts`: work-item status/type/history contract.
- `packages/domain/src/work-item-contract.ts`: agent contract expected output, acceptance criteria, and verification contracts.
- `packages/domain/src/field-schema.ts`: field schema contract and pure validator.
- `packages/domain/src/attachment.ts`: attachment contract.

MCP modules:

- `packages/mcp/src/tools/work-items.ts`: `pc_*` work-item, approval, bug-log, list, move, update, get, and attachment tool metadata/handlers.
- `packages/mcp/src/tools/project-config.ts`: stage and field-schema MCP tools.

Web modules:

- `apps/web/src/features/work-items/client.ts`: HTTP client for initiatives, work items, stages, field schemas, attachments, archive/restore, and moves.
- `apps/web/src/features/work-items/types.ts`: browser-side work-item, field-schema, attachment, initiative, and error contracts.
- `apps/web/src/store/work-items-view.ts`: Work Items sub-tab, filters, sort, and agent-contract visibility state.
- `apps/web/src/store/chat-work-item-modal.ts`: chat-origin work-item modal state.
- `apps/web/src/store/attachment-lightbox.ts`: attachment lightbox state.
- `apps/web/src/components/WorkItemsPage.tsx`: Dashboard/Kanban/Table routing and InitiativeInspector overlay ownership.
- `apps/web/src/components/KanbanBoard.tsx`: Kanban list, filters, drag/drop move, create modal, detail modal, hidden agent contracts, and cancelled-stage visibility.
- `apps/web/src/components/work-items/WorkItemsTable.tsx`: table sub-tab, filters/sort, row open behavior, and parent title column.
- `apps/web/src/components/work-items/WorkItemsToolbar.tsx`: shared search/filter/sort/agent-contract toolbar.
- `apps/web/src/components/work-items/WorkItemDetailModal.tsx`: modal editor, version conflict handling, field schemas, children, attachments, and activity tabs.
- `apps/web/src/components/work-items/CreateWorkItemModal.tsx`: create flow and typed field validation surfacing.
- `apps/web/src/components/work-items/TypedFieldEditor.tsx`: typed field input rendering.
- `apps/web/src/components/work-items/InitiativeInspector.tsx`: inspector overlay for work-item-centered initiative style workflow.
- `apps/web/src/components/project-settings/StagesEditor.tsx`: stage replacement UI.
- `apps/web/src/components/project-settings/FieldSchemasEditor.tsx`: field-schema replacement UI.
- `apps/web/src/features/chat/approvals.tsx`: approval card rendering adjacent to agent work-item verification.

Public entry points:

- HTTP: `GET /api/projects/:projectId/work-items`.
- HTTP: `POST /api/projects/:projectId/work-items/create`.
- HTTP: `POST /api/projects/:projectId/work-items/create-agent-contract`.
- HTTP: `POST /api/projects/:projectId/work-items/update`.
- HTTP: `POST /api/projects/:projectId/work-items/move`.
- HTTP: `GET /api/projects/:projectId/work-items/:wiId`.
- HTTP: `PATCH /api/projects/:projectId/work-items/:wiId`.
- HTTP: `POST /api/projects/:projectId/work-items/:wiId/move`.
- HTTP: `DELETE /api/projects/:projectId/work-items/:wiId`.
- HTTP: `POST /api/projects/:projectId/work-items/:wiId/restore`.
- HTTP: `POST /api/projects/:projectId/work-items/:wiId/approve`.
- HTTP: `POST /api/projects/:projectId/work-items/:wiId/reject`.
- HTTP: `GET /api/projects/:projectId/work-items/:wiId/attachments`.
- HTTP: `GET /api/projects/:projectId/work-items/:wiId/attachments/:aId`.
- HTTP: `GET /api/projects/:projectId/attachments/:aId`.
- HTTP: `POST /api/projects/:projectId/work-items/:wiId/attachments`.
- HTTP: `DELETE /api/projects/:projectId/work-items/:wiId/attachments/:aId`.
- HTTP: `PATCH /api/projects/:projectId/stages`.
- HTTP: `GET /api/projects/:projectId/field-schemas`.
- HTTP: `PUT /api/projects/:projectId/field-schemas`.
- WebSocket outbound: `work-items-changed`, `stages-changed`, `field-schemas-changed`, `attachment-changed`.
- MCP: `pc_create_work_item`, `pc_create_agent_work_item`, `pc_approve_work_item`, `pc_reject_work_item`, `pc_log_bug`, `pc_move_work_item`, `pc_update_work_item`, `pc_get_work_item`, `pc_list_work_items`, `pc_attach_to_work_item`, stage and field-schema config tools.

Persisted data:

- SQLite tables: `work_items`, `attachments`, `field_schemas`, and project-owned `stages` JSON.
- Work-item rows contain hierarchy, callsigns, stage/status, typed fields, history, agent contract fields, workflow-root flags, assigned run ids, and soft-delete state.

## User Workflows

Kanban and table:

1. Work Items page opens the selected sub-tab.
2. Kanban/Table fetch live work items through `GET /work-items`.
3. Toolbar filters and agent-contract visibility apply client-side.
4. `work-items-changed` broadcasts trigger refetch.
5. Kanban drag/drop uses versioned move or patch routes; conflicts refetch.

Create/edit:

1. Create modal posts to `/work-items/create` with title, stage, optional body/type/parent/fields.
2. WorkItemService validates stage and typed fields before DB insert.
3. Detail modal patches with optimistic version and handles conflict or field-validation errors.
4. Archive and restore use soft-delete semantics.

Stages:

1. Project settings edits project stage JSON through `PATCH /stages`.
2. Route validates ids/names and one-each `is_done`, `is_cancelled`, `is_new`.
3. Removing a stage with live items returns `STAGE_HAS_ITEMS` unless forced with a retained fallback stage.
4. Forced removal reassigns live items to the fallback stage, updates project stages, refreshes project cache, and broadcasts `stages-changed`.

Field schemas:

1. Project settings replaces the per-project field-schema list.
2. Detail and create modals fetch the current schema list.
3. Create validates required/default/coerced fields in create mode.
4. Patch validates merged field state in patch mode.
5. Unknown fields are preserved and displayed as orphan fields.

Attachments:

1. Detail modal lists attachments for a work item.
2. Agents/workflows/MCP attach text content through the same project-scoped attachment service.
3. Attachment reads and deletes assert the attachment's work item belongs to the active project.
4. Attachment mutations broadcast `attachment-changed`.

Agent contracts and approvals:

1. MCP `pc_create_agent_work_item` posts an agent contract with task, pod, expected output, verification tier, optional parent/worktree, and ephemeral flag.
2. Agent contract rows are `isAgentTask` and hidden from work-item views unless the toolbar toggle is on.
3. Agent completion can park rows in `awaiting-verification`.
4. Approve flips verification to passed/complete; reject requires dispatcher session id and wakes the assigned agent run with feedback.

## Dependency Map

Imports into the pod:

- Server index registers work-item routes and injects project runtime, broadcast, channel server, and refresh hooks.
- Workflow runtime calls work-item service moves, creates, updates, and attachments.
- Agent run/verification services read and mutate agent contract fields.
- MCP work-item tools call work-item routes through ToolContext helpers.
- Web Kanban/Table/Inspector/Detail surfaces consume work-item feature client contracts.

Imports out of the pod:

- Workflows depend on stage transitions, workflow-root rows, child rows, and attachments.
- Agent runs depend on work-item contracts for assignments, verification, and continuation feedback.
- Project settings owns the UI shell for stage and field schema editing but routes live here.
- Chat approvals render verification review cards and reply through work-item approval routes.

Cross-pod calls that should stay explicit:

- Workflows own on-enter trigger execution; WorkItemService owns validated data mutation.
- Agent runs own dispatch lifecycle; work items own assignment/verification contract rows.
- Files/project context owns project files; attachments here are inline DB content only.
- Project lifecycle owns project rows; work-items routes only update `stages` through injected project refresh.

Duplicate adapters or protocol translations:

- Work-item domain and web feature types are separate and currently drift on status coverage and some agent contract fields.
- Status labels, dots, glyphs, and group ordering are duplicated in Kanban/Table/Toolbar/InitiativeInspector.
- Work-item route handlers repeat project resolution and error mapping.
- MCP work-item handlers repeat HTTP error handling and work-item id/callsign resolution patterns.

## Dead Code And Drift

- Web `workItemsApi` exposes initiative routes (`/api/initiatives/*`, `/api/projects/:projectId/initiatives`) but this repo currently has no server/db/domain initiative implementation.
- Web `WorkItemStatus` omits server/domain statuses `awaiting-verification` and `cancelled`, even though agent verification and cancelled stages can produce those values.
- Work-item web type omits several server fields used by adjacent pods (`isWorkflowRoot`, `ephemeral`, verification fields, assigned run id, worktree path).
- DashboardPlaceholder still waits on initiative server endpoints; it should remain a placeholder until that server surface exists.
- No safe deletes were proven during this initial pass.

## Tests And Gaps

Existing focused tests:

- `apps/server/test/work-item-routes.test.ts`: CRUD route envelopes, filtered list, version requirements, callsign get, archive/restore, stage replacement, attachment routes, and field schema routes.
- `apps/server/test/work-item-pagination.test.ts`: cursor pagination stability under position/createdAt/id ordering.
- `apps/server/test/work-item-ref-resolver.test.ts`: ULID/callsign resolution and project-scope guards.
- `apps/server/test/agent-work-item.test.ts`: agent contract creation, expected output defaults/overrides, acceptance criteria validation, verification tier, ephemeral/worktree/parent, and malformed input rejection.
- `apps/server/test/ephemeral-work-item-sweep.test.ts`: boot-time ephemeral completed row archival and retention.
- `apps/server/test/stage-flags-backfill.test.ts`: stage flag backfill and idempotence.
- `apps/server/test/agent-verification-review.test.ts`: approve/reject adjacent verification review behavior.
- `apps/server/test/agent-verification.test.ts`: automatic verification predicates adjacent to agent contract completion.

Missing tests or trace evidence:

- No focused web test pins status labeling for every server/domain work-item status.
- No browser smoke verifies Kanban drag/drop, table filters, detail patch conflict, stage editor, field schema editor, attachments, or approval flows.
- No test asserts initiative client routes are intentionally absent/present.

## Cleanup Plan

Do not change workflow-trigger, agent-verification, stage delete/reassign, or archive semantics without a failing trace.

Small cleanup candidates:

- Done: aligned web work-item status contracts with the server/domain status set and extracted shared status presentation helpers.
- Done: added focused web/helper tests for all status labels/options/glyph coverage.
- Keep initiative API cleanup as documentation-only unless the product decision is to remove or implement that surface.
- Defer route/project-resolution helper extraction until after status contract drift is fixed.

Verification commands to use before any cleanup patch:

- `pnpm --filter @pc/server exec tsx --test test/work-item-routes.test.ts test/work-item-pagination.test.ts test/work-item-ref-resolver.test.ts test/agent-work-item.test.ts test/ephemeral-work-item-sweep.test.ts test/stage-flags-backfill.test.ts test/agent-verification-review.test.ts test/agent-verification.test.ts`
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
- `rg --files` and `rg -n` for work item, stage, field schema, attachment, initiative, approval, Kanban, and agent contract surfaces.
- `Get-Content` for work-item routes, services, repos, domain contracts, MCP tools, web client/types, Kanban/Table/Detail/Toolbar surfaces, and focused tests.
- `pnpm --filter @pc/server exec tsx --test test/work-item-routes.test.ts test/work-item-pagination.test.ts test/work-item-ref-resolver.test.ts test/agent-work-item.test.ts test/ephemeral-work-item-sweep.test.ts test/stage-flags-backfill.test.ts test/agent-verification-review.test.ts test/agent-verification.test.ts`
- `pnpm --filter @pc/server exec tsx --test test/web-work-item-status.test.ts test/work-item-routes.test.ts test/work-item-pagination.test.ts test/work-item-ref-resolver.test.ts test/agent-work-item.test.ts test/ephemeral-work-item-sweep.test.ts test/stage-flags-backfill.test.ts test/agent-verification-review.test.ts test/agent-verification.test.ts`
- `pnpm --filter @pc/server typecheck`
- `pnpm --filter @pc/web typecheck`
- `git diff --check`

Verification results:

- Focused work-items/stages/fields audit tests: 78 passed, 0 failed.
- Focused work-items/stages/fields cleanup tests: 79 passed, 0 failed.
- Server typecheck: passed.
- Web typecheck: passed.
- Diff whitespace check: passed.

Manual workflow checks run:

- None. In-app Browser backend was unavailable earlier in this Phase 5 session: `iab`.

Open risks:

- Work Items UI behavior remains source-audited only.
- Browser-level status rendering remains unverified in this session.
- Initiative APIs are client-only in this repo until a server/domain implementation lands or the client surface is removed.
