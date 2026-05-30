# Live Events and Outbox Foundation Spec

## 1. Baseline and Scope

| Field | Value |
|---|---|
| Date | 2026-05-30 |
| Branch | `dev` |
| Commit | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` |
| Inputs | `target-architecture.md`, `holistic-architecture-synthesis.md`, `implementation-roadmap.md`, `shared-contracts-and-app-services.md`, `refactor-tracker.md`, and synthesized subsystem handoffs |
| Artifact status | Planned foundation spec |
| Scope | Canonical live-event envelope, scope/global semantics, cursor/replay, outbox table, service ownership, legacy adapters, migration phases, tests, and open questions. No implementation code changes. |

Evidence rule:

- Verified facts below come from current non-archive code inspection.
- Synthesis and recommendations come from the roadmap, foundation contract spec, holistic synthesis, and subsystem handoffs.
- `archive/` was not searched, read, cited, or used.

## 2. Decisions

| Decision | Status | Rationale |
|---|---|---|
| `packages/contracts` owns the browser-safe live-event DTOs. | Accepted | The shared-contracts spec already reserves contracts as the wire-contract home, and current server/web event shapes are manually mirrored. |
| Add a durable `live_outbox` table before relying on cursor replay. | Accepted | Current non-runtime WS events are best-effort fanout only; reconnect safety needs a persisted event fact. |
| Use one canonical envelope with explicit `scope` and nullable `projectId`. | Accepted | Existing `broadcastAll` events conflict with project-filtered clients; `scope: 'global' | 'project'` removes ambiguity. |
| Use a global monotonic outbox cursor. | Accepted | A single DB-ordered cursor gives deterministic replay across project and global events without per-entity cursor negotiation. |
| Product state remains source of truth; live events are durable notification/projection facts. | Accepted | Work items, workflows, agents, sessions, and status snapshots already own state in DB/files; outbox should not become a second product store. |
| New/refactored app-service mutations must write product state and live outbox in the same DB transaction. | Accepted | This is the reliability improvement over route-level "write then broadcast" behavior. |
| Legacy WS envelopes stay during migration. | Accepted | Current UI hooks consume `work-item-changed`, `workflow-v2-run-changed`, `agent-run-changed`, `jsonl`, `session-replay`, and related shapes. |
| Runtime transcript JSONL is not moved into `live_outbox` by this spec. | Deferred | The runtime transcript and conversation store spec owns file compatibility versus SQLite transcript storage. |
| Mailbox delivery acknowledgements are not modeled as live-event delivery. | Deferred | Mailbox can emit live visibility events later, but delivery leases/acks belong to the mailbox spec. |

## 3. Verified Current-State Evidence

| Label | Finding | Evidence |
|---|---|---|
| Verified fact | Current packages are `agent-host`, `db`, `domain`, `mcp`, `runtime`, `utils`, and `workflows`; there is no `packages/contracts`, `packages/app-services`, `packages/live`, or `packages/mailbox`. | `packages/` directory listing; `rg --files --glob "!archive/**" \| rg "(^|/)packages/(contracts|app-services|live|mailbox)(/|$)"` returned no matches. |
| Verified fact | No canonical outbox/live-event table or package exists. | `rg -n "outbox|live_event|live_events|websocket_events" apps packages --glob "!archive/**" --glob "!apps/server/data/**"` returned no matches. |
| Verified fact | `ProjectWebSocketHub` stores only an in-memory `Map<ProjectId, Set<WebSocketLike>>`. | `apps/server/src/services/websocket-hub.ts:14` |
| Verified fact | `broadcast(projectId, msg)` injects `projectId` into object payloads before sending JSON. | `apps/server/src/services/websocket-hub.ts:38` |
| Verified fact | `broadcastAll(msg)` sends payloads unchanged to all sockets and does not inject project scope. | `apps/server/src/services/websocket-hub.ts:62` |
| Verified fact | Server composition root defines `broadcastTo` and `broadcastAll` around the in-memory hub. | `apps/server/src/index.ts:168`, `apps/server/src/index.ts:177`, `apps/server/src/index.ts:186` |
| Verified fact | Current active and background project WS clients drop any parsed envelope whose `projectId` does not match the socket project. | `apps/web/src/hooks/use-project-ws.ts:222`, `apps/web/src/hooks/use-all-projects-ws.ts:192` |
| Verified fact | Runtime reconnect has file-backed replay via `session-replay`, while non-runtime resources do not have outbox replay. | `apps/server/src/features/runtime-host/websocket-connect.ts:61`, `apps/server/src/services/session-replay.ts:141` |
| Verified fact | Runtime JSONL events are persisted to per-session `jsonl-events.jsonl` before live broadcast. | `packages/runtime/src/interactive-session.ts:440`, `apps/server/src/features/runtime-host/pty-handlers.ts:153` |
| Verified fact | Resource emitters use ad hoc legacy event names and route/service-level broadcasts. | `work-item-changed` in `apps/server/src/services/work-item-writer.ts:17`; `workflow-v2-run-changed` in `apps/server/src/services/workflow-run-writer.ts:22`; `pod-changed` in `apps/server/src/services/pod-writer.ts:15`; `statusline-snapshot` in `apps/server/src/features/statusline/routes.ts:92` |
| Verified fact | Workflow global definition changes use `broadcastAll`, while project-scoped changes use `broadcastTo`. | `apps/server/src/routes/workflow-routes.ts:258` |
| Verified fact | Project create, reorder, update, and soft-delete routes mutate state but do not emit a live project-list event. | `apps/server/src/features/projects/routes.ts:49`, `:54`, `:67`, `:100`, `:122` |
| Verified fact | `useResourceList` refetches on WS reconnect because the hub has no catch-up. | `apps/web/src/hooks/use-resource-list.ts:64` |
| Verified fact | Some feature hooks are still bespoke and do not key initial fetch on WS reconnect epoch. | `apps/web/src/hooks/use-project-workflows.ts:39`, `apps/web/src/hooks/use-project-stages.ts:36` |
| Verified fact | Web event types are local and permissive: `WsEnvelope` has `projectId`, `type`, and arbitrary fields. | `apps/web/src/features/runtime/ws-types.ts:3` |
| Verified fact | `workflow_run_events` exists as a workflow audit/event table, but it is not the general live outbox. | `packages/db/src/schema.ts:323` |
| Verified fact | `agent_inbox` and `agent_delivery_audit` are delivery-specific tables, not general live events. | `packages/db/src/schema-agent-system.ts:138`, `:169` |
| Verified fact | No current non-archive `*.test.*` or `*.spec.*` files are discoverable in this checkout. | `rg --files --glob "!archive/**" \| rg "(test\|spec)\.(ts\|tsx\|js\|mjs)$"` returned no matches. |

## 4. Canonical Contract

Recommended file: `packages/contracts/src/live-events.ts`.

```ts
export type LiveEventScope = 'project' | 'global';

export type LiveEventEntity =
  | 'project'
  | 'work-item'
  | 'stage'
  | 'attachment'
  | 'agent-pod'
  | 'agent-run'
  | 'workflow-definition'
  | 'workflow-run'
  | 'workflow-review'
  | 'statusline'
  | 'mailbox-message'
  | 'runtime-session'
  | 'conversation';

export interface LiveEvent<TPayload = unknown> {
  id: string;
  cursor: string;
  scope: LiveEventScope;
  projectId: string | null;
  type: string;
  entity: LiveEventEntity;
  entityId: string | null;
  version: number | null;
  createdAt: number;
  payload: TPayload;
}
```

Envelope rules:

- `id` is a stable event id, preferably a ULID generated before insert.
- `cursor` is the decimal string form of the global `live_outbox.seq` value.
- `scope: 'project'` requires a non-null `projectId`.
- `scope: 'global'` requires `projectId: null` and may only carry payloads safe for every project-visible consumer.
- `entity` identifies the resource family for client subscription and refetch policy.
- `entityId` is the durable resource id when one exists; list-level events may use `null`.
- `version` is the latest resource version/rev when the entity has one; otherwise `null`.
- `payload` must be a browser-safe DTO from `packages/contracts`, not raw DB rows with secrets or process-only fields.

Recommended event naming:

| Legacy event | Canonical event | Scope |
|---|---|---|
| none for project list | `project.changed` | `global` for list/order changes; `project` for project-local metadata where needed |
| `work-item-changed` | `work-item.changed` | `project` |
| `stages-changed` | `stage.list.changed` | `project` |
| `attachment-changed` | `attachment.changed` | `project` |
| `pod-changed` | `agent-pod.changed` | `global` |
| `workflow-changed` | `workflow.definition.changed` | `global` or `project` depending on row scope |
| `workflow-v2-run-changed` | `workflow.run.changed` | `project` |
| `workflow-v2-review-pending` | `workflow.review.changed` | `project` |
| `agent-run-changed` | `agent.run.changed` | `project` |
| `agent-jsonl-event` | Deferred to transcript spec | `project` |
| `statusline-snapshot` | `statusline.snapshot.changed` | `project` |
| `channel-event` | Deferred to mailbox spec | `project` or mailbox recipient scope |
| `session-changed` / `runtime-state` | Deferred to transcript/conversation spec | `project` |
| `jsonl` / `session-replay` | Deferred to transcript/conversation spec | `project` |

Synthesis:

- Canonical event names use dot-separated domain facts.
- Legacy names stay as compatibility frames until every consumer migrates.
- `agent-jsonl-event`, chat `jsonl`, and `session-replay` should not be forced into this table before the transcript storage spec decides the source of truth.

## 5. Outbox Table and Repo

Recommended table: `live_outbox`.

```ts
export const liveOutbox = sqliteTable(
  'live_outbox',
  {
    seq: integer('seq', { mode: 'number' }).primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique().$type<ULID>(),
    scope: text('scope').notNull().$type<'project' | 'global'>(),
    projectId: text('project_id').$type<ULID | null>(),
    type: text('type').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id').$type<ULID | null>(),
    version: integer('version'),
    payload: text('payload', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
    createdAt: integer('created_at').notNull(),
    publishedAt: integer('published_at'),
  },
  (t) => [
    index('live_outbox_created_idx').on(t.createdAt),
    index('live_outbox_project_seq_idx').on(t.projectId, t.seq),
    index('live_outbox_scope_seq_idx').on(t.scope, t.seq),
    index('live_outbox_entity_idx').on(t.entity, t.entityId, t.seq),
  ],
);
```

Repo responsibilities:

- `insertLiveEvent(tx, draft)` writes an event inside the caller's transaction and returns the canonical `LiveEvent`.
- `listLiveEventsAfter(input)` returns ordered events after a cursor with project/global filtering.
- `markPublished(ids, now)` is optional diagnostic state only; replay must not depend on it.
- `pruneLiveEvents(policy)` removes old replay rows after retention while preserving cursor-reset semantics.

Cursor rules:

- Cursor order is `seq ASC`.
- `cursor` is emitted as a string so clients do not depend on JS integer precision if the table grows.
- A missing cursor means "current snapshot/refetch first, then listen".
- A cursor older than retention returns a reset response; clients must refetch affected queries and store the newest cursor.
- Clients should dedupe by `id` and guard resource patches with `version` when available.

Outbox is not:

- a mailbox delivery queue;
- a workflow run event source of truth;
- the transcript store;
- a replacement for product tables;
- proof that a browser saw an event.

## 6. Ownership and Write Path

Recommended ownership:

| Layer | Owns | Must not own |
|---|---|---|
| `packages/contracts` | Live DTOs, event name constants, replay request/response DTOs, payload contracts | DB access, Hono, React, WebSocket objects |
| `packages/db` | `live_outbox` schema/repo and transaction helpers | Business decisions or transport fanout |
| `packages/app-services` | Command/query use cases that write product state and outbox rows in one transaction | Socket registries, raw PTY/process handles, React state |
| `apps/server` live adapter | Replay route, websocket subscription/fanout, legacy envelope adapters | Product mutations |
| `apps/web` live feature | Cursor storage, subscription hooks, refetch/patch policy | Backend paths inside components, raw unknown event parsing in feature components |
| `packages/mcp` | Typed local HTTP client use of same commands that write outbox | Independent live-event emission |

Target mutation flow:

```text
HTTP/UI/MCP command
  -> shared contract parser
  -> app service
  -> DB transaction
       -> product repo write
       -> live_outbox insert
  -> route response
  -> server live adapter fans out the inserted LiveEvent
  -> legacy adapter optionally sends old WS envelope
```

Compatibility flow for old write paths:

```text
legacy route/service write
  -> current DB/repo mutation
  -> existing broadcastTo/broadcastAll legacy envelope
  -> optional outbox shadow insert after write
```

Conflict:

- Shadow inserts after legacy writes improve observability but are not transactionally reliable. Treat them as a bridge only. Build-readiness for a migrated feature requires service-owned transaction plus outbox insert.

## 7. Replay and Subscription Semantics

Recommended HTTP replay endpoint:

```text
GET /api/live-events?projectId=<id>&after=<cursor>&limit=<n>&includeGlobal=1
```

Recommended response:

```ts
export interface ListLiveEventsResponse {
  ok: true;
  events: LiveEvent[];
  nextCursor: string | null;
  resetRequired?: boolean;
}
```

Filtering:

- For a project subscription, return:
  - all `scope='project' AND project_id=:projectId` events;
  - plus `scope='global'` events when `includeGlobal=1`.
- For app-level project rail/list subscriptions, allow global-only replay without a project id if needed.
- Never return project-scoped events for a different project.

Recommended WebSocket compatibility:

- Keep `/ws?projectId=<id>&intent=chat|activity` unchanged for runtime compatibility.
- Add optional live replay params only after the client hook exists, for example `after=<cursor>&includeGlobal=1`.
- New canonical frames may be sent directly as `LiveEvent` objects.
- Legacy frames continue until all current consumers migrate.
- `useProjectWs` and `useAllProjectsWs` must not remain the only event filters for canonical live events, because they currently reject `projectId: null` global events.

Client policy:

- Feature hooks subscribe by `entity` and `type`.
- Each feature chooses either "refetch on event" or "apply snapshot if version is newer".
- Project list/project metadata should start with refetch-on-`project.changed`.
- Work items, workflow runs, and agent runs can use versioned snapshot patches once payload contracts exist.
- Reconnect should run replay from cursor first; if replay says reset, refetch affected feature queries.

## 8. First Event Families

Recommended first implementation order:

| Order | Event family | Why first | Payload policy |
|---:|---|---|---|
| 1 | `project.changed` | First vertical slice subject; currently has no live event and is lower risk than runtime. | Refetch hint with mutation reason and optional project DTO. |
| 2 | `work-item.changed` | Existing write-door and versioned snapshots make migration straightforward. | Full contract DTO with `version`. |
| 3 | `stage.list.changed` | Current event already carries full stamped stage list. | Full stage list with shared project/stage DTOs. |
| 4 | `workflow.definition.changed` | Resolves `broadcastAll` global/project ambiguity. | Refetch hint or row DTO once workflow contracts exist. |
| 5 | `workflow.run.changed` | Existing writer uses `rev`; high UI reliability value. | Full run DTO with `rev`. |
| 6 | `agent.run.changed` | Activity panel reliability; depends on agent-run contract. | Full run DTO with current `rev`. |
| 7 | `statusline.snapshot.changed` | Already has durable snapshot rows but route-local live projection. | Latest snapshot DTO or refetch hint. |
| 8 | mailbox-related events | Needed after mailbox spec. | Message/delivery/read-state DTOs, not ack truth. |

Do not migrate first:

- `jsonl`, `session-replay`, raw terminal, and `agent-jsonl-event`. Their storage/replay decision belongs to the runtime transcript spec.
- `channel-event`. It is a legacy Channel projection and should be replaced by mailbox events after the mailbox spec.

## 9. Migration Phases

| Phase | Goal | Files likely affected | Risk | Verification | Rollback |
|---|---|---|---|---|---|
| 0 | Restore/create focused tests for current hub, filters, emitters, and reconnect behavior. | Test harness only | Low behavior risk | Tests document `broadcastAll`/filter mismatch and current refetch behavior. | Remove tests only. |
| 1 | Add live-event contracts without changing callers. | `packages/contracts/src/live-events.ts` | Build/import risk | Contract typecheck and parser/builder tests. | Remove additive package/files. |
| 2 | Add DB outbox schema/repo behind no active callers. | `packages/db/src/schema.ts`, repo files, migrations | DB migration risk | Insert/list/replay/prune repo tests. | Additive migration can be ignored; no product callers yet. |
| 3 | Add server replay API and live adapter skeleton. | `apps/server/src/features/live-events/*` | Low/medium | Replay filtering tests for project/global/retention reset. | Leave unused endpoint disabled or remove route. |
| 4 | Migrate first project-list event family. | Project service/routes, project web hook | Medium | Two-client project create/rename/delete/reorder refresh tests. | Keep existing local App updates and disable canonical listener. |
| 5 | Dual-emit canonical plus legacy events for selected non-runtime resources. | Work item, stage, workflow, agent-run, statusline emitters | Medium/high | Legacy hooks still update; canonical replay returns same mutation fact. | Turn off canonical fanout, keep legacy broadcasts. |
| 6 | Move migrated feature hooks to canonical live/replay hook. | `apps/web/src/features/live/*`, feature hooks | Medium | Reconnect-after-write replay/refetch tests. | Revert feature hook to legacy WS events. |
| 7 | Require app-service transaction plus outbox for migrated features. | `packages/app-services`, route adapters | Medium/high | DB write and outbox insert commit/rollback together. | Route can delegate back to legacy write path while legacy event remains. |
| 8 | Clean up legacy event shapes only after static search and tests prove no consumers remain. | Server emitters, web ws-types, hooks | High | No active references to removed event names; integration suite passes. | Isolated cleanup PR/checkpoint. |

## 10. Compatibility and Rollback

Compatibility requirements:

- Keep current `/ws` endpoint and query parameters.
- Keep current legacy event names until migrated clients no longer consume them.
- Do not change runtime chat connect/replay behavior in this spec.
- Do not change `intent=activity` into a runtime-spawning connection.
- Do not make global events leak project-scoped payloads.
- Do not make UI websocket receipt count as mailbox delivery acknowledgement.
- Keep deterministic HTTP refetch as fallback when replay cursor is missing or expired.

Rollback posture:

- Contracts and outbox schema are additive.
- Canonical fanout should be feature-gated or isolated per event family.
- Legacy events remain the rollback path while a family migrates.
- Outbox replay can be disabled while routes continue to return current HTTP truth.
- Destructive removal of legacy envelopes waits for the final compatibility cleanup phase.

## 11. Acceptance Criteria

This foundation spec is build-ready when:

- The `LiveEvent` envelope, scope rules, and cursor semantics are documented.
- The proposed `live_outbox` table and replay filtering rules are explicit.
- It is clear that product state remains in product tables and live events are durable projection facts.
- App-service mutations have a required transaction/outbox write rule.
- Runtime transcript, mailbox delivery, and Channel replacement concerns are deliberately deferred to their owning specs.
- Legacy event compatibility and rollback are explicit.
- The first event family is selected: `project.changed`.
- Tests cover current behavior before migration and target behavior after migration.

Implementation still requires user confirmation.

## 12. Test Plan

Required characterization tests before behavior changes:

- `ProjectWebSocketHub`:
  - multiple subscribers per project;
  - closed socket pruning;
  - `broadcast(projectId, msg)` injects project id;
  - `broadcastAll(msg)` sends unchanged payloads.
- Current client filters:
  - active and background hooks reject envelopes whose `projectId` does not match;
  - global untagged events are currently dropped by those hooks.
- Current reconnect behavior:
  - `useResourceList` refetches on WS epoch;
  - bespoke workflow/stage hooks do not refetch on WS epoch.
- Current emitters:
  - work item, stage, workflow run, agent run, pod, workflow definition, statusline, and channel events keep their legacy shapes.

Required contract/repo tests:

- `LiveEvent` builders reject invalid project/global scope combinations.
- `cursor` string round-trips from numeric `seq`.
- Outbox insert stores browser-safe JSON payload.
- Project replay includes project-scoped events and opted-in global events.
- Project replay excludes other projects' scoped events.
- Retention reset returns `resetRequired`.
- Duplicate event ids are rejected.

Required integration tests after implementation starts:

- DB mutation and outbox insert commit together; rollback leaves neither product mutation nor event.
- Project create/update/delete/reorder writes `project.changed` and a second client refetches.
- Socket disconnected during a project mutation can recover by replay or reset/refetch.
- Legacy and canonical dual emission do not double-apply resource updates.
- Global workflow/pod changes reach project views through explicit `scope='global'` handling.
- MCP-originated mutation and UI-originated mutation produce the same event family once that command is migrated.

Manual verification after implementation starts:

- Open two browser clients on one project; mutate project metadata and verify project rail/list refresh without manual reload.
- Disconnect one client, mutate a migrated resource, reconnect, and verify cursor replay or reset/refetch.
- Create/update a global workflow or pod and verify all relevant project views refresh.
- Confirm chat session connect/replay behavior is unchanged.

Current gap:

- No current non-archive tests exist, so the phase-0 test characterization plan remains a build-readiness dependency.

## 13. Observability

Recommended diagnostics:

- Event id, cursor, scope, project id, entity, entity id, type, version, created time.
- Replay request id, project id, input cursor, returned count, reset reason, and max cursor.
- Fanout attempt count by event id and subscriber count by project.
- Legacy adapter mapping from canonical event id to legacy envelope type.
- Outbox retention pruning count and oldest remaining cursor.

Debug surfaces:

- Admin/dev route or panel for latest outbox cursor and replay by project.
- Log malformed event payloads with event id and type.
- Do not log secrets or raw mailbox/channel prompt bodies from payloads.

## 14. Open Questions

Blocking for implementation slice planning:

- Should `project.changed` use `scope='global'` for all project list/order mutations, or should project metadata changes emit both global list and project-scoped detail events?
- What retention policy should ship first: age-based, row-count-based, or both?
- Should canonical events be sent directly as `LiveEvent` frames or wrapped as `{ type: 'live-event', event }` during the first compatibility phase?

Deferred to mailbox spec:

- Which mailbox facts emit live events?
- Does mailbox read/action state use the same outbox table or a mailbox-specific event/audit table plus live projection?
- What recipient identity appears in mailbox live payloads without leaking cross-project data?

Deferred to runtime transcript spec:

- Whether chat/runtime transcript events mirror into SQLite or remain file-backed behind a transcript repository.
- Whether runtime session lifecycle events should use `live_outbox` before transcript storage changes.
- How global outbox cursor relates to transcript sequence/high-water replay.

Non-blocking:

- Whether a future `packages/live` helper package should wrap contracts/db/server adapter code, or whether `packages/contracts` plus `packages/db` plus server feature modules are sufficient.
- Whether `publishedAt` should remain diagnostic-only or be replaced by a separate fanout audit table if delivery observability becomes important.

## 15. Next Planning Artifact Notes

The next foundation spec, `refactor plan/foundation specs/mailbox-and-pending-interactions.md`, should consume these decisions:

- WebSocket/live events are projection facts, not delivery acknowledgements.
- Mailbox may emit canonical live events for UI visibility, but its leases/retries/acks are separate mailbox state.
- `channel-event` is a legacy event family and should not be expanded as the target delivery model.
- Scope and cursor semantics are now defined enough for mailbox UI nudges to reference the live envelope.

