# Work Items, Stages, Fields, and Attachments Architecture Handoff

## Handoff Metadata

| Field | Value |
| --- | --- |
| Artifact | `refactor plan/refactor plan docs/work-items-stages-fields-attachments.md` |
| Baseline branch | `dev` |
| Baseline commit | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` |
| Scope | Work items, project stages, field schemas, attachments, and dependency contracts used by agents, workflows, MCP, live events, and attachment consumers. |
| Non-goals | No implementation changes. No redesign of workflow runtime internals, agent runtime internals, or the future mailbox beyond their direct work-item dependencies. |
| Evidence rule | Current-state facts below are based on code inspection only. Prior architecture docs are treated as planning context, not implemented truth. |

## Current System Trace

### Verified Facts

| Area | Current trace |
| --- | --- |
| Domain model | `packages/domain/src/work-item.ts` defines `WorkItem`, `WorkItemStatus`, history kinds, agent-task flags, workflow-root flags, verification fields, `fields`, `version`, and `callsign`. |
| Agent contract fields | `packages/domain/src/work-item-contract.ts` defines `ExpectedOutput`, `AcceptancePredicate`, `VerificationTier`, and `VerificationStatus`. Predicates include `attachments_present`, `files_exist`, `bash_exit_zero`, `body_contains`, `fields_populated`, `field_matches`, and `child_work_items_done`. |
| Field validation | `packages/domain/src/field-schema.ts` supports `text`, `number`, `boolean`, `enum`, and `date`, coercing known fields and preserving unknown orphan fields. |
| Attachment model | `packages/domain/src/attachment.ts` stores inline attachment content with provenance fields `runId`, `createdBySessionId`, `source`, `agentName`, and `nodeId`. |
| Database schema | `packages/db/src/schema.ts` keeps project stages as JSON on `projects.stages`, stage revision as `projects.stagesRev`, work-item stage references as `work_items.stage_id` without a database FK, field schemas in `field_schemas`, and attachment content inline in `attachments.content`. |
| Work-item repository | `packages/db/src/repos/work-items.ts` provides create/list/get/callsign lookup, optimistic `patchWorkItem`, direct `moveWorkItemStage`, field update, soft delete/restore, child listing, and agent verification mutation helpers. |
| Server work-item service | `apps/server/src/services/work-item.ts` validates stages and fields on create/patch/move/delete/restore, computes post-move status from stage flags, and announces changed work items through `WorkItemWriter`. |
| Live work-item write door | `apps/server/src/services/work-item-writer.ts` emits legacy `work-item-changed` envelopes with full work-item snapshots and versions. |
| Project runtime composition | `apps/server/src/services/project-runtime.ts` wires work-item, attachment, and field-schema services into workflow execution. `moveAndFireV2` moves a work item and then fires stage-entry workflows. |
| Agent work-item creation | `apps/server/src/services/agent-work-item.ts` creates agent-task work items through `WorkItemService.create`, deriving expected output, acceptance criteria, verification tier, and default stage. |
| Agent verification | `apps/server/src/services/agent-verification.ts`, `agent-verification-review.ts`, and `auto-advance-done.ts` update verification status, final status, and sometimes stage. Several of these paths mutate rows without the shared work-item announcement path. |
| Workflow usage | `apps/server/src/services/dag-run-service.ts` creates workflow root work items, creates child agent-task work items, and uses `moveWorkItemStage` for `move-work-item` nodes. |
| Workflow stage references | `packages/workflows/src/dag/validate.ts` validates syntactic node rules and some stage-entry collision data, but active validation does not consistently prove every `stage-on-entry.stage` or `move-work-item.to_stage` exists in the current project. |
| HTTP routes | `apps/server/src/features/work-items/routes.ts` exposes list/create/update/move/patch/delete/restore, approve/reject, attachment CRUD, stage replacement, and field-schema replacement. Some legacy routes bypass the newer service contract. |
| MCP tools | `packages/mcp/src/tools/work-items.ts` and `packages/mcp/src/tools/project-config.ts` expose work-item, attachment, stage, and field-schema tools with hand-written schemas and raw HTTP calls. |
| Web client | `apps/web/src/features/work-items/client.ts`, `types.ts`, `use-project-work-items.ts`, `use-project-stages.ts`, and `use-rich-link-invalidator.ts` use hand-maintained DTOs and legacy websocket event names. |
| Tests | No non-archive `*.test.*` or `*.spec.*` files were found. |
| Target packages | No current `packages/contracts`, `packages/app-services`, `packages/live`, or `packages/mailbox` implementation was found. |

### Current Request Flows

| Flow | Current behavior |
| --- | --- |
| Web work-item create/patch/move | Web calls `apps/web/src/features/work-items/client.ts`, server route delegates to `WorkItemService`, service validates stage/fields, repository mutates SQLite, writer broadcasts `work-item-changed`. |
| MCP work-item move | `pc_move_work_item` resolves callsign/ULID and posts to legacy `/work-items/move`. `ProjectRuntime.moveAndFireV2` may call `moveWorkItemStage` without expected-version protection and then emits a legacy websocket event manually. |
| MCP fields-only update | `pc_update_work_item` posts to legacy `/work-items/update`. If only `fields` is supplied, the route calls `dbUpdateWorkItemFields` directly and manually broadcasts, bypassing `WorkItemService.patch` field-schema validation. |
| Agent task creation | Agent tooling or workflow runtime calls `createAgentWorkItem`, which delegates to `WorkItemService.create` and therefore uses stage/field validation plus work-item broadcast on create. |
| Agent terminal verification | Terminal agent-run effects call verification logic. Verification can update work item status, verification fields, and done-stage movement, but the terminal-effects path broadcasts `agent-run-changed`, not guaranteed `work-item-changed`. |
| Workflow root and child items | Manual workflow runs create a root work item through `WorkItemService.create`; agent nodes create child agent-task work items. Workflow node outputs live partly in child items and attachments. |
| Workflow move-work-item node | DAG runtime calls `moveWorkItemStage` directly and manually broadcasts `work-item-changed`; stage-entry workflows are intentionally skipped from this node path. |
| Stage replacement | `PATCH /api/projects/:projectId/stages` validates duplicate ids, single `isNew`/`isDone`/`isCancelled`, and blocks removing stages containing work items unless forced/fallback is supplied. It does not fully guard workflow references. |
| Field-schema replacement | `PUT /api/projects/:projectId/field-schemas` delegates to `FieldSchemaService.replace`, which calls `replaceFieldSchemas`; repository deletes existing rows then inserts replacements. |
| Attachment create/delete | `AttachmentService` checks project ownership and broadcasts `attachment-changed` on create/delete. Work-item version is not bumped for attachment changes. |

## Integration Map

| Consumer | Depends on | Current dependency shape | Build dependency needed |
| --- | --- | --- | --- |
| Agents | Agent-task work items, expected output, acceptance criteria, verification tier/status, attachments, child work items, callsigns | Domain structs plus service/repo helpers and MCP tools | Stable work-item contract plus verification mutation service that emits canonical work-item and attachment facts. |
| Workflows | Root work items, child agent tasks, stage-entry triggers, `move-work-item.to_stage`, review nodes, attachments | `ProjectRuntime`, DAG runtime, direct repo calls in places | Stage-reference contract, workflow-safe move service, workflow root/child relationship contract, and live facts for each state mutation. |
| MCP | Work-item CRUD, move/update, agent task creation, approval/rejection, attachments, stages, field schemas | Hand-written schemas and raw HTTP routes | Typed shared contracts and a compatibility client over app services or stable HTTP adapters. |
| Live events | Work-item, stage, field-schema, and attachment changes | Legacy websocket events: `work-item-changed`, `stages-changed`, `field-schemas-changed`, `attachment-changed` | Canonical durable event families: `work-item.changed`, `stage.list.changed`, `field-schema.list.changed`, and `attachment.changed`, backed by an outbox. |
| Web UI | Kanban lists, stage tabs, archived list, rich-link invalidation, attachment panels | Hand-maintained TypeScript types and bespoke websocket handlers | Shared DTOs, version/cursor semantics, reconnect-safe projections, and explicit attachment invalidation contract. |
| Attachments | Verification predicates, workflow/agent outputs, rich links, transcript/context references | Inline DB content plus route-level CRUD and separate attachment events | Attachment DTO/provenance contract, size/content policy, retention/deletion semantics, and relation to work-item versioning. |
| Mailbox/pending interactions | Future human/orchestrator review prompts and agent asks linked to work items | Not implemented as target mailbox yet | Work-item references, review status facts, and attachment/context links must be usable by mailbox services without coupling to UI routes. |

## State Ownership

### Verified Facts

| State | Current owner | Notes |
| --- | --- | --- |
| Project stages | `projects.stages` JSON via `packages/db/src/repos/projects.ts` and stage route/service code | Stage ids are logical references. Work-item rows reference them without FK protection. |
| Stage revision | `projects.stagesRev` plus per-stage `rev` stamping in `updateProjectStages` | Web stage hook treats stage `rev` as websocket freshness data. |
| Work-item durable state | `work_items` table and `packages/db/src/repos/work-items.ts` | Service-level validation is uneven because legacy routes and runtime helpers can bypass `WorkItemService`. |
| Work-item version | `work_items.version` | `patchWorkItem` is optimistic; `moveWorkItemStage` increments version but does not require an expected version. `setAssignedAgentRunId` does not bump version. |
| Field schemas | `field_schemas` table | Replacement is all-at-once from the API perspective, but repository implementation deletes then inserts. |
| Dynamic fields | `work_items.fields` JSON | Known schema keys are validated in service paths; legacy fields-only update can bypass validation. Unknown orphan keys are intentionally preserved by domain validation. |
| Attachments | `attachments` table | Content is inline. Attachment create/delete has its own websocket event and does not mutate work-item version. |
| Agent verification state | `work_items.verification_status`, `verification_notes`, `status`, `stage_id`, history | Some verification paths use direct repo helpers and do not announce work-item changes. |
| Workflow run relation | `workflow_runs_v2.workItemId` and child work-item parent links | Schema comments state v2 run is represented by a root work item; child outputs live on child work items. |

### Recommendation

Treat the server-owned app service as the only writer for work-item, stage, field-schema, and attachment state that matters to other subsystems. Repositories should stay durable-storage primitives; app services should own validation, optimistic concurrency, side-effect policy, and canonical event emission.

## Invariants And Compatibility Requirements

### Must Preserve

| Invariant | Reason |
| --- | --- |
| Existing SQLite rows remain readable. | Target architecture says this repo is the implementation target, not a blank rewrite. |
| Existing `work_items.id` and `work_items.callsign` references remain valid. | MCP tools, UI links, workflow history, and agent logs rely on stable references. |
| Existing stage ids remain logical, project-scoped strings. | Work items and workflows currently store stage ids directly. |
| Work-item `version` remains monotonic for changes that affect rendered work-item state. | Web resource-list handling uses version-aware updates. MCP and future contracts need conflict detection. |
| Unknown field keys are not destroyed during schema migration. | Domain validation intentionally preserves orphan fields for compatibility. |
| Attachment provenance survives migration. | Agent/workflow attribution depends on `runId`, `source`, `agentName`, and `nodeId`. |
| Legacy websocket event names keep working during migration. | Current web hooks depend on `work-item-changed`, `stages-changed`, `field-schemas-changed`, and `attachment-changed`. |
| Legacy MCP tools remain available until typed clients replace their internals. | Agent and external tool flows use current MCP tool names. |
| Workflow `move-work-item` nodes continue to skip stage-entry workflow firing unless a migration explicitly changes semantics. | Current runtime behavior intentionally avoids recursive stage-entry workflow triggers from this node path. |

### Compatibility Conflicts To Record

| Conflict | Evidence | Planning impact |
| --- | --- | --- |
| Work-item mutations do not all pass through one event-emitting service. | `agent-verification.ts`, `agent-verification-review.ts`, `auto-advance-done.ts`, and DAG move node paths use repo helpers directly. | The live-events slice needs an explicit mutation gateway before durable outbox migration is complete. |
| MCP contract descriptions and server behavior differ. | `pc_create_work_item` says `targetProjectId` can omit `stageId`, but server create route rejects missing `stageId`. | MCP compatibility tests must lock actual behavior before changing it. |
| Web/domain DTOs have drifted. | Web `WorkItem` omits agent verification/output fields and includes `initiativeId`; web `Attachment` omits provenance fields. | Shared contracts must be introduced with adapters, not by blindly replacing web types. |
| Attachment changes are separate from work-item versions. | `AttachmentService` emits `attachment-changed`; work-item version is not bumped. | Target event contract must decide whether attachments are separate entity facts, work-item aggregate changes, or both. |

## Current Issues

| Severity | Issue | Evidence | Impact |
| --- | --- | --- | --- |
| High | Agent verification can mutate work-item status/stage without a work-item live event. | `apps/server/src/services/agent-verification.ts`, `agent-verification-review.ts`, `auto-advance-done.ts`, and `agent-run-terminal-effects.ts` broadcast `agent-run-changed` but not guaranteed `work-item-changed`. | Agent-task cards, review queues, MCP pollers, and workflow projections can miss completion/rejection/auto-advance until a refetch. |
| High | Work-item contracts are duplicated and drifting across domain, server, web, and MCP. | Domain files in `packages/domain/src`; web manual types in `apps/web/src/features/work-items/types.ts`; MCP manual schemas in `packages/mcp/src/tools/work-items.ts`. | Agents, workflows, MCP tools, and UI can disagree on valid fields, verification state, and attachment shape. |
| High | Legacy MCP move/update routes bypass newer safety rules. | `pc_move_work_item` posts to legacy `/work-items/move`; `ProjectRuntime.moveAndFireV2` supports a no-version path. Fields-only `/work-items/update` calls `dbUpdateWorkItemFields` directly. | Lost-update risk, inconsistent field validation, and inconsistent event semantics for tool-driven changes. |
| Medium | Stage replacement does not fully protect workflow stage references. | Stage route guards work items in removed stages, but workflow definitions can reference `stage-on-entry.stage` and `move-work-item.to_stage`. | Removing or renaming stage ids can silently break workflow triggers or move nodes. |
| Medium | Field-schema replacement is not a durable transaction boundary and does not revalidate consumers. | `replaceFieldSchemas` deletes all rows then inserts replacements; route passes body items through with minimal parsing. | Partial failures can lose schemas; changed schema options can make existing work-item fields invalid without a migration record. |
| Medium | Attachment contract lacks explicit storage and lifecycle policy. | Attachments store inline content in SQLite and support hard delete. No inspected contract defines size, content type, retention, or whether attachment mutation should bump work-item versions. | Agent outputs and verification evidence can become too large, ambiguous, or unexpectedly deleted. |
| Medium | Work-item list endpoint has incompatible response shapes. | No-filter `GET /work-items` returns `{ workItems }`; filtered list returns `{ items, nextCursor }`. | Shared client contracts and pagination cannot be made uniform without a compatibility adapter. |
| Medium | Workflow v2 active node set and older work-item step files diverge. | `packages/workflows/src/dag/validate.ts` active kinds exclude older `create-work-item`, `update-work-item`, and `attach-to-work-item` services under `apps/server/src/services`. | Planning must classify old files as legacy before depending on them for new build slices. |
| High | No characterization tests currently protect the behavior above. | Non-archive test/spec search returned no files. | Build slices need tests before replacing shared contracts or route behavior. |

## First-Principles Design

### Synthesis

The work-item system is the durable coordination surface for agents and workflows. It is not only a kanban entity. A work item can be a human task, an agent contract, a workflow root, a child workflow output, a review target, a rich-link target, or a tool-addressable object. Stages, field schemas, and attachments are therefore not auxiliary UI settings; they are part of the app-owned contract that lets runtimes communicate through durable facts.

### Principles

| Principle | Consequence |
| --- | --- |
| Durable state belongs to app services over SQLite. | Runtime code, MCP tools, and web routes should call app services, not mutate work-item tables directly. |
| Runtime processes emit facts, not UI commands. | Agent verification, workflow moves, attachment writes, and stage changes must publish canonical live/outbox facts after durable mutation. |
| Contracts are shared, adapters are replaceable. | Define DTOs once, then adapt HTTP, MCP, and web clients around them. |
| Stage and field definitions are project-scoped contracts. | Replacing them needs reference checks, migration semantics, and compatibility responses. |
| Attachments are first-class evidence. | Verification and workflow output logic should treat attachments as durable, provenance-bearing records with explicit lifecycle policy. |
| Compatibility is explicit. | Legacy route shapes and websocket names stay as adapters until callers are migrated. |

## Target Architecture Alignment

| Target thesis | Alignment for this subsystem |
| --- | --- |
| Durable state lives in SQLite/server-owned services. | Keep `work_items`, `projects.stages`, `field_schemas`, and `attachments`, but route all durable mutations through app services. |
| Runtime processes emit facts. | Agent terminal verification, workflow nodes, MCP writes, stage changes, and attachment CRUD should emit canonical facts after commits. |
| Websocket/live events project facts to UI. | Legacy websocket events become compatibility projections from canonical `work-item.changed`, `stage.list.changed`, `field-schema.list.changed`, and `attachment.changed`. |
| Agents and workflows communicate through explicit app-owned contracts. | Work-item contract package should own agent-task, workflow-root, review, field, and attachment DTOs. |
| MCP is an adapter over shared contracts and services. | Existing MCP tool names can remain, but request/response parsing should come from shared contracts and typed localhost clients. |
| Channel is replaced by mailbox/inbox. | Work-item review and pending-interaction flows need stable work-item and attachment references so mailbox can link durable review prompts to app state. |

## Recommended Practical Architecture

### 1. Shared Contracts

Create a work-item contract family in the future contracts package:

| Contract | Initial contents |
| --- | --- |
| `WorkItemDto` | id, projectId, callsign, parentId, title, body, status, stageId, type, fields, version, deletedAt, position, agent/workflow flags, expected output, acceptance criteria, verification fields, assigned run/worktree fields. |
| `StageDto` | id, name, position, color, `isNew`, `isDone`, `isCancelled`, `rev`. |
| `FieldSchemaDto` | id, projectId, key, label, type, required, options, order, updatedAt. |
| `AttachmentDto` | id, workItemId, name, content, createdAt, runId, createdBySessionId, source, agentName, nodeId. |
| `WorkItemMutationResult` | changed work item, optional changed attachments, version, and canonical event ids when outbox exists. |
| Request schemas | create, patch, move, soft-delete, restore, create-agent-contract, approve/reject, stage replace, field-schema replace, attachment create/delete. |

Recommendation: use adapters from existing domain/database rows to DTOs first. Do not move database schema in the same slice as contract extraction.

### 2. App Service Write Door

Introduce or consolidate an app-service boundary that owns:

| Operation family | Required behavior |
| --- | --- |
| Work-item create/patch/move/delete/restore | Stage validation, field-schema validation, optimistic version policy, row mutation, canonical event emission, legacy event projection. |
| Agent verification and review | Apply verification state, append history, optionally auto-advance stage, emit one coherent work-item changed fact for each changed row. |
| Workflow work-item operations | Create roots/children and move workflow work items through the same write door. Preserve skip-stage-entry semantics for `move-work-item` nodes. |
| Stage replacement | Validate stage ids, item references, workflow references, default/done/cancelled uniqueness, fallback migration, revision stamping, and canonical stage-list event emission. |
| Field-schema replacement | Parse contract input, transact replacement, optionally validate existing rows, preserve orphan fields, emit canonical field-schema event. |
| Attachments | Validate project/work-item ownership, content policy, provenance, create/delete semantics, canonical attachment event, and optional aggregate work-item invalidation. |

### 3. Live Event Families

Adopt the live-events foundation spec with these subsystem families:

| Event family | Payload guidance | Legacy projection |
| --- | --- | --- |
| `work-item.changed` | projectId, workItemId, callsign, version, changed snapshot or patch, reason, actor/runtime source, correlation id. | `work-item-changed` full snapshot. |
| `stage.list.changed` | projectId, stagesRev, stage list, reason, migration summary. | `stages-changed`. |
| `field-schema.list.changed` | projectId, schema revision or updatedAt token, field schema list. | `field-schemas-changed`. |
| `attachment.changed` | projectId, workItemId, attachmentId, action, provenance, optional name metadata. | `attachment-changed`. |

Recommendation: treat attachments as separate entity events and make web/rich-link consumers explicitly subscribe to them. If UX needs work-item cards to refresh attachment badges, publish a companion lightweight work-item invalidation fact or include attachment summary version in `WorkItemDto`.

### 4. MCP Compatibility Adapter

Keep existing MCP tool names initially, but move parsing and HTTP/client calls behind typed contracts:

| Tool family | Required migration behavior |
| --- | --- |
| `pc_create_work_item` | Make `targetProjectId` and optional `stageId` behavior match server contract, or change description after compatibility characterization. |
| `pc_move_work_item` | Use expected-version-capable move when possible; if preserving no-version move, label it as last-write-wins compatibility. |
| `pc_update_work_item` | Route fields-only updates through the same validation path as PATCH. |
| `pc_attach_to_work_item` | Preserve `workflowRunId` to `runId` compatibility while returning canonical `AttachmentDto`. |
| Stage/field tools | Return canonical DTOs and structured validation errors. |

### 5. Web Compatibility Adapter

Replace manual web-only DTOs gradually:

| Web area | Migration note |
| --- | --- |
| `apps/web/src/features/work-items/types.ts` | Add contract-derived shapes or adapters for missing agent/workflow/verification/attachment provenance fields. |
| `workItemsApi` | Normalize route response shapes behind one client interface before changing server routes. |
| Work-item hook | Keep version-aware upserts; later consume canonical live event envelope. |
| Stage hook | Move from bespoke `stages-changed` handling to canonical reconnect-safe projection once live-events foundation exists. |
| Rich-link invalidator | Continue listening to attachment events; later migrate to `attachment.changed`. |

## Migration Strategy

### Recommended Build Slices

| Slice | Scope | Exit criteria |
| --- | --- | --- |
| 0. Characterization | Add tests around legacy HTTP/MCP semantics, stage replacement rules, field validation, attachment events, and agent verification event gaps. | Current behavior is executable and failures are intentional when documenting known gaps. |
| 1. Contract DTO adapters | Add shared work-item/stage/field/attachment DTOs and row adapters without changing routes. | Server, web, and MCP can import or generate from one contract surface while legacy responses remain stable. |
| 2. Work-item mutation gateway | Route agent verification, approve/reject, auto-advance, workflow root/child creation, workflow moves, MCP move/update through one app-service write door. | Every durable work-item mutation has one place for validation, version policy, history, and event emission. |
| 3. Canonical event projection | Add canonical event emission and outbox-ready payloads while projecting legacy websocket names. | Work item, stage, field-schema, and attachment changes produce both canonical and compatibility events. |
| 4. Stage and field-schema guards | Add workflow reference checks, transactional schema replacement, structured errors, and migration/fallback semantics. | Removing/replacing stage ids cannot silently break active workflow definitions; schema replacement cannot partially delete all schemas. |
| 5. MCP typed client | Move MCP work-item/project-config tools onto shared schemas and typed local client. | Tool descriptions, schemas, server behavior, and returned DTOs agree. |
| 6. Web contract migration | Update web work-item, stage, field, attachment clients/hooks to contract DTOs and canonical live events. | UI can render agent/workflow/attachment provenance fields and survive reconnect through canonical projections. |

### Rollback And Compatibility

| Change | Rollback approach |
| --- | --- |
| Contract DTO adapters | Keep old response mappers and switch route/client exports back to legacy types. No data migration. |
| Mutation gateway | Keep repository functions unchanged; revert call-site routing to previous direct helper calls if needed. |
| Canonical events | Continue emitting legacy websocket events independently until canonical path is proven. |
| Stage/field guards | Feature-flag stricter validation or expose `force` paths with explicit migration summaries. |
| MCP typed client | Preserve existing tool names and old raw HTTP helper until parity tests pass. |
| Attachment policy | Enforce new size/type limits only on new writes; old attachments remain readable. |

## Acceptance Criteria

### Planning Acceptance

| Criteria | Status |
| --- | --- |
| Current work-item, stage, field-schema, and attachment state ownership is documented from code. | Planned in this artifact. |
| Dependencies for agents, workflows, MCP, live events, and attachments are mapped. | Planned in this artifact. |
| Current contract drift and live-event gaps are recorded with evidence. | Planned in this artifact. |
| Migration slices are small enough to feed the implementation roadmap and Phase 0 test plan. | Planned in this artifact. |

### Future Build Acceptance

| Build gate | Required proof |
| --- | --- |
| Shared contracts | Type-level or runtime-schema tests prove server/web/MCP use the same work-item, stage, field, and attachment shapes. |
| Mutation gateway | Tests prove create/patch/move/delete/restore, agent verification, workflow moves, approve/reject, and attachment writes emit expected facts. |
| Compatibility | Legacy routes and MCP tools either keep old behavior or have documented versioned changes with migration notes. |
| Stage safety | Tests prove stage removal/replacement cannot break work items or workflow stage references without explicit force/fallback. |
| Field safety | Tests prove field-schema replacement is transactional and existing unknown fields are preserved. |
| Attachment safety | Tests prove attachment provenance, content policy, deletion behavior, and live-event invalidation. |

## Test Plan

### Characterization Tests Needed First

| Area | Test cases |
| --- | --- |
| Work-item CRUD | Create, patch, move with expected version, move without expected version via legacy path, soft delete, restore, callsign lookup, filtered and unfiltered list response shapes. |
| Field validation | Service create/patch validates required/type/enum/date; unknown fields are preserved; legacy fields-only update current behavior is captured before changing it. |
| Stage replacement | Duplicate ids, multiple done/cancelled/new flags, removing occupied stages with and without fallback, preserving stage revs, and workflow-reference breakage as a known current gap. |
| Agent contracts | `createAgentWorkItem` default stage, expected output derivation, acceptance criteria derivation, ephemeral flag, verification tier/status. |
| Agent verification | Auto pass/fail, failed run, cancelled run no-op, human/orchestrator review pending state, approve/reject, auto-advance done stage, and whether each path emits work-item events. |
| Workflow dependencies | Manual root creation, child agent task creation, `move-work-item` stage change, skip stage-entry semantics, attachment output paths if active. |
| Attachments | Create/list/get/delete, project ownership guard, provenance fields, verification `attachments_present`, `body_contains` searching attachment contents, rich-link invalidation event. |
| MCP parity | Each `pc_*` work-item/project-config tool request/response compared against server route behavior, including `pc_create_work_item` optional `stageId` drift. |
| Live events | Legacy websocket event payload shape and version behavior for work items, stages, field schemas, and attachments; gaps documented as expected failures until fixed. |

### Suggested Test Levels

| Level | Use |
| --- | --- |
| Domain unit tests | Field validation, acceptance predicate evaluation with fake executors, DTO adapters. |
| Repository tests | Version conflicts, stage movement version bump, field-schema replacement transaction, attachment CRUD. |
| Service tests | Work-item service validation, mutation gateway, agent verification, stage replacement guards. |
| Route tests | Legacy response shapes, structured errors, compatibility behavior. |
| MCP integration tests | Tool schemas and raw/typed client parity against a test server. |
| Web hook tests | Version-aware projection, stage revision updates, attachment invalidation. |

## Implementation Notes For The Next Agent

1. Do not start by changing schema. Start with characterization tests and DTO adapters.
2. Treat `WorkItemService` and `WorkItemWriter` as the current closest write-door pattern, but do not assume every mutation uses it.
3. Audit and migrate these direct mutation paths first: `agent-verification.ts`, `agent-verification-review.ts`, `auto-advance-done.ts`, `dag-run-service.ts`, and the legacy route branches in `features/work-items/routes.ts`.
4. Preserve `move-work-item` skip-stage-entry behavior unless the workflow architecture is explicitly updated.
5. Decide attachment aggregate semantics before canonical events: either attachment changes are separate facts only, or work-item DTOs carry an attachment summary version.
6. Make stage-reference validation workflow-aware before allowing stage id replacement through MCP or web.
7. Normalize route response shapes behind adapters before changing public responses.
8. Keep MCP tool names stable; migrate internals to typed contracts.
9. Ignore `archive/` entirely when gathering future evidence.

## Open Questions

| Question | Why it matters |
| --- | --- |
| Should every attachment create/delete bump a work-item aggregate version, or should attachment consumers rely only on `attachment.changed`? | Determines web invalidation, MCP polling, and live-event payload shape. |
| Should field-schema replacement validate all existing work items, warn only, or require an explicit migration mode? | Determines how strict project schema evolution can be without breaking existing data. |
| Which workflow definitions are considered active for stage-reference guards: only v2 DAGs, legacy workflow rows, or both? | Determines what `PATCH /stages` and MCP stage replacement must validate. |
| Should legacy no-version MCP moves remain last-write-wins, or should tools learn expected versions? | Determines compatibility risk and conflict behavior for agents/tools. |
| What attachment size/content-type limits are acceptable for inline SQLite storage? | Determines whether attachment storage must move before heavy agent output use. |
| Should agent verification state changes be modeled as work-item facts only, or as both work-item facts and agent-run facts sharing a correlation id? | Determines live-events and transcript/mailbox correlation. |

