# Architecture Migration Plan

Purpose: move Caisson from the current mixed-but-converging architecture to the target cartridge architecture in `docs/target-architecture.md`.

Status: planning document for discussion. This plan favors incremental migration over rewrite.

## North Star

Every subsystem should converge on this shape:

```text
contract
  -> domain
  -> repo
  -> app service
  -> HTTP route
  -> live event
  -> web client/hook
  -> MCP adapter, when needed
  -> tests
```

The database remains the source of truth.

Runtime processes remain a special host, but not a product-rule owner.

## Strategy

- Do not rewrite.
- Do not start by splitting `ProjectRuntime`.
- Standardize one low-risk vertical slice first.
- Move contracts before moving runtime boundaries.
- Normalize live events before changing replay/recovery behavior.
- Replace Channel with a durable mailbox/delivery subsystem before deep runtime splitting.
- Keep each phase shippable.

## Phase 0: Baseline And Rules

Goal: make the target pattern explicit enough that new work stops adding drift.

Work:

- Keep `docs/system-map.md` as the current-state map.
- Keep `docs/target-architecture.md` as the target-state map.
- Add a feature cartridge checklist to PR/review expectations.
- Classify each subsystem as close, medium, or far from target.
- Pick one pilot feature for shared contracts.

Recommended pilot:

- `settings` if we want the lowest risk.
- `projects` if we want a slightly more useful baseline.

Do not pick runtime, workflows, or work items first.

Done when:

- New feature work has a documented expected cartridge shape.
- The first pilot feature is selected.
- No route/client/component should be added without an owning feature module.

Risk: low.

## Phase 1: Remove Known Drift

Goal: clear small mismatches before deeper architecture work.

Work:

- Fix approval UI to use the actual workflow review endpoint, or remove the stale approval bubble path.
- Move remaining component-level `fetch` calls behind feature clients where practical.
- Confirm no web-only API clients exist without server routes.
- Confirm no server routes exist without owning feature docs/client coverage.
- Remove or mark legacy work-item routes if they are still needed only for compatibility.

Done when:

- `rg "fetch(" apps/web/src` has only approved client-layer or exceptional call sites.
- Approval/review has one route contract.
- Current drift list in `docs/system-map.md` is shorter and actionable.

Risk: low/medium.

## Phase 2: Introduce Shared Contracts

Goal: create one shared place for browser-safe request, response, DTO, and event schemas.

Work:

- Create `packages/contracts`.
- Choose a schema tool already acceptable to the repo, or use TypeScript types first if runtime validation is not ready.
- Add contracts for the pilot feature.
- Make server route validation consume the contract.
- Make web client types consume the contract.
- Make MCP consume the contract only if that pilot feature has MCP tools.

Target package shape:

```text
packages/contracts/src/features/settings.ts
packages/contracts/src/features/projects.ts
packages/contracts/src/live.ts
packages/contracts/src/index.ts
```

Done when:

- One pilot feature has no hand-maintained duplicate request/response types.
- Server and web import the same contract types.
- The pattern is documented with a small example.

Risk: medium.

Main decision:

- Type-only contracts are faster.
- Runtime schemas are safer.
- Generated clients are stronger but more infrastructure.

Recommendation:

- Start with runtime schemas only where validation already exists or is easy.
- Avoid a generator until two or three features prove the shape.

## Phase 3: Convert Feature Clients And Services

Goal: make HTTP routes, web clients, and MCP tools adapters over the same use cases.

Work:

- Add `packages/app-services` or equivalent service boundary.
- Move pilot feature use cases into application services.
- Keep Hono routes thin.
- Keep MCP tools thin.
- Keep React components behind feature clients/hooks.
- Convert the next features in increasing risk order.

Recommended order:

1. Settings/onboarding.
2. Projects.
3. Files/project context.
4. Statusline/usage.
5. Work items/stages/fields/attachments.
6. Agents/pods.
7. Workflows.
8. Agent runs/pending asks.
9. Transient sessions.
10. Runtime host.

Done when:

- Server route modules mostly assemble dependencies and translate HTTP concerns.
- Product rules live in domain/app-service layers.
- MCP tools do not hand-roll product behavior.

Risk: medium.

## Phase 4: Canonical Live Events

Goal: make live UI state one resumable contract instead of several related event families.

Work:

- Add canonical live event contract.
- Add an `outbox_events` table or equivalent persisted event stream.
- Emit canonical events for one non-runtime feature first.
- Add client cursor tracking and replay endpoint for that feature.
- Convert additional non-runtime features.
- Only then apply the pattern to runtime/session events.

Target envelope:

```ts
interface LiveEvent<TPayload> {
  id: string;
  projectId: string | null;
  type: string;
  entity: string;
  entityId: string | null;
  version: number | null;
  cursor: string;
  createdAt: number;
  payload: TPayload;
}
```

Recommended first event:

- `project.updated`, or
- `work-item.changed` if we want higher value and accept more risk.

Done when:

- At least one feature can reconnect and replay from cursor.
- Web feature hooks consume canonical events, not ad hoc envelopes.
- Event writes are tied to DB writes.

Risk: medium/far.

## Phase 4B: Mailbox Delivery Replacement

Goal: replace Channel as a primary app primitive with durable mailbox delivery.

Current problem:

- Channel is a parallel communication plane.
- Delivery depends partly on live registration state.
- Inbox durability exists in places, but it is not the one delivery abstraction.
- Websocket/channel delivery and durable recovery are not one model.

Target flow:

```text
sender
  -> mailbox enqueue command
  -> durable message + recipient rows
  -> recipient poll/lease or websocket nudge
  -> recipient ack/fail
  -> retry, dead-letter, or completed state
  -> canonical live event for visibility
```

Work:

- Design mailbox contracts: enqueue, lease, ack, fail, retry, list.
- Add mailbox DB tables or refactor existing inbox/delivery tables into the target model.
- Move agent/orchestrator delivery to mailbox commands.
- Keep the Channel server as a compatibility adapter during migration.
- Convert channel events into mailbox-created live events.
- Remove direct dependence on registered child sessions for durable delivery.
- Add tests for offline recipient, reconnect, retry, ack, and dead-letter behavior.

Done when:

- Agent/orchestrator delivery can succeed after recipient reconnect without relying on in-memory channel state.
- Channel calls are adapters over mailbox enqueue/lease/ack, not the source of truth.
- UI visibility comes from canonical live events.
- The separate Channel host can be removed or reduced to a thin compatibility shim.

Risk: far.

This is a foundational change and should happen after contracts/live-event shape exists, but before splitting `ProjectRuntime`.

## Phase 5: Route Layout Convergence

Goal: make every backend subsystem discoverable under the same feature-module convention.

Work:

- Move older route modules from `apps/server/src/routes/*` into `apps/server/src/features/*`.
- Keep public URLs stable.
- Keep route factories dependency-injected.
- Add a route ownership table to `docs/system-map.md`.

Likely moves:

- `routes/pod-routes.ts` -> `features/agents/routes.ts` or `features/pods/routes.ts`.
- `routes/workflow-routes.ts` -> `features/workflows/routes.ts`.

Done when:

- `apps/server/src/routes/*` is empty or only compatibility shims remain.
- Every route group has a matching feature owner.

Risk: low/medium.

## Phase 6: Transient Session Unification

Goal: make agent designer, workflow builder, and setup wizard consume one session contract.

Work:

- Define a transient-session contract.
- Define one start/snapshot/event/replay shape.
- Extract repeated UI adapters.
- Make modal-specific behavior payload-driven.
- Keep existing user-facing flows stable.

Target flow:

```text
start session
  -> session snapshot
  -> normalized transcript/event stream
  -> pending ask/review event
  -> close/finalize
```

Done when:

- Transient session clients share one core hook.
- Modal-specific code handles only feature payloads.
- Runtime host APIs do not expose modal-specific transport quirks.

Risk: medium/far.

## Phase 7: Runtime Host Boundary

Goal: split process hosting from product rules after contracts and live events are stable.

Work:

- Define `RuntimeHost` interfaces.
- Define `SessionHost` and `RunHost` responsibilities.
- Move work item, attachment, field schema, workflow firing, and worktree product logic out of `ProjectRuntime`.
- Keep `ProjectRuntime` as a facade while internals move.
- Add replay/cursor tests before and after each extraction.

Target ownership:

```text
runtime-host:
  PTY/spawn
  stdin/resize/kill
  JSONL tailing
  process health
  transcript normalization
  cursors

app-services:
  work items
  workflows
  attachments
  field schemas
  project config
  worktree records
```

Done when:

- `ProjectRuntime` no longer directly owns unrelated product services.
- Runtime APIs expose process/session capabilities, not product mutations.
- Runtime replay is covered by tests.

Risk: far.

This is the hardest phase and should not start first.

## Phase 8: MCP Convergence

Goal: make MCP a thin adapter over the same contracts and services as web/server.

Work:

- Convert MCP tools feature by feature.
- Use shared contracts for inputs and outputs.
- Use app services directly where process topology allows.
- Use a shared typed local API client where MCP must call localhost HTTP.
- Remove hand-maintained duplicate DTOs.

Done when:

- MCP tools validate with shared contracts.
- MCP behavior matches HTTP route behavior by construction.
- Contract tests cover important MCP commands.

Risk: medium/far.

## Phase 9: Hardening And Deletion

Goal: remove compatibility paths after the new pattern is proven.

Work:

- Delete old route shims.
- Delete duplicated web types.
- Delete ad hoc event handlers.
- Delete stale service facades.
- Add architectural checks where practical.

Possible checks:

- No direct `fetch` in React components.
- No app imports from server internals.
- No MCP tool-local duplicate request types for converted features.
- No new routes outside `features/*`.

Done when:

- Drift stays low without manual audits.
- New feature work naturally follows the cartridge pattern.

Risk: low/medium.

## Suggested First Three Work Slices

### Slice 1: Approval Drift

Why:

- Small.
- User-visible.
- Removes known stale route behavior.

Deliverable:

- Approval UI uses the workflow v2 review endpoint, or the old UI path is removed.
- Web typecheck passes.

### Slice 2: Contracts Pilot

Why:

- Establishes the pattern before high-risk systems.

Deliverable:

- `packages/contracts` exists.
- One low-risk feature uses it from server and web.
- Documentation includes a copyable example.

### Slice 3: Component Fetch Cleanup

Why:

- Improves UI boundary without touching runtime internals.

Deliverable:

- Direct component fetches move into feature clients/hooks.
- Exceptions are documented.

### Slice 4: Mailbox Design Spike

Why:

- Channel replacement affects agents, orchestrator delivery, asks, transcripts, and runtime recovery.
- The table and contract shape should be agreed before code migration.

Deliverable:

- Mailbox contract draft.
- Mailbox table draft.
- Migration map from current Channel/inbox/delivery code to mailbox.
- Decision on poll/lease vs websocket-nudge semantics for each recipient type.

## Milestone Plan

### Milestone A: Stop The Drift

Includes:

- Phase 0.
- Phase 1.
- Slice 1.

Outcome:

- The app is still architecturally mixed, but no obvious stale paths remain.

### Milestone B: Shared Contracts Proved

Includes:

- Phase 2.
- Slice 2.
- One or two additional easy features.

Outcome:

- The team has a working pattern for server/web/MCP contract sharing.

### Milestone C: Feature Cartridge Standard

Includes:

- Phase 3 for close/medium features.
- Phase 5.
- Slice 3.

Outcome:

- Most non-runtime subsystems follow the target cartridge.

### Milestone D: Live Event Standard

Includes:

- Phase 4 for non-runtime features.
- Phase 4B mailbox design and initial delivery path.
- Replay/cursor tests.

Outcome:

- The UI has one live/recovery model for normal product data.
- Delivery no longer depends on Channel as the durable primitive.

### Milestone E: Runtime Split

Includes:

- Completion of Phase 4B.
- Phase 6.
- Phase 7.
- Runtime portions of Phase 4.

Outcome:

- Runtime becomes a host, not a mixed product/service owner.

### Milestone F: MCP And Cleanup

Includes:

- Phase 8.
- Phase 9.

Outcome:

- MCP, HTTP, and UI use the same contracts.
- Compatibility drift is removed.

## Sequencing Rationale

Contracts come before runtime split because runtime is too risky without stable boundaries.

Live events come before runtime replay changes because replay semantics need one envelope.

Mailbox replacement comes before runtime split because agent/orchestrator delivery must have one durable primitive before host boundaries move.

Route layout comes before deep service extraction because it improves discoverability with low behavioral risk.

MCP convergence comes after shared contracts because otherwise it repeats the current duplication.

## Work Not Included

- Visual redesign.
- Database engine change.
- Replacing Hono.
- Replacing Electron.
- Rewriting React state management.
- Rebuilding workflow execution from scratch.
- Replacing the runtime process model.

## Open Decisions

- Should shared contracts be type-only first, or runtime-validated from day one?
- Should `packages/app-services` be a new package, or should services live beside features until extracted?
- Should live events use one global outbox table or per-feature event tables plus a union view?
- Should mailbox delivery use explicit leases, simple polling, or websocket nudges plus ack?
- Should existing `agent_inbox` and `agent_delivery_audit` evolve into mailbox tables, or should mailbox be new tables with migration adapters?
- Should MCP call app services directly, or always call the local HTTP API?
- Which feature is the first contracts pilot: settings or projects?

## Recommendation

Start with Milestone A and B.

That means:

1. Fix approval/review drift.
2. Create `packages/contracts`.
3. Convert `settings` or `projects` as the pilot.
4. Document the cartridge template using that pilot.
5. Draft the mailbox contracts/tables before touching runtime host boundaries.
6. Only then start moving medium-risk features.

This gives us proof of the new architecture before touching the runtime host.
