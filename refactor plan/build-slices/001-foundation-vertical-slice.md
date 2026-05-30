# 001 Foundation Vertical Slice

## 1. Baseline and Decision

| Field | Value |
|---|---|
| Date | 2026-05-30 |
| Branch | `dev` |
| Commit | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` |
| Artifact status | Planned build slice |
| Owning roadmap phases | Phase 0 test characterization, Phase 1 shared contracts, Phase 2 low-risk app-service seams, Phase 3 compatibility live events |
| Slice subject | Project list and project metadata contracts, route parity, web client typing, and a compatibility `project.changed` refetch event |
| Implementation target | This repo. Do not create a parallel app. |
| Scope rule | This is a build plan only. Do not implement until the user explicitly asks to build. |

Decision:

- **Recommendation:** Pick project list/project metadata as the smallest contract-first vertical slice.
- **Reason:** It already has a feature route, a web feature client, DB repo functions, and visible stale-list risk, while avoiding runtime, agents, workflows, Channel, mailbox, transcript storage, MCP tool behavior, and destructive DB migrations.
- **Compatibility stance:** Preserve current HTTP paths and response shapes. Add contracts and adapters around existing behavior first.

## 2. Problem Statement

Verified facts:

- The repo has no `packages/contracts` or `packages/app-services` implementation yet.
- Project server routes and web clients hand-roll overlapping DTOs and request/response shapes.
- Project create/update/delete/reorder currently update only the tab that initiated the action; other connected clients have no project-list live invalidation.
- No active non-archive test/spec files exist in this checkout, so implementation must restore a minimal test harness before behavior changes.

Synthesis:

- This slice should prove the cartridge pattern on the least risky feature family:

```text
contract
  -> app service / repo boundary
  -> route adapter
  -> live event compatibility fact
  -> web client/hook
  -> tests
```

## 3. Current-State Evidence

| Label | Finding | Evidence |
|---|---|---|
| Verified fact | `packages/contracts` and `packages/app-services` do not exist in current implementation code. | `rg --files --glob "!archive/**"` plus package layout inspection. |
| Verified fact | Workspace package globs already include `packages/*`, so adding packages fits current layout. | `pnpm-workspace.yaml`. |
| Verified fact | Project routes directly call DB repo functions and route dependencies. | `apps/server/src/features/projects/routes.ts:49`, `:54`, `:67`, `:100`, `:122`, `:181`. |
| Verified fact | Project create is a side-effectful flow that owns git/scaffold/runtime registry behavior. | `apps/server/src/services/project-create.ts:76`. |
| Verified fact | Project repo already exposes clean list/reorder/update/delete boundaries. | `packages/db/src/repos/projects.ts:55`, `:130`, `:176`, `:203`. |
| Verified fact | Web project client owns local endpoint strings and local response typing. | `apps/web/src/features/projects/client.ts:7`, `:10`, `:22`, `:54`. |
| Verified fact | Web project DTO omits `callsignSeq`, while domain/repo project carries it. | `apps/web/src/features/projects/types.ts:19`; `packages/domain/src/project.ts:86`. |
| Verified fact | App loads project list once on mount and mutates local tab state after user actions. | `apps/web/src/App.tsx:79`, `:150`, `:171`, `:430`. |
| Verified fact | `ProjectWebSocketHub.broadcastAll` sends payloads unchanged. | `apps/server/src/services/websocket-hub.ts:62`. |
| Verified fact | Active/background WS hooks drop envelopes whose `projectId` does not match the subscribed project. | `apps/web/src/hooks/use-project-ws.ts:222`; `apps/web/src/hooks/use-all-projects-ws.ts:192`. |
| Verified fact | Project routes do not currently emit `project.changed` or any project-list invalidation event. | `rg -n "project.changed|project-changed" --glob "!archive/**"` only finds planning docs. |
| Verified fact | No active non-archive tests are present. | `rg --files --glob "!archive/**" --glob "!apps/server/data/**" \| rg "(test\|spec)\.(ts\|tsx\|js\|mjs)$"` returned no files. |

## 4. Exact Scope

Implement only these behaviors when the user asks to build:

1. Restore the minimal test harness needed for this slice.
2. Add `@pc/contracts` with shared result types, project DTO/request/response contracts, project route constants, parser functions, and a compatibility `project.changed` refetch envelope.
3. Add `@pc/app-services` with a narrow `ProjectService` for DB-backed project list/detail/update/reorder/soft-delete use cases.
4. Keep project creation on the existing `ProjectCreate` flow, but validate its request through the shared contract parser and emit the same compatibility refetch event after success.
5. Update `apps/server/src/features/projects/routes.ts` to delegate to the service/contracts while preserving current HTTP paths, status behavior, and response bodies.
6. Update the web project client/types to import shared contracts and route constants.
7. Add a targeted web refetch path for compatibility `project.changed` events.
8. Run the listed tests and typechecks.

Non-goals:

- Do not add `live_outbox`, migrations, replay cursor APIs, or durable event storage.
- Do not split runtime, transcript, Channel, mailbox, agents, workflows, work items, stages, field schemas, attachments, or MCP tools.
- Do not change project scaffold/git behavior in `ProjectCreate`.
- Do not remove legacy local optimistic updates from `App.tsx`.
- Do not change `deleteProjectFiles` or `revealProject` beyond any necessary type imports.
- Do not change `pc_*` MCP tool names or payloads.
- Do not restart the app or dev servers as part of implementation.

## 5. Contract Plan

New package:

```text
packages/contracts/package.json
packages/contracts/tsconfig.json
packages/contracts/src/index.ts
packages/contracts/src/shared.ts
packages/contracts/src/projects.ts
```

Contract rules:

- Browser-safe, side-effect-free, zero runtime dependencies in this slice.
- No imports from apps, `@pc/db`, `@pc/domain`, `@pc/runtime`, `@pc/mcp`, Hono, React, Node built-ins, or filesystem modules.
- Parsers accept `unknown` and return a typed parse result.
- Route constants preserve current endpoint paths and snake_case request keys.

Minimum shared contracts:

```ts
export type ULID = string;

export type ApiErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'UNSUPPORTED'
  | 'INTERNAL';

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code: ApiErrorCode; details?: unknown };

export interface ProjectStageDto {
  id: string;
  name: string;
  order: number;
  isDone?: boolean;
  isCancelled?: boolean;
  isNew?: boolean;
  rev?: number;
}

export interface ProjectSettingsDto {
  cancelledVisibility: 'use-global' | 'force-visible' | 'force-hidden';
}

export interface ProjectDto {
  id: ULID;
  slug: string;
  name: string;
  stages: ProjectStageDto[];
  folderPath: string;
  gitRemote: string | null;
  settings: ProjectSettingsDto;
  callsignSeq: number;
}

export type CreateProjectMode = 'init-empty' | 'init-in-place' | 'attach-to-git';

export interface CreateProjectRequest {
  name: string;
  folder_path: string;
  mode: CreateProjectMode;
  git_remote?: string | null;
}

export interface UpdateProjectRequest {
  name?: string;
  git_remote?: string | null;
}

export interface ReorderProjectsRequest {
  orderedIds: ULID[];
}

export type ProjectMutationReason =
  | 'created'
  | 'metadata-updated'
  | 'reordered'
  | 'soft-deleted';

export interface ProjectChangedRefetchEnvelope {
  type: 'project.changed';
  scope: 'global';
  projectId: null;
  reason: ProjectMutationReason;
  projectIdChanged?: ULID;
  project?: ProjectDto;
}
```

Compatibility contract:

- `project.changed` in this slice is a non-durable refetch hint, not the final `LiveEvent` outbox envelope.
- It uses `scope: 'global'` and `projectId: null` because project rail/list changes are app-level visible state.
- It must not pretend to have a durable `cursor`; that belongs to the later live-outbox slice.
- The later canonical `LiveEvent` can wrap this payload or replace it behind an adapter.

Conflict recorded:

- The live-events spec selects durable `project.changed` as the first outbox family, but this slice deliberately implements only a compatibility refetch event to stay small and reversible.

## 6. App Service / Repo Boundary Plan

New package:

```text
packages/app-services/package.json
packages/app-services/tsconfig.json
packages/app-services/src/index.ts
packages/app-services/src/projects.ts
```

Initial `ProjectService` owns:

| Use case | Service responsibility | Adapter responsibility |
|---|---|---|
| `listProjects` | Call repo, map domain project to `ProjectDto`, honor `includeDeleted`. | Extract query string. |
| `getProject` | Resolve project by id, map DTO, return not-found result. | Extract path param. |
| `updateProjectMeta` | Apply normalized patch via repo, return result and refetch event. | HTTP status mapping and runtime registry refresh. |
| `reorderProjects` | Validate ordered ids via parser, call repo, return fresh list and refetch event. | HTTP status mapping. |
| `softDeleteProject` | Call repo, return result and refetch event. | Runtime registry removal. |

Create flow:

- Keep `ProjectCreate.create` as the first-slice implementation for scaffold/git/runtime registration.
- The route adapter validates request shape with contracts before calling it.
- After success, route publishes the same `project.changed` compatibility refetch event.
- Do not move git, filesystem, or runtime registration side effects into `packages/app-services` in this slice.

Service boundary rules:

- `@pc/app-services` may depend on `@pc/contracts`, `@pc/db`, and `@pc/domain`.
- It must not import Hono, React, websocket hub, Channel server, runtime process classes, `ProjectCreate`, or MCP SDK.
- It returns contract-shaped DTOs/results, never Hono responses.

## 7. Route Adapter Plan

Files likely affected:

```text
apps/server/package.json
apps/server/src/index.ts
apps/server/src/features/projects/routes.ts
```

Route adapter requirements:

- Keep all current endpoint paths:
  - `GET /api/projects`
  - `PATCH /api/projects/reorder`
  - `POST /api/projects`
  - `PATCH /api/projects/:projectId`
  - `DELETE /api/projects/:projectId`
  - `GET /api/projects/:projectId`
- Preserve current success response shapes:
  - list: `{ projects }`
  - create/update/delete: `{ ok: true, project }`
  - reorder: `{ ok: true, projects }`
  - detail: raw project DTO
- Preserve current failure compatibility: `{ ok: false, error }`, with additive `code` only if tests prove callers tolerate it.
- Add a narrow route dependency such as `publishProjectChanged(event)` or `publishLiveEnvelope(event)`.
- In `apps/server/src/index.ts`, wire that dependency to current websocket fanout with `broadcastAll(event)` only for the compatibility refetch event.

Recommendation:

- Emit `project.changed` after successful create, update, reorder, and soft-delete.
- Do not emit on list/detail reads, file deletion, or reveal.
- Keep route-side runtime registry calls where they are now:
  - `refreshProject(updated)` after metadata update.
  - `removeProject(id)` after soft delete.
  - `ProjectCreate` already registers after create.

## 8. Live Compatibility Plan

This slice does not implement durable live events or replay. It only adds a typed refetch hint.

Server event:

```ts
{
  type: 'project.changed',
  scope: 'global',
  projectId: null,
  reason: 'created' | 'metadata-updated' | 'reordered' | 'soft-deleted',
  projectIdChanged: '<id>',
  project: optionalProjectDto
}
```

Web handling:

- Teach `useProjectWs` and `useAllProjectsWs` to accept this specific global compatibility envelope before enforcing project-id equality.
- Keep all other current project-id filtering behavior unchanged.
- Add an `App.tsx` effect or small feature hook that refetches `projectsApi.listProjects()` when a new `project.changed` envelope appears in active or background event buffers.
- Deduplicate by object identity/event position only as needed; this is a refetch hint, so duplicate hints are acceptable.
- Keep existing optimistic local updates for the initiating tab.

Open question:

- If the final outbox slice uses `{ type: 'live-event', event }` instead of direct event frames, this compatibility listener should be adapted rather than expanded.

## 9. Web Client / Hook Plan

Files likely affected:

```text
apps/web/package.json
apps/web/src/features/projects/client.ts
apps/web/src/features/projects/types.ts
apps/web/src/features/runtime/ws-types.ts
apps/web/src/hooks/use-project-ws.ts
apps/web/src/hooks/use-all-projects-ws.ts
apps/web/src/App.tsx
```

Web requirements:

- `apps/web/src/features/projects/types.ts` should re-export or alias shared contract types so existing imports keep working.
- `projectsApi` should use shared request/response types and route constants.
- Components should not need to know the new route constants directly.
- `WsEnvelope` must remain compatible with legacy runtime envelopes.
- The global `project.changed` allowance must be narrowly scoped so unrelated untagged global events are not accidentally accepted.
- Project list refetch must keep current active-project reconciliation behavior in `App.tsx`.

Compatibility:

- Existing UI code may continue importing `Project`, `Stage`, `ProjectSettings`, `ULID`, and `CreateProjectMode` from `./types` during this slice.
- `Project` can become an alias of `ProjectDto`; adding `callsignSeq` is wire-compatible because the server already returns it from the domain/repo object.

## 10. MCP Adapter Plan

MCP is out of scope for this slice.

Reason:

- No current `pc_*` tool needs project-list live refetch behavior to validate the contract package.
- The MCP foundation direction is typed localhost HTTP, but adding it here would broaden the first slice into tool compatibility work.

Future hook:

- `@pc/mcp` may import `@pc/contracts` after the project contracts compile through server and web.

## 11. Test Plan

Implementation must restore the minimal test harness before changing behavior.

Minimum restored or recreated tests:

| Priority | Test | Purpose |
|---|---|---|
| P0 | Contract parser tests in `packages/contracts/test/projects.test.ts` | Valid/invalid create, update, reorder, route constants, `ProjectDto` shape, `project.changed` envelope guard. |
| P0 | Import-boundary/static test for `@pc/contracts` | Prove contracts do not import apps, DB, runtime, MCP, Hono, React, or Node built-ins. |
| P0 | `apps/server/test/project-routes.test.ts` subset | Current route response parity for list, detail unknown 404, update, reorder, soft-delete, create validation. |
| P0 | Route publisher test | Successful create/update/reorder/delete call `publishProjectChanged`; reads/file delete/reveal do not. |
| P0 | `apps/server/test/websocket-hub.test.ts` subset | Preserve current `broadcast` project tagging and `broadcastAll` unchanged payload behavior. |
| P0 | Web global-envelope filter test | `useProjectWs`/`useAllProjectsWs` accept only `project.changed` global compatibility envelopes and still reject unrelated missing/mismatched `projectId` envelopes. |
| P1 | App project-list refetch test or focused helper test | `project.changed` causes `projectsApi.listProjects()` refetch and active slug reconciliation still works. |

Known current gap to characterize:

- Before adding the event, project mutations do not notify other connected clients. Preserve this as a test assertion or documented before/after test in the implementation PR.

Commands expected after test harness restoration:

```powershell
pnpm --filter @pc/contracts typecheck
pnpm --filter @pc/app-services typecheck
pnpm --filter @pc/server test
pnpm --filter @pc/web typecheck
pnpm typecheck
```

If package-level test scripts are not restored exactly, the implementation agent must document the equivalent commands it ran.

Manual verification after implementation:

- Open two browser clients with the same existing project selected.
- Rename the project in one client; the other client's rail/list refetches without manual reload.
- Reorder projects in one client; the other client refetches the rail order.
- Soft-delete a non-active project in one client; the other client removes it after refetch.
- Create a project in one client while another client has any project socket open; the other client refetches the project list.
- Confirm chat connect/replay behavior is unchanged.

## 12. Migration Steps

1. Restore the minimal `node:test`/`tsx --test` harness needed by this slice.
2. Add `@pc/contracts` package and project/shared contract tests.
3. Add package dependencies where needed:
   - `@pc/server` -> `@pc/contracts`, `@pc/app-services`
   - `@pc/web` -> `@pc/contracts`
   - `@pc/app-services` -> `@pc/contracts`, `@pc/db`, `@pc/domain`
4. Add `@pc/app-services` package and `ProjectService` tests.
5. Refactor project route adapters to use contracts/service for scoped use cases while preserving response parity.
6. Wire route-level `publishProjectChanged` in `apps/server/src/index.ts` through current `broadcastAll`.
7. Update web project types/client to shared contracts.
8. Add narrow global `project.changed` acceptance and project-list refetch.
9. Run the slice tests and typechecks.
10. Update tracker and handoff notes after implementation.

## 13. Rollback Plan

- Contracts/app-services packages are additive; revert package imports feature by feature.
- Keep `apps/web/src/features/projects/types.ts` as aliases so UI imports can be reverted quickly.
- If route parity fails, routes can delegate back to the current direct repo calls while leaving contracts in place.
- If global event acceptance causes noise, remove the web listener and route publisher; optimistic local updates still preserve current behavior.
- No DB migration is included, so rollback does not require schema changes.
- No runtime, Channel, mailbox, agent, workflow, or MCP behavior is touched.

## 14. Stop Conditions

Stop and return to planning if implementation requires any of the following:

- A destructive DB migration or `live_outbox` table implementation.
- Runtime/PTY/session, transcript, Channel, mailbox, agent-run, workflow-run, work-item, or MCP behavior changes.
- Changing project scaffold/git side effects in `ProjectCreate`.
- Removing legacy HTTP paths or changing existing response bodies.
- Broad websocket filter changes that accept unrelated untagged global events.
- Import cycles from `@pc/contracts` or `@pc/app-services`.
- Test harness restoration expands beyond the slice-specific tests without user approval.
- Current project create/delete/reorder behavior cannot be characterized before refactoring.

## 15. Acceptance Criteria

This slice is ready to implement only when the user explicitly asks to build and these criteria are accepted:

- `@pc/contracts` owns project DTO/request/response types and parser helpers.
- `@pc/app-services` owns low-risk DB-backed project service use cases.
- Project routes preserve current wire compatibility.
- Project creation remains on the existing `ProjectCreate` flow.
- A non-durable `project.changed` compatibility refetch event exists for project mutations.
- Web project client/types use shared contracts.
- Connected clients with active/background project sockets refetch the project list on `project.changed`.
- Tests cover contracts, import boundaries, route parity, event publishing, narrow global-event acceptance, and typechecks.
- Tracker marks this build-slice artifact `planned`.

## 16. Open Questions

| Question | Status |
|---|---|
| Should final durable outbox frames be direct `LiveEvent` objects or `{ type: 'live-event', event }` wrappers? | Deferred to live-outbox implementation slice. |
| Should project metadata changes eventually emit both global list events and project-scoped detail events? | Deferred. First slice uses global-only refetch. |
| Should full project creation later move into `@pc/app-services` behind filesystem/git/runtime ports? | Deferred. First slice keeps `ProjectCreate`. |
| Should MCP read-only project/config tools be the second contracts consumer after web/server? | Deferred to MCP typed-client slice. |

## 17. Notes for the Implementation Agent

- Start with tests and typecheck wiring. Do not change behavior first.
- Keep the first event a refetch hint, not a new source of truth.
- Keep compatibility event handling narrow. The current global-event bug is broader than this slice; do not solve all global websocket semantics here.
- Do not delete local web project types until every import is migrated or aliased.
- Do not treat this slice as permission to implement durable outbox replay. That is a separate slice.
