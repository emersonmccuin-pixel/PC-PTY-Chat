# Shared Contracts and App Services Foundation Spec

## 1. Baseline and Scope

| Field | Value |
|---|---|
| Date | 2026-05-30 |
| Branch | `dev` |
| Commit | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` |
| Inputs | `target-architecture.md`, `holistic-architecture-synthesis.md`, `implementation-roadmap.md`, `refactor-tracker.md`, and six synthesized priority subsystem handoffs |
| Artifact status | Planned foundation spec |
| Scope | Contracts package rules, app-service boundaries, validation/result conventions, MCP access rule, and first migrated feature. No implementation code changes. |

Evidence rule:

- Verified facts come from current non-archive code inspection.
- Synthesis and recommendations come from the roadmap and subsystem handoffs.
- `archive/` was not searched, read, or cited.

## 2. Decisions

| Decision | Status | Rationale |
|---|---|---|
| Create `packages/contracts` before broad route/client migration. | Accepted | Every priority subsystem has duplicated DTOs or event shapes across server, web, MCP, or runtime. |
| Keep `packages/contracts` browser-safe and side-effect-free. | Accepted | Web, server, MCP, and future test code must import it without pulling Node, Hono, React, DB, runtime, or MCP SDK code. |
| Start contracts with zero new runtime dependencies. | Accepted for first slice | Current package manifests do not include a schema library such as zod/valibot/typebox. Plain parsers/guards reduce install and bundle risk. |
| Create `packages/app-services` as the server-side use-case home, but move one feature at a time. | Accepted | App services should depend on contracts/domain/db and narrow ports, not Hono, React, websocket registries, Channel, or raw PTY handles. |
| MCP uses a typed localhost HTTP client first, not direct app-service imports. | Accepted | `packages/mcp` is a separate Claude-spawned process. The process boundary is real, so typed HTTP is safer before any in-process adapter exists. |
| First migrated feature is project list/project metadata. | Accepted | It already has feature routes and a web client, is lower risk than runtime/agents/workflows, and has a known live-refresh gap. |
| Do not finalize canonical live-event/outbox semantics here. | Deferred | The next foundation spec owns envelope cursor/replay/outbox details. This spec only reserves draft event names and import rules. |

## 3. Verified Current-State Evidence

| Label | Finding | Evidence |
|---|---|---|
| Verified fact | Current packages are `agent-host`, `db`, `domain`, `mcp`, `runtime`, `utils`, and `workflows`; `packages/contracts` and `packages/app-services` do not exist. | `packages/` directory listing |
| Verified fact | Root workspace includes every `packages/*` and `apps/*`, so adding new packages fits the current workspace shape. | `pnpm-workspace.yaml` |
| Verified fact | `@pc/server` currently depends on `@pc/db`, `@pc/domain`, `@pc/mcp`, `@pc/runtime`, `@pc/utils`, and `@pc/workflows`; it has no contracts/app-services dependency yet. | `apps/server/package.json` |
| Verified fact | `@pc/web` imports `@pc/domain` and `@pc/runtime` directly today; browser-safe shared packages are already used by the renderer. | `apps/web/package.json` |
| Verified fact | Project HTTP routes parse request bodies manually and call DB/repos/registry dependencies directly. | `apps/server/src/features/projects/routes.ts:48`, `:49`, `:54`, `:67`, `:100`, `:122`, `:180` |
| Verified fact | The web project client hand-writes response types and endpoint paths. | `apps/web/src/features/projects/client.ts:6`, `:7`, `:10`, `:20`, `:22`, `:29`, `:54` |
| Verified fact | The web project DTO is local and differs from the server/domain surface by omission. | `apps/web/src/features/projects/types.ts`; `packages/domain/src/project.ts:86` |
| Verified fact | Project repo functions already provide a clean DB boundary for list/create/reorder/update/delete. | `packages/db/src/repos/projects.ts:55`, `:86`, `:130`, `:176`, `:203` |
| Verified fact | Project creation is not a simple DB command; it scaffolds files, runs git, inserts the row, and registers the runtime. | `apps/server/src/services/project-create.ts:70`, `:76`, `:155`, `:163` |
| Verified fact | WebSocket envelopes are manually mirrored in the web runtime feature. | `apps/web/src/features/runtime/ws-types.ts:3`, `:167`, `:198`, `:553`, `:577` |
| Verified fact | `ProjectWebSocketHub` is in-memory fanout; `broadcastAll` sends unchanged payloads. | `apps/server/src/services/websocket-hub.ts:14`, `:38`, `:62` |
| Verified fact | MCP tools use a raw localhost HTTP context and hand-written payload checks. | `packages/mcp/src/tools/context.ts:19`, `:28`, `:30`, `:112`, `packages/mcp/src/tools/project-config.ts`, `packages/mcp/src/tools/work-items.ts` |
| Verified fact | No current non-archive `*.test.*` or `*.spec.*` files are discoverable. | `rg --files --glob "!archive/**" \| rg "(test\|spec)\.(ts\|tsx\|js\|mjs)$"` |

## 4. Boundary Rules

### `packages/contracts`

Recommendation:

- Own browser-safe wire contracts: request DTOs, response DTOs, MCP args/results, event DTOs, and shared API result/error shapes.
- Export type definitions, literal constants, route builders, and small `parse*`/`is*` functions.
- Use no side effects and no global state.
- Depend on no app packages, no `@pc/db`, no `@pc/runtime`, no `@pc/mcp`, no Hono, no React, and no Node built-ins.
- Avoid importing `@pc/domain` in the first slice. Keep DTOs wire-stable and map domain rows to DTOs in app services or adapters.

Allowed first-slice exports:

```text
packages/contracts/src/index.ts
packages/contracts/src/shared.ts
packages/contracts/src/projects.ts
packages/contracts/src/live-events-draft.ts
```

### `packages/app-services`

Recommendation:

- Own command/query use cases after request validation.
- Depend on `@pc/contracts`, `@pc/domain`, `@pc/db`, and narrow port interfaces.
- Must not import Hono, React, MCP SDK, websocket hub, `ChannelServer`, or raw PTY/runtime process classes.
- May be Node/server-only. Browser safety belongs to contracts, not app services.
- Return DTOs/results shaped by contracts, not raw Hono `Response` values.

Allowed first-slice exports:

```text
packages/app-services/src/index.ts
packages/app-services/src/projects.ts
```

Ports should be explicit when a use case must touch in-memory or filesystem adapters:

```ts
interface ProjectRuntimePort {
  register(project: ProjectDto): void;
  refresh(project: ProjectDto): void;
  remove(projectId: string): void;
}

interface ProjectCreateFlowPort {
  create(input: CreateProjectRequest): Promise<ProjectDto>;
}

interface LivePublisherPort {
  publish(event: DraftProjectEvent): void;
}
```

Synthesis:

- DB-only commands such as list, detail, metadata update, reorder, and soft-delete can move to `ProjectService` early.
- Full project creation should initially call the existing `ProjectCreate` flow through a port, because it owns git/scaffold/runtime registration side effects today.
- `deleteProjectFiles` and `revealProject` should remain route/OS adapter operations until a later project-lifecycle spec; they are not part of the first contract/service slice.

## 5. Shared Result and Validation Model

Recommendation:

```ts
export type ApiOk<T extends object = {}> = { ok: true } & T;

export type ApiErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'UNSUPPORTED'
  | 'INTERNAL';

export interface ApiErr<TDetails = unknown> {
  ok: false;
  error: string;
  code?: ApiErrorCode;
  details?: TDetails;
}

export type ApiResult<TOk extends object, TDetails = unknown> =
  | ApiOk<TOk>
  | ApiErr<TDetails>;

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code: ApiErrorCode; details?: unknown };
```

Validation rules:

- Contract parsers accept `unknown` and return `ParseResult<T>`.
- Parsers normalize only the target DTO. They should not perform DB lookups or business side effects.
- Routes map parse errors to existing HTTP statuses and preserve `{ ok: false, error }` compatibility.
- Web clients may use shared response/request types immediately, but should not perform runtime validation unless a boundary receives `unknown`.
- MCP tool handlers must use the same parsers for migrated tool args, then format the resulting `ApiResult` as current text-compatible MCP content.

Open constraint:

- A schema library can be revisited after the first contract package compiles through server, web, and MCP. Do not add one in the first slice unless the implementation agent proves the package and bundle impact are low.

## 6. First Contract Family: Projects

Recommended contract file: `packages/contracts/src/projects.ts`.

Wire DTOs:

```ts
export type ULID = string;

export interface ProjectSettingsDto {
  cancelledVisibility: 'use-global' | 'force-visible' | 'force-hidden';
}

export interface ProjectStageDto {
  id: string;
  name: string;
  order: number;
  isDone?: boolean;
  isCancelled?: boolean;
  isNew?: boolean;
  rev?: number;
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
```

HTTP request/response contracts:

```ts
export type CreateProjectMode = 'init-empty' | 'init-in-place' | 'attach-to-git';

export interface ListProjectsQuery {
  include_deleted?: '1';
}

export type ListProjectsResponse = { projects: ProjectDto[] };

export interface CreateProjectRequest {
  name: string;
  folder_path: string;
  mode: CreateProjectMode;
  git_remote?: string | null;
}

export type CreateProjectResponse = ApiResult<{ project: ProjectDto }>;

export interface UpdateProjectRequest {
  name?: string;
  git_remote?: string | null;
}

export type UpdateProjectResponse = ApiResult<{ project: ProjectDto }>;

export interface ReorderProjectsRequest {
  orderedIds: ULID[];
}

export type ReorderProjectsResponse = ApiResult<{ projects: ProjectDto[] }>;

export type DeleteProjectResponse = ApiResult<{ project: ProjectDto }>;
```

Route builders:

```ts
export const projectRoutes = {
  list: '/api/projects',
  create: '/api/projects',
  reorder: '/api/projects/reorder',
  detail: (projectId: ULID) => `/api/projects/${encodeURIComponent(projectId)}`,
};
```

Compatibility requirements:

- Preserve current endpoint paths and snake_case request keys.
- Preserve successful response shapes currently used by the web client.
- Preserve `{ ok: false, error }` on failures. `code` and `details` may be additive.
- Include `callsignSeq` in `ProjectDto` because the domain/repo object currently carries it; web callers may continue to ignore it.
- Keep `include_deleted=1` query behavior.

## 7. Project App Service Shape

Recommended service: `ProjectService`.

Initial use cases:

| Use case | Service owns | Adapter still owns |
|---|---|---|
| `listProjects` | DB query, DTO mapping, include-deleted option | HTTP query extraction |
| `getProject` | Project existence check, DTO mapping | HTTP path param extraction |
| `updateProjectMeta` | Trimmed patch command, repo call, not-found result | Runtime registry refresh port call, legacy response status mapping |
| `reorderProjects` | ID array validation, repo call, fresh list DTO | HTTP status mapping |
| `softDeleteProject` | Repo call, DTO mapping, not-found result | Runtime registry removal port call |
| `createProject` | Contracted command wrapper | Existing `ProjectCreate` flow via `ProjectCreateFlowPort` |

Not in first service:

- `deleteProjectFiles`: filesystem deletion and safety markers.
- `revealProject`: OS process launch.
- Runtime bootstrap internals.

Draft service command flow:

```text
Hono route
  -> contracts parser
  -> ProjectService command/query
  -> @pc/db repo call or ProjectCreateFlowPort
  -> ProjectRuntimePort effect when needed
  -> optional DraftProjectEvent returned/published
  -> contract response
```

Draft event facts returned by the service:

```ts
export type ProjectMutationReason =
  | 'created'
  | 'metadata-updated'
  | 'reordered'
  | 'soft-deleted';

export interface DraftProjectChangedEvent {
  type: 'project.changed';
  scope: 'global';
  projectId: null;
  reason: ProjectMutationReason;
  project?: ProjectDto;
}
```

Conflict:

- The live-events/outbox spec may replace or wrap this draft event shape. Until then, project routes can emit a legacy compatibility event or return the event fact for future wiring.

## 8. MCP and Typed Local Client Rule

MCP decision:

- `packages/mcp` should not import `packages/app-services` for the first phases.
- It should import `@pc/contracts` and use a typed local HTTP helper over its existing localhost `ToolContext`.
- Tool names and text result compatibility remain unchanged.

Target typed helper behavior:

```text
MCP args
  -> contract parser
  -> typed HTTP request through localhost
  -> decode contract response
  -> current MCP text/JSON content formatter
```

First MCP migration candidate:

- Project config read-only calls such as stage listing are low-risk, but the first build slice does not need MCP unless the slice expands beyond project list/project metadata.
- Agent-run and workflow MCP tools should wait for their subsystem contracts.

## 9. Migration Phases

| Phase | Goal | Files likely affected | Risk | Verification |
|---|---|---|---|---|
| 0 | Restore or create characterization tests before behavior changes. | Test harness and focused route/client tests | Low behavior risk | Tests run; current behavior documented. |
| 1 | Add `@pc/contracts` skeleton and project contracts without changing callers. | New `packages/contracts/*`, package/workspace config | Build/import risk | `pnpm --filter @pc/contracts typecheck`; repo typecheck when wired. |
| 2 | Move web project types/client to contract imports. | `apps/web/src/features/projects/*` | Low | Typecheck; project create/update/list response parity tests. |
| 3 | Add `@pc/app-services` skeleton and `ProjectService` for DB-only project use cases. | New `packages/app-services/*`, project routes | Medium | Route parity tests for list/detail/update/reorder/delete. |
| 4 | Wrap project create through a `ProjectCreateFlowPort`. | Project routes/service wiring | Medium/high because create touches git/scaffold/runtime registry | Characterization test with fake create-flow port; no filesystem behavior change. |
| 5 | Add project-list compatibility live event. | Project route adapter, web project hook/client | Medium | Two-client project rail refresh test; reconnect refetch test. |
| 6 | Migrate one MCP read-only project/config call to typed contract client. | `packages/mcp/src/tools/project-config.ts`, typed HTTP helper | Low/medium | Fake HTTP tests for 2xx, non-2xx, validation, transport errors. |

Stop conditions:

- The slice needs runtime, Channel, workflow-run, agent-run, transcript, or mailbox behavior changes.
- It requires a destructive DB migration.
- `@pc/contracts` creates import cycles with server, web, runtime, or MCP.
- Existing project create/delete/reorder behavior cannot be characterized.

## 10. Compatibility and Rollback

Compatibility:

- Keep all current HTTP paths.
- Keep current response bodies as the wire compatibility baseline.
- Keep local web types as temporary aliases during migration.
- Keep MCP raw HTTP helper as fallback while a typed helper is introduced.
- Keep legacy websocket event shapes until the live-events/outbox spec defines canonical adapters.

Rollback:

- Contracts package is additive; imports can be reverted feature by feature.
- App-service route adapters should preserve old functions until route parity tests pass.
- Project live-event changes should be gated by compatibility event handling and deterministic refetch.
- No DB migration is required for this foundation slice.

## 11. Acceptance Criteria

This foundation direction is ready for build-slice planning when:

- `packages/contracts` rules are clear: browser-safe, side-effect-free, no Node/Hono/React/MCP/db/runtime imports.
- Shared result/error and parse conventions are documented.
- `packages/app-services` rules are clear: command/query use cases, repo transactions, narrow ports, no adapter imports.
- Project DTO/request/response contracts are defined as the first feature family.
- MCP's first migration path is typed localhost HTTP, not direct app-service import.
- The live-event decision is deliberately deferred to `live-events-and-outbox.md`.
- Migration phases, rollback posture, and tests are explicit.

Build implementation still requires user confirmation.

## 12. Test Plan

Required characterization before or with implementation:

- Project route response parity:
  - list projects with and without `include_deleted=1`;
  - detail unknown project returns current 404 shape;
  - update name/git remote trims and preserves slug;
  - reorder validates `orderedIds`;
  - soft-delete returns current project response.
- Contract parser tests:
  - accepts current valid project requests;
  - rejects missing `name`, `folder_path`, or invalid `mode`;
  - preserves snake_case wire keys;
  - accepts optional `git_remote: null`.
- Import-boundary tests or static checks:
  - `@pc/contracts` does not import apps, db, runtime, mcp, Hono, React, or Node built-ins.
  - `@pc/app-services` does not import Hono, React, MCP SDK, websocket hub, Channel, or runtime process classes.
- Web client tests:
  - project client decodes current list/create/update/reorder responses through contract types.
- MCP typed helper tests if included:
  - maps validation errors, non-2xx responses, transport errors, and 2xx JSON response bodies without changing text compatibility.
- Live project refresh tests once event compatibility is implemented:
  - project create/rename/delete/reorder in one client causes another client to refetch or receive a typed compatibility event.

Current gap:

- No current non-archive tests exist, so the phase-0 test characterization plan remains a build-readiness dependency.

## 13. Open Questions

Blocking for later specs, not for this one:

- What exact canonical `LiveEvent` envelope and outbox cursor semantics should `project.changed` use?
- Should project creation eventually move fully into `packages/app-services`, including scaffold/git ports, or remain as a server-local lifecycle flow?
- Should the first implementation slice include project-list live projection or stop at contracts/service parity until the live-events spec exists?

Non-blocking:

- Whether to add a schema library after the zero-dependency parser approach proves too verbose.
- Whether contracts should later import selected domain constants, or keep all DTOs independent for wire stability.
- Whether route constants should live in each contract file or in a generated typed client package after more families migrate.

## 14. Next Planning Artifact Notes

The next foundation spec, `refactor plan/foundation specs/live-events-and-outbox.md`, should consume these decisions:

- `packages/contracts` is the home for the canonical live-event DTOs.
- `packages/app-services` should produce durable facts or publish through a narrow `LivePublisherPort`.
- Project metadata is the first low-risk feature that needs a live/refetch story.
- This spec intentionally does not settle event IDs, cursors, replay, outbox table shape, global/project scope semantics, or retention.
