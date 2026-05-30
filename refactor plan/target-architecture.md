# Target Architecture From First Principles

Purpose: describe the app shape we would choose if rebuilding Caisson from the ground up, then compare that target to the current codebase.

Status: planning document for discussion. This is not a rewrite proposal.

Migration planning should happen through:

- subsystem handoff docs in `refactor plan/refactor plan docs/`;
- the tracker at `refactor plan/refactor-tracker.md`;
- the holistic synthesis at `refactor plan/holistic-architecture-synthesis.md`.

This document is the north star. It is not current-state evidence and it is not the implementation roadmap by itself.

## Core Thesis

Caisson should be a database-and-event-log-first app with several adapters around the same durable state.

The adapters are:

- React web UI.
- Electron shell.
- Hono HTTP API.
- Runtime process host.
- WebSocket live event server.
- MCP tools.
- Mailbox/delivery subsystem.
- Mailbox delivery workers for UI inboxes and app-injected runtime turns.

No adapter should own product rules. Product rules should live in shared domain and application-service layers.

## One Pattern For Every Subsystem

Every subsystem should follow the same cartridge shape:

```text
contract
  -> domain
  -> db repo
  -> application service
  -> HTTP route
  -> live events
  -> web client/hooks
  -> MCP adapter, when agents need it
  -> tests
```

The HTTP API, MCP tools, and UI should be different entry points into the same commands and queries.

## Target Package Layout

```text
apps/
  server/          # Hono composition root, route registration, static serving
  web/             # React UI, feature hooks, view state
  desktop/         # Electron shell only

packages/
  contracts/       # shared request, response, event, and DTO schemas
  domain/          # pure product rules and state transitions
  db/              # schema, migrations, repos
  app-services/    # command/query use cases; no Hono, no React
  runtime-host/    # PTY/process/session host
  live/            # event envelope, outbox, websocket replay rules
  mailbox/         # durable message queues, delivery leases, acknowledgements
  mcp/             # MCP tools as adapters over contracts/services
```

This layout is less important than the boundary rule: routes, MCP tools, and React components must not duplicate business contracts.

## Command Flow

All mutations should look like this:

```text
UI or MCP command
  -> contract validation
  -> application service
  -> domain rule
  -> repo transaction
  -> outbox/live event write
  -> HTTP result
  -> websocket fanout
  -> UI refetch or typed patch
```

Important properties:

- Commands are explicit.
- Commands validate one shared schema.
- Domain logic is framework-free.
- Database writes and live invalidation are tied together.
- UI recovery does not depend on best-effort in-memory broadcasts.

## Query Flow

All reads should look like this:

```text
UI or MCP query
  -> contract validation
  -> application service
  -> repo read
  -> contract-shaped result
```

Components should not call `fetch` directly. They should call feature clients or hooks.

## Live Event Flow

Live events should be canonical and resumable:

```text
db transaction
  -> outbox_events row
  -> websocket fanout
  -> client cursor update
  -> reconnect resumes from cursor
```

Every live event should have the same outer shape:

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

The payload can vary by subsystem, but the envelope should not.

## Mailbox And Delivery Boundary

Channels should be removed entirely. The target architecture should not depend on Claude development channels, `notifications/claude/channel`, `/channel-register`, or a separate channel host.

The target replacement is a durable mailbox subsystem:

```text
sender
  -> mailbox command
  -> durable message row
  -> delivery policy
  -> UI inbox/live nudge or app-injected runtime turn
  -> recipient acknowledgement
  -> canonical live event
  -> retry, dead-letter, or completion state
```

Mailbox owns:

- message creation;
- recipient addressing;
- delivery state;
- leases and retries;
- acknowledgements;
- dead-letter handling;
- audit trail.

Mailbox should not own:

- runtime process lifecycle;
- workflow rules;
- work-item rules;
- chat rendering;
- direct websocket session registries.
- prompt rendering as the source of truth.

Target mailbox records:

- `mailbox_messages`;
- `mailbox_deliveries`;
- `mailbox_recipients`;
- `mailbox_dead_letters`;
- `mailbox_audit`.

Migration can keep existing Channel code only until replacement paths are implemented. The target plan should not add new Channel compatibility; cutover replaces channel send/register behavior with mailbox enqueue and app-owned delivery.

Target replacement:

```text
agent/workflow/webhook
  -> mailbox enqueue
  -> delivery policy
  -> UI inbox/live nudge or app-injected orchestrator turn
  -> recipient command or observed runtime send acknowledges
  -> live event for UI visibility
```

Human/user decisions surface in an app inbox. Orchestrator-addressed messages use the existing runtime send queue as normal queued turns when a session is ready; there is no mid-turn out-of-band Channel delivery. This makes delivery durable and recoverable without requiring a separate long-lived channel host.

## Database Model

Use one SQLite database for durable state.

Use table families by subsystem:

- Durable product records: projects, work items, workflows, agents, settings.
- Runtime records: sessions, runs, process snapshots.
- Transcript/event records: append-only logs.
- Outbox records: live UI invalidation and replay.
- Mailbox records: messages, recipients, delivery attempts, acknowledgements.

No important app state should exist only in memory.

In-memory maps are allowed only as runtime projections:

- connected sockets;
- active process handles;
- short-lived tailers;
- debouncers;
- cached snapshots that can be rebuilt.

## Runtime Host Boundary

Runtime is the main special case. It should have its own host boundary.

Runtime host owns:

- PTY/spawn lifecycle.
- stdin/stdout/stderr.
- resize.
- process health.
- JSONL tailing.
- transcript normalization.
- cursor management.

Runtime host should not own:

- work-item product rules;
- workflow product rules;
- attachment rules;
- field-schema rules;
- project configuration mutation.

Target runtime flow:

```text
session or run row
  -> runtime-host starts process
  -> raw process events
  -> normalized transcript/run events
  -> persisted cursor and snapshot
  -> canonical live event
  -> HTTP replay/recovery endpoint
```

## Web UI Boundary

The web app should be organized by feature, but use shared contracts.

Target feature shape:

```text
apps/web/src/features/work-items/
  client.ts        # calls HTTP using shared contracts
  hooks.ts         # query/mutation/live integration
  components/      # feature-local UI
  types.ts         # re-exports shared contract types only when possible
```

Rules:

- Components do not own API paths.
- Components do not own request/response types.
- Components do not decode raw websocket envelopes.
- Feature hooks subscribe to canonical live events and decide refetch vs patch.

## MCP Boundary

MCP should be an adapter, not a second API implementation.

Target MCP flow:

```text
MCP tool input
  -> shared contract validation
  -> app-service command/query or typed local API client
  -> shared result contract
```

If MCP must talk to the running app over localhost HTTP, it should use the same generated or shared typed client as the web layer.

## Feature Cartridge Example

Work items should have this shape:

```text
packages/contracts/work-items.ts
packages/domain/work-items.ts
packages/db/src/repos/work-items.ts
packages/app-services/src/work-items.ts
apps/server/src/features/work-items/routes.ts
apps/web/src/features/work-items/client.ts
apps/web/src/features/work-items/hooks.ts
packages/mcp/src/tools/work-items.ts
```

The service should own use cases:

- create work item;
- patch work item;
- move work item;
- archive/restore;
- attach artifact;
- replace field schemas;
- emit `work-item.changed` live events.

## Current Distance From Target

Overall: the app is not rebuild-level far away.

It already has many of the right ingredients:

- monorepo with app/package split;
- Hono server composition root;
- SQLite with Drizzle repos;
- domain package;
- feature route modules;
- web feature clients;
- runtime websocket;
- MCP package;
- durable runtime/session records.

The gap is standardization and boundary cleanup, not invention.

## Distance By Area

| Area | Distance | Why |
|---|---|---|
| Projects | Close | Already follows route, repo, web-client pattern. |
| Files/project context/settings/onboarding | Close | Mostly conventional API-backed subsystems. |
| Work items/stages/fields/attachments | Medium | Strong pattern, but web types still drift from domain and legacy routes remain. |
| Workflows | Medium | Good domain/workflow packages exist, but route layout and review/builder flows are split across old/new patterns. |
| Agents/pods/tool catalog | Medium | Durable DB and clients exist, but pod routes still live outside the newer feature layout. |
| Agent runs/pending asks | Medium | Good subsystem shape, but runtime/live/transcript behavior should converge on canonical events. |
| Statusline/usage | Medium | Works, but contracts are mirrored manually rather than shared. |
| Project worktrees | Medium/Far | It is runtime-adjacent and currently coupled through `ProjectRuntime`. |
| Transient sessions | Medium/Far | Similar pattern repeated across agent designer, workflow builder, and setup wizard; needs one adapter contract. |
| Runtime host/orchestrator chat | Far | The hardest gap: process lifecycle, JSONL tailing, session state, websocket, and product services are still too intertwined. |
| Mailbox/delivery replacing Channel | Far | Current Channel bridge is a parallel communication plane; target is durable mailbox plus optional websocket nudges. |
| MCP | Medium/Far | Tool families exist, but they hand-roll HTTP contracts instead of sharing the command/query layer. |

## Main Gaps

### 1. Shared Contracts

Current issue:

- Web, server, and MCP maintain overlapping request/response/event shapes.
- Some web types mirror domain/server shapes by hand.

Target:

- `packages/contracts` owns browser-safe DTOs, commands, queries, and live events.
- Server routes and web clients import the same contracts.
- MCP tools validate against the same contracts.

Distance: medium.

This is mostly mechanical, but it touches many files.

### 2. Runtime Host Boundary

Current issue:

- `ProjectRuntime` is a broad host for orchestrator PTY, transient sessions, worktrees, work items, attachments, field schemas, and workflow triggers.

Target:

- Runtime host owns processes and transcripts.
- App services own product rules.
- Runtime calls app services through explicit interfaces.

Distance: far.

This should be split slowly after contracts and tests exist.

### 3. Canonical Live Events

Current issue:

- Runtime websocket events, transient-session events, channel events, and agent-run events are related but not one envelope family.

Target:

- One live envelope.
- One cursor/replay story.
- Feature-specific payloads under a shared shell.

Distance: medium/far.

This is foundational because it affects recovery and UI state.

### 4. Mailbox Instead Of Channel

Current issue:

- Channel is a parallel delivery plane with its own host and websocket registry.
- Some agent/orchestrator delivery depends on registration state plus partial inbox durability.

Target:

- Mailbox is the durable delivery primitive.
- Channel disappears; no development-channel bridge is part of the target runtime.
- Websocket is a nudge/visibility layer, not the delivery source of truth.
- Recipients are UI inboxes, app services, or runtime turn queues that acknowledge completion through explicit app-owned contracts.

Distance: far.

This should come after shared contracts and the live event envelope, but before deep runtime splitting.

### 5. Route Layout

Current issue:

- Newer server modules live under `apps/server/src/features/*`.
- Some older pod/workflow routes still live under `apps/server/src/routes/*`.

Target:

- Every subsystem has a feature module with route factory, service dependencies, and tests.

Distance: close/medium.

This is lower risk than runtime work.

### 5. UI Fetch Discipline

Current issue:

- Most UI calls go through feature clients.
- Some components still call `fetch` directly for transcripts, approvals, or custom error handling.

Target:

- Components use feature hooks/clients only.
- Error handling is centralized per feature client.

Distance: close/medium.

## Recommended Migration Order

Do not start by rewriting runtime.

Recommended order:

1. Define the target cartridge convention in docs and code review rules.
2. Create `packages/contracts` for one low-risk feature first, likely settings or projects.
3. Move web feature types to shared contracts one feature at a time.
4. Move MCP tools onto shared contracts or a shared typed local API client.
5. Normalize live event envelopes for non-runtime entities first.
6. Design mailbox contracts/tables and replace Channel delivery with UI inbox and app-injected orchestrator turns.
7. Fix stale route drift, especially approval/review handling.
8. Move older route modules into `features/*`.
9. Extract app services out of `ProjectRuntime` behind interfaces.
10. Standardize transient-session adapters.
11. Split runtime host internals only after replay/cursor/mailbox contracts are stable.

## What Not To Do

- Do not start with a full rewrite.
- Do not split `ProjectRuntime` before the contracts are written.
- Do not create a second state store beside SQLite.
- Do not let MCP become a separate product API.
- Do not make websocket events the source of truth.
- Do not let React components own backend path strings.
- Do not build new dependencies on Claude development channels or `/channel` compatibility.

## Near-Term Definition Of Done

The app is meaningfully closer to this target when:

- one shared contract package is used by server, web, and MCP;
- every route group has an owning feature module;
- every UI mutation goes through a feature client/hook;
- every live event has a canonical envelope;
- mailbox is the durable delivery primitive and Channel/development-channel bridges are gone from the target runtime;
- `ProjectRuntime` exposes narrower host interfaces and no longer directly owns unrelated product services;
- reconnect/replay behavior is tested for runtime and non-runtime live events.
