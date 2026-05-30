# 002 Project Live Outbox

## 1. Baseline and Decision

| Field | Value |
|---|---|
| Date | 2026-05-30 |
| Branch | `dev` |
| Commit | `f0b5c438acdc47adb2d5cb898a852f9e70823808` |
| Artifact status | Planned build slice |
| Owning roadmap phase | Phase 3 canonical live events for non-runtime resources |
| Slice subject | Durable `live_outbox` for `project.changed` only |
| Implementation target | This repo. Do not create a parallel app. |
| Scope rule | This is a build plan only. Do not implement until the user explicitly asks to build. |

Decision:

- **Recommendation:** Make `project.changed` the first durable live-event family by adding the canonical live-event contract, `live_outbox` table/repo, replay route, compatibility fanout, and web cursor/refetch path.
- **Reason:** Slice 001 already proved the project contract/app-service/web refetch path with a non-durable global `project.changed` hint. Slice 002 should turn that hint into a committed, replayable fact without expanding into work items, runtime, workflows, agents, mailbox, or MCP.
- **Compatibility stance:** Continue emitting the existing top-level `ProjectChangedRefetchEnvelope` while also emitting a canonical wrapped live-event frame. Existing clients keep working; new replay/cursor logic consumes the durable frame.

## 2. Problem Statement

Verified facts:

- Slice 001 added `@pc/contracts`, `@pc/app-services`, project route delegation, and the non-durable `project.changed` refetch hint.
- Project mutations currently broadcast `project.changed` through `ProjectWebSocketHub.broadcastAll`, which is still in-memory only.
- The web project rail refetches when it sees the non-durable `project.changed` hint, but it has no cursor or replay route for a missed event.
- `packages/db` still has no `live_outbox` table, repo, or exported live-event query path.

Synthesis:

- This slice should implement the second cartridge layer for the same low-risk project family:

```text
contract
  -> db outbox repo / publisher boundary
  -> route adapter / replay route
  -> live event fact and compatibility fanout
  -> web cursor/refetch hook
  -> tests
```

## 3. Current-State Evidence

| Label | Finding | Evidence |
|---|---|---|
| Verified fact | `packages/contracts/src/projects.ts` defines `ProjectChangedRefetchEnvelope` as a global, non-durable refetch hint with no `id`, `cursor`, `createdAt`, or outbox fields. | `packages/contracts/src/projects.ts` |
| Verified fact | `packages/app-services/src/projects.ts` returns `ProjectChangedRefetchEnvelope` from project create/update/reorder/soft-delete service calls. | `ProjectService.createProject`, `updateProjectMeta`, `reorderProjects`, `softDeleteProject` |
| Verified fact | Project routes publish the service event after successful mutations and preserve current HTTP response shapes. | `apps/server/src/features/projects/routes.ts` |
| Verified fact | Server composition wires `publishProjectChanged` to `broadcastAll(event)`. | `apps/server/src/index.ts` |
| Verified fact | `ProjectWebSocketHub.broadcastAll` JSON-serializes and sends the provided payload to every open subscriber without persistence, cursoring, or `projectId` injection. | `apps/server/src/services/websocket-hub.ts` |
| Verified fact | Web project live filtering accepts only matching project events or the specific global `project.changed` compatibility envelope. | `apps/web/src/features/projects/live-events.ts` |
| Verified fact | `App.tsx` scans active/background websocket buffers for `project.changed` and refetches `projectsApi.listProjects()` when found. | `apps/web/src/App.tsx` |
| Verified fact | `packages/db/src/schema.ts` has product/runtime/audit tables but no `live_outbox` table. | `packages/db/src/schema.ts`; search for `live_outbox` finds planning/docs only. |
| Verified fact | DB migrations are applied from `packages/db/drizzle` by `runMigrations`, and `assertSchemaIntact` compares declared Drizzle tables to the actual database after migration. | `packages/db/src/migrate.ts`, `apps/server/src/index.ts` |
| Verified fact | Current focused tests exist for contracts, server project routes, websocket hub behavior, project create flow, and web project live filtering. | `packages/contracts/test/*.test.ts`, `apps/server/test/*.test.ts`, `apps/web/test/project-live-events.test.ts` |

## 4. Exact Scope

Implement only these behaviors when the user asks to build:

1. Add the canonical live-event contract in `@pc/contracts`, constrained initially to `project.changed`.
2. Add an additive `live_outbox` Drizzle schema entry, hand-authored migration, and repo in `@pc/db`.
3. Add a server-owned live publisher boundary that writes the project mutation and outbox row in the same SQLite transaction wherever the product mutation is DB-only.
4. Preserve the existing project create filesystem/git/scaffold flow, but make the final project DB insert and `live_outbox` insert atomic after scaffold succeeds.
5. Add a replay route for live events after a cursor.
6. Dual-fanout after a committed outbox insert:
   - canonical wrapped live-event frame for new clients;
   - current top-level `project.changed` compatibility envelope for existing refetch logic.
7. Add a web live-event client/hook that tracks cursor, replays after reconnect, updates cursor from canonical frames, and triggers the same project-list refetch behavior.
8. Run the listed automated and manual verification.

Non-goals:

- Do not emit work-item, stage, workflow, agent, statusline, mailbox, runtime, transcript, or Channel events through `live_outbox`.
- Do not migrate `jsonl`, `session-replay`, `agent-jsonl-event`, or terminal/runtime events.
- Do not replace `ProjectWebSocketHub` or change `/ws` connection semantics.
- Do not remove the existing top-level `project.changed` compatibility envelope.
- Do not migrate MCP tools or add a typed MCP live-event client.
- Do not introduce mailbox tables, Channel removal, runtime host changes, or deep `ProjectRuntime` changes.
- Do not add destructive migrations or retention pruning in this slice.
- Do not restart or kill dev servers while implementing or verifying.

## 5. Contract Plan

Files likely affected:

```text
packages/contracts/src/live-events.ts
packages/contracts/src/projects.ts
packages/contracts/src/index.ts
packages/contracts/test/live-events.test.ts
packages/contracts/test/projects.test.ts
```

Canonical live-event contract:

```ts
export type LiveEventScope = 'project' | 'global';
export type LiveEventEntity = 'project';

export interface LiveEvent<TPayload = unknown> {
  id: ULID;
  cursor: string;
  scope: LiveEventScope;
  projectId: ULID | null;
  type: string;
  entity: LiveEventEntity;
  entityId: ULID | null;
  version: number | null;
  createdAt: number;
  payload: TPayload;
}

export interface LiveEventFrame<TPayload = unknown> {
  type: 'live-event';
  event: LiveEvent<TPayload>;
}
```

Project payload:

```ts
export interface ProjectChangedLivePayload {
  reason: ProjectMutationReason;
  projectIdChanged?: ULID;
  project?: ProjectDto;
}
```

First canonical `project.changed` shape:

```ts
{
  type: 'project.changed',
  entity: 'project',
  scope: 'global',
  projectId: null,
  entityId: payload.projectIdChanged ?? null,
  version: null,
  payload: ProjectChangedLivePayload
}
```

Contract decisions:

- Canonical websocket frames should be wrapped as `{ type: 'live-event', event }` in this slice. This avoids colliding with the existing top-level `project.changed` compatibility envelope and gives web filters one narrow global frame to accept.
- `project.changed` is global-only in this slice because it invalidates the app-level project rail/list and archived visibility. Do not add a project-scoped project detail event yet.
- `version` is `null` because project metadata has no monotonic revision column. The client refetches instead of applying patches.
- Keep `ProjectChangedRefetchEnvelope` in `projects.ts` as the legacy compatibility contract.
- Add helpers:
  - `isLiveEventFrame(value)`;
  - `isProjectChangedLiveEvent(value)`;
  - `toProjectChangedRefetchEnvelope(event)` or equivalent adapter for legacy fanout.

## 6. DB Migration and Repo Plan

Files likely affected:

```text
packages/db/src/schema.ts
packages/db/src/repos/live-outbox.ts
packages/db/src/index.ts
packages/db/package.json
packages/db/drizzle/0035_live_outbox.sql
packages/db/drizzle/meta/_journal.json
packages/db/test/live-outbox.test.ts
```

Add table: `live_outbox`.

Required columns:

| Column | Type | Rule |
|---|---|---|
| `seq` | integer primary key autoincrement | Global monotonic cursor source. |
| `id` | text unique not null | ULID event id. |
| `scope` | text not null | `'global'` or `'project'`. |
| `project_id` | text nullable | Required only for project-scoped events. |
| `type` | text not null | First production value: `project.changed`. |
| `entity` | text not null | First production value: `project`. |
| `entity_id` | text nullable | Changed project id when known; null for list/order events. |
| `version` | integer nullable | Null for project.changed. |
| `payload` | text/json not null | Browser-safe payload. |
| `created_at` | integer not null | Epoch ms. |
| `published_at` | integer nullable | Diagnostic only; replay must not depend on it. |

Required indexes:

- `live_outbox_created_idx` on `created_at`.
- `live_outbox_project_seq_idx` on `project_id, seq`.
- `live_outbox_scope_seq_idx` on `scope, seq`.
- `live_outbox_type_seq_idx` on `type, seq`.
- `live_outbox_entity_idx` on `entity, entity_id, seq`.

Migration requirements:

- The migration is additive only: create table and indexes, no existing table changes.
- Include a SQL check constraint or repo-level invariant so `scope='global'` has `project_id IS NULL` and `scope='project'` has a non-null `project_id`.
- Update `_journal.json` with `0035_live_outbox`; existing meta snapshots are already stale in this repo, so do not rely on them as schema evidence.
- `assertSchemaIntact()` must pass after the migration because `schema.ts` will declare the new table.

Repo responsibilities:

- `insertLiveEvent(tx, draft)` inserts one row inside the caller transaction and returns a canonical `LiveEvent`.
- `listLiveEventsAfter(input)` returns ordered canonical events after a cursor with project/global filtering.
- `getLiveEventHighWater()` returns the latest cursor for initial snapshot/high-water setup.
- Optional `markLiveEventsPublished(ids, now)` may be added for diagnostics, but replay correctness must not depend on it.

Replay filtering rules:

- `after` is an exclusive cursor: return rows where `seq > Number(after)`.
- Missing `after` means the client has just fetched HTTP truth; return no historical events and provide the current high-water cursor as `nextCursor`.
- A project replay returns project-scoped rows for that project plus global rows only when `includeGlobal=1`.
- A global replay without `projectId` returns only `scope='global'` rows.
- Clamp `limit` to a safe range, such as 1 to 500, default 100.
- Reject malformed cursors with a validation error; do not coerce arbitrary strings.

## 7. Publisher and Project Mutation Boundary Plan

Files likely affected:

```text
packages/app-services/src/live-events.ts
packages/app-services/src/projects.ts
packages/app-services/src/index.ts
apps/server/src/services/project-create.ts
apps/server/src/features/projects/routes.ts
apps/server/src/index.ts
```

Required boundary:

- Add a live publisher/app-service boundary that owns "project product mutation plus live outbox insert".
- It may depend on `@pc/contracts`, `@pc/db`, and `@pc/domain`.
- It must not import Hono, React, websocket hub, Channel, MCP SDK, or runtime process classes.
- It returns:
  - the current route response data;
  - the inserted canonical `LiveEvent<ProjectChangedLivePayload>`;
  - the compatibility `ProjectChangedRefetchEnvelope` for legacy fanout.

Mutation transaction rules:

| Mutation | Transaction requirement |
|---|---|
| Metadata update | Update `projects` row and insert `live_outbox` in one DB transaction. |
| Reorder | Rewrite project positions and insert one `project.changed` outbox row in one DB transaction. |
| Soft delete/archive | Set `deleted_at`/`updated_at` and insert `live_outbox` in one DB transaction. |
| Create | Keep scaffold/git side effects before DB persistence. The final project row insert and `live_outbox` insert must be one DB transaction after scaffold succeeds. |

Project create note:

- Filesystem/git scaffold rollback is still outside this slice. If scaffold or git commit fails, no project row or outbox row should be inserted. Once the DB insert starts, project row and outbox row must commit or roll back together.
- A targeted change to `ProjectCreate` is allowed only to inject or delegate the final project persistence operation. Do not change scaffold/git behavior or runtime registration semantics beyond what is needed to make the DB insert live-aware.

Compatibility:

- Preserve all current HTTP response shapes and statuses from slice 001.
- Preserve existing route-level `refreshProject` and `removeProject` calls.
- Emit no live event for list/detail reads, file cleanup, or reveal.

## 8. Replay Route and Server Adapter Plan

Files likely affected:

```text
apps/server/src/features/live-events/routes.ts
apps/server/src/index.ts
apps/server/test/live-events-routes.test.ts
```

Route:

```text
GET /api/live-events?after=<cursor>&projectId=<id>&includeGlobal=1&limit=<n>&type=project.changed
```

Response:

```ts
export interface ListLiveEventsResponse {
  ok: true;
  events: LiveEvent[];
  nextCursor: string | null;
  resetRequired?: boolean;
}
```

Server requirements:

- Register the route from `apps/server/src/index.ts`.
- Validate query values through `@pc/contracts` helpers.
- For this slice, allow only `project.changed` or omitted `type`; do not expose other event families.
- Return global rows only when no `projectId` is provided.
- Return global plus same-project rows when `projectId` is provided and `includeGlobal=1`.
- Never return project-scoped events for a different project.
- Do not make replay depend on websocket subscriber state.
- `resetRequired` should remain false/omitted because this slice adds no pruning. Future retention can set it when old cursors fall off.

## 9. WebSocket Compatibility Plan

Files likely affected:

```text
apps/server/src/index.ts
apps/server/src/features/projects/routes.ts
apps/server/test/project-routes.test.ts
apps/server/test/websocket-hub.test.ts
```

Fanout after a committed outbox insert:

```text
canonical: broadcastAll({ type: 'live-event', event })
legacy:    broadcastAll(projectChangedRefetchEnvelope)
```

Compatibility requirements:

- Keep `/ws` endpoint and query params unchanged.
- Keep `ProjectWebSocketHub.broadcastAll` behavior unchanged in this slice unless tests prove a minimal helper is needed.
- Keep the existing top-level `project.changed` event until cleanup slice 011.
- Do not fan out a canonical event until its outbox row has committed.
- If a product mutation rolls back, neither canonical nor legacy event should be broadcast.
- If websocket fanout throws or has zero subscribers, the committed outbox row remains replayable.

## 10. Web Client Cursor and Refetch Plan

Files likely affected:

```text
apps/web/src/features/live/client.ts
apps/web/src/features/live/hooks.ts
apps/web/src/features/projects/live-events.ts
apps/web/src/hooks/use-project-ws.ts
apps/web/src/hooks/use-all-projects-ws.ts
apps/web/src/App.tsx
apps/web/test/project-live-events.test.ts
```

Client requirements:

- Add a small live-events client for `GET /api/live-events`.
- Add a project-live hook or helper that:
  - accepts canonical `{ type: 'live-event', event }` frames for global `project.changed`;
  - stores the latest cursor after processing canonical frames;
  - replays after the stored cursor when active/background websocket status returns to open or when the app initializes after the project list snapshot;
  - refetches `projectsApi.listProjects()` when replay or live frames contain `project.changed`;
  - dedupes canonical events by `event.id`;
  - tolerates duplicate legacy and canonical hints by treating refetch as idempotent.
- Cursor storage may be in memory plus `localStorage` for app reload recovery. Initial project list fetch remains the source-of-truth snapshot.
- Narrowly update websocket filters so they accept:
  - matching project-scoped legacy events;
  - current top-level global `project.changed`;
  - canonical wrapped global `project.changed`;
  - and still reject unrelated global/missing-project events.

Initial-load policy:

- Fetch the project list first.
- Call replay with no `after` or with a saved cursor:
  - no `after`: server returns current high-water and no historical events;
  - saved `after`: server returns missed `project.changed` rows, causing a refetch if any are returned.

## 11. Test Plan

Implementation must add or update tests before behavior changes where practical.

Minimum automated tests:

| Priority | Test | Purpose |
|---|---|---|
| P0 | `packages/contracts/test/live-events.test.ts` | `LiveEvent`/frame guards, invalid scope/project combinations, project.changed payload guard, replay query parser, cursor validation. |
| P0 | `packages/db/test/live-outbox.test.ts` | Insert events, cursor string round-trip, global replay, project/global filtering, other-project exclusion, limit clamp, malformed cursor rejection, high-water behavior. |
| P0 | DB transaction rollback test | A project metadata update/reorder/archive rollback leaves neither product mutation nor outbox row. |
| P0 | `apps/server/test/live-events-routes.test.ts` | Replay route validates query, returns global project.changed events after cursor, excludes other project scoped events, handles no-cursor high-water. |
| P0 | `apps/server/test/project-routes.test.ts` updates | Successful create/update/reorder/archive insert a durable outbox row and fan out both canonical and legacy frames after commit; reads/file cleanup/reveal do not. |
| P0 | `apps/web/test/project-live-events.test.ts` updates | Filters accept canonical wrapped project.changed and reject unrelated global frames; cursor helper dedupes event ids and triggers refetch after replay/live frames. |
| P1 | Project create persistence test | Scaffold/create failure before DB persistence inserts no project and no outbox row; successful create commits both row and outbox event. |

Expected commands:

```powershell
pnpm --filter @pc/contracts test
pnpm --filter @pc/contracts typecheck
pnpm --filter @pc/db test
pnpm --filter @pc/db typecheck
pnpm --filter @pc/app-services typecheck
pnpm --filter @pc/server test
pnpm --filter @pc/server typecheck
pnpm --filter @pc/web test
pnpm --filter @pc/web typecheck
pnpm typecheck
```

If `@pc/db` does not yet have a test script, add the package-local `tsx --test "test/*.test.ts"` script as part of the implementation.

Manual verification after implementation:

- With two browser clients open, create a project in client A and verify client B's project rail updates without manual refresh.
- Rename/restore project metadata in client A and verify client B updates.
- Archive/delete visibility from client A and verify client B removes the row after refetch.
- Disconnect or block one client websocket, mutate a project, reconnect, and verify replay after cursor causes refetch.
- Confirm chat connect/replay behavior is unchanged.

## 12. Migration Steps

1. Add contract tests for canonical live-event frames and project.changed payloads.
2. Add `packages/contracts/src/live-events.ts` and export it.
3. Add `live_outbox` schema, migration, repo, and DB tests.
4. Add the app-service/server publisher boundary for project.changed.
5. Make project update/reorder/archive write product row plus outbox row in one transaction.
6. Adapt project create so scaffold/git behavior stays intact while final DB row insert plus outbox insert is atomic.
7. Add the replay route and route tests.
8. Dual-fanout canonical wrapped live-event and legacy `project.changed` after committed mutations.
9. Add the web live-events client/cursor/refetch helper.
10. Update project websocket filtering tests and App integration logic.
11. Run automated verification and two-client manual checks.
12. Update trackers with implementation notes.

## 13. Rollback Plan

- The DB migration is additive. If runtime issues appear, leave `live_outbox` unused and route project mutations back through the existing legacy `project.changed` fanout path.
- Keep the legacy top-level `project.changed` event as the immediate UI rollback path.
- Keep existing project HTTP response shapes and web optimistic updates.
- Replay route can be left registered but unused, or disabled from the web hook, without changing project product state.
- Do not drop the table during a normal rollback. Destructive schema cleanup waits for an explicit cleanup slice.
- If the live publisher breaks project create, revert the injected final persistence path in `ProjectCreate` while leaving contracts/schema in place.

## 14. Stop Conditions

Stop and return to planning if implementation requires any of the following:

- Runtime transcript, chat replay, agent, workflow, work-item, mailbox, MCP, or Channel behavior changes.
- Replacing `/ws`, changing websocket connection intent semantics, or restarting/killing dev processes.
- A destructive DB migration or migration that rewrites existing product rows.
- Moving scaffold/git filesystem behavior wholesale out of `ProjectCreate`.
- Introducing retention pruning, delivery acknowledgements, mailbox semantics, or event families beyond `project.changed`.
- Removing the top-level compatibility `project.changed` event.
- Changing existing project HTTP response bodies or failure status compatibility.
- Accepting unrelated untagged global websocket frames in project hooks.

## 15. Acceptance Criteria

This slice is ready to implement only when the user explicitly asks to build and these criteria are accepted:

- `@pc/contracts` owns a canonical live-event envelope, wrapper frame, replay DTOs, and `project.changed` payload helpers.
- `packages/db` owns an additive `live_outbox` table, migration, and repo with scope/cursor filtering.
- Project create/update/reorder/archive write the product mutation and `project.changed` outbox row atomically at the DB boundary.
- Server exposes a replay route for events after cursor.
- Server dual-emits canonical wrapped live-event frames and the legacy top-level `project.changed` compatibility hint.
- Web stores/updates a live cursor, replays after reconnect, and refetches project list/project metadata on canonical or legacy `project.changed`.
- Tests cover scope filtering, cursor replay, transaction rollback, compatibility fanout, and two-client behavior.
- Runtime, agents, workflows, work items, mailbox, Channel, and MCP remain untouched except for unaffected typecheck/test fallout.
- Tracker marks this build-slice artifact `planned`.

## 16. Open Questions

| Question | Status |
|---|---|
| Should legacy top-level `project.changed` be removed after canonical adoption? | Deferred to compatibility cleanup slice 011. |
| What retention/pruning policy should `live_outbox` use? | Deferred. Slice 002 ships no pruning; replay reset support can be structural only. |
| Should project metadata later get a project-scoped detail event in addition to global list invalidation? | Deferred. Slice 002 uses global-only refetch. |
| Should future non-project event families use the same replay route immediately? | Deferred to their owning slices. The route may be generic internally, but production emission is `project.changed` only. |

## 17. Notes for the Implementation Agent

- Keep tests first. The risky part of this slice is transaction/fanout ordering, not TypeScript surface area.
- Treat `live_outbox` as a durable notification fact, not a product event store.
- Do not optimize away HTTP refetch. Project UI should still recover from a malformed or expired cursor by refetching product truth.
- Keep canonical frame handling narrow: accepting every `scope='global'` frame in project hooks would reopen the global-event leak this refactor is trying to close.
- Do not use `archive/` as evidence or a source for tests.
