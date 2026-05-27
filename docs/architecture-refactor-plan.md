# Caisson Architecture Boundary Audit and Refactor Plan

Drafted: 2026-05-27

Purpose: decide whether Caisson should be refactored into clearer boundaries, and define a practical plan for doing it without freezing product work or losing the working runtime pieces.

Companion contract: [Chat System Contract](./chat-system-contract.md). Use that document as the acceptance criteria checklist for the chat/runtime stabilization work below.

Current status: Phase 0 has started.

Implemented slices:

- WebSocket liveness detection and reconnect on heartbeat timeout.
- Transient-session start-state snapshots for agent designer, workflow builder, and setup wizard.
- Shared terminal writability gating so modal terminal input is disabled until the transient session is ready.
- Orchestrator send-queue acknowledgement/drain hardening, including a small `orchestrator-send-queue-delivery` service boundary.
- WebSocket liveness diagnostics exposed through the status footer hover/data attributes.
- Orchestrator runtime snapshot composition extracted from `apps/server/src/index.ts` into `apps/server/src/services/orchestrator-runtime-snapshot.ts`, with refresh/reconnect tests for replay high-water, JSONL cursor, and queue state correctness.
- Runtime-host HTTP routes for session metadata, runtime snapshots, replay, terminal transcript, new/resume session, and send-queue retry/cancel extracted into `apps/server/src/features/runtime-host/routes.ts`.
- Runtime-host WebSocket connect replay and message handling extracted into `apps/server/src/features/runtime-host/websocket-connect.ts` and `websocket-message.ts`, with ordering and send/queue tests.
- Runtime-host orchestrator PTY handler orchestration extracted into `apps/server/src/features/runtime-host/pty-handlers.ts`, with focused tests for ready-state queue drain, JSONL replay metadata/cursor/queue confirmation, JSONL path persistence, and exit lifecycle broadcasts.
- Runtime-host WebSocket server setup shell extracted into `apps/server/src/features/runtime-host/websocket-server.ts`, with focused tests for connection rejection, connect snapshot ordering, message delegation, and subscriber detach.
- Transient-session start/send/interrupt/terminal-input/resize/stop routes for agent designer, workflow builder, and setup wizard extracted into `apps/server/src/features/transient-sessions/routes.ts`, with focused tests for shared wire envelopes, idempotent handler attachment, controls, and error responses.
- Project lifecycle/detail routes for list, create, reorder, metadata patch, soft-delete, scaffold cleanup, and reveal extracted into `apps/server/src/features/projects/routes.ts`, with focused tests for delegated create, registry side effects, deleted-row filesystem cleanup, and reveal behavior.
- Filesystem browse/probe and project file tree/preview routes extracted into `apps/server/src/features/files/routes.ts`, with focused tests for folder browsing, mkdir/probe envelopes, project tree filtering, preview classification, and validation/error shapes.
- Settings, Claude profile, preflight, installer, and onboarding auth routes extracted into `apps/server/src/features/settings-onboarding/routes.ts`, with focused tests for settings normalization, effective data-dir behavior, injected preflight/install/auth services, and envelope preservation.
- Work item CRUD, legacy move/update compatibility routes, agent-contract create/approve/reject routes, attachments, stages, and field schemas extracted into `apps/server/src/features/work-items/routes.ts`, with focused tests for legacy/paginated envelopes, versioned mutations, stage orphan handling, forced reassignment, attachment envelopes, and field-schema broadcasts.
- Agent run active-list/cancel, invoke, continue, by-dispatcher listing, and pending-ask create/answer/cancel routes extracted into `apps/server/src/features/agent-runs/routes.ts`, with focused tests for activity-panel envelopes, cancellation, dispatch validation/delegation, continuation ownership, list summaries, and pending-ask status mapping.
- MCP/tool catalog drift hardening: the pod allowlist drift test now covers every stock pod plus the orchestrator, `pc_node_failed` is re-registered, and the workflow/tool catalog entries needed by current pod allowlists are present.

## Executive Decision

Yes, refactor the app into clearer boundaries.

Do not rewrite the whole system top-to-bottom in one pass. The repo already has a strong macro-architecture: `domain`, `db`, `runtime`, `workflows`, `mcp`, `server`, `web`, and `desktop` are broadly layered in the right direction. The problem is not the package graph. The problem is that the integration surfaces have turned into god-files and duplicate protocol adapters, so every stability bug requires opening half the app.

The right move is:

1. Stabilize the known runtime failures with small, targeted fixes.
2. Split the high-churn integration files into feature cartridges.
3. Rebuild individual cartridges from first principles only after each has a hard boundary and a failure trace.

The rewrite impulse is correct about the pain, but the unit of rewrite should be "chat runtime cartridge", "transient modal session cartridge", "agent tools cartridge", etc., not "the whole product".

## Current Architecture

### What is already good

The monorepo shape is mostly right:

```text
packages/domain     pure contracts and shared types
packages/db         schema and repos
packages/runtime    PTY, JSONL tailing, send protocol, agent run state machines
packages/workflows  DAG validation/execution primitives
packages/mcp        PC MCP tool server
apps/server         composition root, HTTP routes, WS, service wiring
apps/web            React UI
apps/desktop        Electron wrapper
```

Useful existing seams:

- `packages/domain` has cohesive domain files per concept.
- `packages/db/src/repos/*` is already repo-per-entity.
- `apps/server/src/routes/pod-routes.ts`, `workflow-routes.ts`, and `quick-tasks-routes.ts` already use register-route modules with injected dependencies.
- `packages/runtime` contains valuable runtime primitives that should be preserved, not rewritten speculatively.
- Tests exist around runtime, DB repos, workflow DAG logic, agent runs, WebSocket hub, terminal mode, and route surfaces.

### Where boundaries are failing

Largest integration files, excluding `node_modules`:

| File | Lines | Boundary problem |
|---|---:|---|
| `apps/server/src/index.ts` | 4055 | Composition root, boot, settings/fs/projects routes, WS server, orchestrator runtime lifecycle, send queue, transient modal sessions, work item routes, workflow routes, agent routes, static serving. |
| `packages/mcp/src/server.ts` | 3655 | Tool definitions and every tool handler in one file. Tool catalog drift is visible. |
| `apps/web/src/components/ChatSurface.tsx` | 3415 | Rendering, event normalization, pending prompt UX, terminal mode, tool grouping, approval cards, composer, thinking state, and transcript surfaces in one component. |
| `apps/web/src/api/client.ts` | 1631 | Every HTTP client method and many duplicated wire/domain types in one file. |
| `apps/server/src/services/project-runtime.ts` | 1090 | Durable orchestrator sessions plus transient agent-designer/workflow-builder/setup-wizard sessions in one project runtime. |
| `apps/server/src/services/agent-run-factory.ts` | 878 | Agent dispatch construction, persistence, broadcast shape, verification, channel delivery, cleanup. |

These files are not just large; they cross feature boundaries. That is why chat, terminal, agents, workflows, and modal sessions feel coupled.

## Concrete Findings

### 1. Chat and WebSocket stability

Original evidence:

- `apps/web/src/hooks/use-project-ws.ts` reconnects only on browser `close` events. There is no ping/pong heartbeat or application-level "dead socket" detection.
- `apps/server/src/index.ts` creates the WebSocket server at `/ws` and does not install a heartbeat loop.
- `ProjectWebSocketHub` only checks `readyState === OPEN` at send time. That is not enough for half-open connections after sleep/wake, idle network drops, or proxy timeout.
- The client `send()` returns true after `ws.send()` succeeds locally. If the connection is half-open, the UI can believe a send happened while no server message is processed.

Phase 0 update:

- Implemented client heartbeat pings and server pong replies.
- Both active-project and all-project WebSocket hooks now close and reconnect when inbound traffic goes silent past the timeout.
- Remaining work is deeper observability: heartbeat/reconnect data is now visible in the status footer; next diagnostic layer should add explicit last replay high-water seq and last inbound envelope to a fuller debug panel.

Likely symptom match:

- "Websocket disconnects"
- "messages don't land"
- "app seems open but stale"
- "needs restart/refresh"

Important correction:

The existing chat path is not naive. It already has reconnect backoff, session replay, reducer-level sequence dedupe, send acknowledgements, and durable replay from JSONL. Do not throw that away. Add liveness detection first, then use traces to convict deeper issues.

Primary fix:

- Add server ping/client pong or client ping/server ack heartbeat. Done.
- Treat missed heartbeats as a hard close and reconnect. Done.
- Add visible runtime diagnostic fields: last inbound WS envelope, last heartbeat, reconnect count, last replay high-water seq. Heartbeat/reconnect basics are visible in the status footer; the fuller debug surface remains.

Secondary suspect:

- `deliverNextQueuedPromptOnce()` intentionally delivers one queued prompt per ready turn. The real bug risk was a race where the ready transition could arrive before JSONL confirmation cleared the previous delivered item. Phase 0 now retries delivery after JSONL confirmation if the runtime is already ready, and the behavior is covered by `apps/server/test/orchestrator-send-queue-delivery.test.ts`.

### 2. Terminal mode is wired as a debug write path, not a governed runtime surface

Evidence:

- `TerminalModePanel` writes raw xterm bytes through `onTerminalInput`.
- Server `forwardTerminalInput()` only checks that a live PTY exists and that input is under the byte limit.
- `PtySession.writeRaw()` writes to the child unless the state is `exited`.
- In `ChatSurface`, terminal writability is gated by `terminalActive && (wsStatus === undefined || wsStatus === 'open')`.
- Transient modal surfaces omit `wsStatus`, so `wsStatus === undefined` makes terminal mode writable regardless of transient session state.

Likely symptom match:

- "I see starting but I can interact with the thing in terminal"

Root issue:

Chat send and terminal raw input follow different state rules. Chat composer can be disabled during `spawning`, but terminal input remains writable as soon as a PTY object exists.

Primary fix:

- Add a runtime capability contract: `canAcceptChatInput`, `canAcceptTerminalInput`, `canResize`, `canInterrupt`, `stateLabel`.
- Feed both composer and xterm from that same contract.
- For transient sessions, default `canAcceptTerminalInput` to false until the current session reports `ready`. Initial modal gating is implemented through `terminalWritable`; the fuller named capability object is still future boundary work.

### 3. Transient modal sessions can miss the `ready` state

Affected surfaces:

- Agent designer modal
- Workflow builder modal
- Setup wizard modal, partially protected by its fallback state

Evidence:

- `ProjectRuntime.startAgentDesigner()` and `startWorkflowBuilder()` construct `PtySession`, which starts the child in the constructor.
- `PtySession` can emit `state: 'ready'` from raw banner detection during construction.
- The server attaches transient state handlers only after `startAgentDesigner()` / `startWorkflowBuilder()` returns.
- The start HTTP responses include `{ state: session.getState(), sessionId }`.
- `CreatePodModal` intentionally ignores the response state and relies on WebSocket envelopes.
- `WorkflowBuilderModal` also avoids setting state from the start response.
- `AgentDesignerChat` and `WorkflowBuilderChat` derive state only by scanning events. If the `ready` event fired before handlers attached, they can remain in `spawning`.

Likely symptom match:

- Modal header says "Starting..."
- Chat composer remains disabled
- Terminal mode is still interactive because a PTY exists

Primary fix:

- Centralize transient session handling.
- After handlers attach, immediately emit or return a canonical snapshot:
  - `type`
  - `sessionId`
  - `state`
  - `terminalReady`
  - `jsonlPath`
  - `startedAt`
- Use the start response as an initial snapshot in the modal state adapter.
- Stop duplicating the adapter logic across `AgentDesignerChat`, `WorkflowBuilderChat`, and `SetupWizardModal`.

### 4. Agent tools and tool catalogs are drifting

Evidence:

- `packages/mcp/src/server.ts` currently defines 55 `pc_*` tools in one `TOOLS` array.
- `packages/domain/src/tool-catalog.ts` has 47 `pc-rig` catalog entries.
- Static comparison shows these MCP tools missing from the domain catalog:
  - `mcp__pc-rig__pc_complete_node`
  - `mcp__pc-rig__pc_create_workflow`
  - `mcp__pc-rig__pc_delete_workflow`
  - `mcp__pc-rig__pc_fire_workflow`
  - `mcp__pc-rig__pc_get_workflow`
  - `mcp__pc-rig__pc_replace_field_schemas`
  - `mcp__pc-rig__pc_replace_stages`
  - `mcp__pc-rig__pc_update_workflow`
- Comments in `tool-catalog.ts` say some workflow tools were removed, but `packages/mcp/src/server.ts` still defines and handles them.
- `apps/server/test/pod-tool-catalog-drift.test.ts` expects the workspace-shaping tools to exist in pod allowlists.

Root issue:

There are multiple sources of truth for:

- Tool existence
- Tool descriptions
- Tool allowlists
- Which tools are deprecated
- Which tools are safe for which pod

Primary fix:

- Split MCP tools into modules by feature.
- Derive all user-facing tool catalogs from the actual MCP tool modules.
- Add a failing drift test: every `pc_*` tool must have catalog metadata or an explicit `hidden/deprecated/internal` flag.
- Add a tool lifecycle field: `active | deprecated | internal | removed`.

### 5. Agent run lifecycle is better than the UI makes it feel

Evidence:

- `packages/runtime/src/agent-run.ts` has a real state machine:
  `queued -> spawning -> running <-> paused -> completed | failed | cancelled`
- `apps/server/src/services/agent-run-factory.ts` persists transitions and broadcasts `agent-run-changed`.
- Activity panel filters active/terminal rows through `useProjectAgentRuns()`.
- `AgentTranscriptModal` only shows live JSONL events received after opening; it explicitly does not backfill prior events.

Likely user-facing gap:

The runtime may be doing the right thing while the UI lacks replay/backfill and unified diagnostics. A running agent can feel invisible or stuck if the modal opens late or misses state events.

Primary fix:

- Add `GET /api/projects/:projectId/agent-runs/:runId/events` backfill.
- Make transcript modal show:
  - persisted row status
  - live runtime status, if active
  - last JSONL event time
  - transcript path
  - failure cause
- Treat "no live transcript yet" differently from "agent has no events".

### 6. Web client API types drift from domain/server contracts

Evidence:

- `apps/web/src/api/client.ts` explicitly says it mirrors domain shapes inline.
- Some current web code imports `@pc/domain` directly, for example `WorkflowBuilderModal.tsx`.
- This means the old "browser bundle stays off @pc/domain" rule is not consistently enforced anymore.

Primary fix:

- Decide the contract strategy:
  - Either allow `apps/web` to import pure domain types from `@pc/domain`.
  - Or generate a `@pc/contracts` package with browser-safe types.
- Do not keep manually mirrored types as the long-term strategy.

## Refactor Strategy

### Principle

Separate before rebuilding.

Do not redesign behavior while moving files. First create boundaries around existing behavior. Then rebuild one cartridge at a time with tests and traces.

### Target Cartridge Shape

Each feature should own one entry point per layer:

```text
feature/<name>/
  domain contract       packages/domain or packages/contracts
  db repo               packages/db/src/repos/<name>.ts
  server routes         apps/server/src/features/<name>/routes.ts
  server service        apps/server/src/features/<name>/service.ts
  mcp tools             packages/mcp/src/tools/<name>.ts
  web client            apps/web/src/features/<name>/client.ts
  web hooks/state       apps/web/src/features/<name>/hooks/*
  web components        apps/web/src/features/<name>/components/*
```

Cross-feature calls should go through domain contracts or injected service interfaces. No feature should reach into another feature's private files.

## Work Plan

### Phase 0: Stabilize the bleeding paths

Do this before broad refactoring.

1. Add WS heartbeat/dead-socket detection.
2. Add a small runtime trace endpoint or debug log for:
   - WS connect/disconnect/reconnect
   - active session id
   - PTY state transitions
   - queue depth and send id
   - JSONL high-water seq
3. Fix transient modal state snapshots:
   - emit current state after handlers attach
   - use start-response state as initial state
   - gate terminal writability on the same state as composer
4. Add agent transcript backfill for running agent modals.

Definition of done:

- A laptop sleep/wake or local server restart does not leave the UI in a false-open state.
- "Starting..." cannot coexist with writable terminal input unless the UI explicitly labels it as raw boot terminal mode.
- Agent/workflow modal transcript opens with prior events, not just future events.

### Phase 1: Carve `apps/server/src/index.ts`

Create feature route modules following the existing `registerPodRoutes(app, deps)` pattern.

Extract in this order:

1. `features/runtime-host`
   - WebSocket setup
   - `ProjectWebSocketHub`
   - runtime lifecycle snapshot
   - send queue
   - orchestrator PTY handlers
2. `features/transient-sessions`
   - agent-designer start/send/interrupt/terminal-input/resize/stop
   - workflow-builder start/send/interrupt/terminal-input/resize/stop
   - setup-wizard start/send/interrupt/terminal-input/resize/stop
   - shared transient session adapter/snapshot contract
3. `features/projects`
   - project CRUD
   - project filesystem delete/reveal
4. `features/files`
   - browse/probe/tree/preview
5. `features/settings-onboarding`
   - settings
   - preflight
   - install/auth/onboarding
6. `features/work-items`
   - work item CRUD
   - stages
   - field schemas
   - attachments
7. `features/agent-runs`
   - invoke/continue/cancel
   - pending asks
   - active runs
   - transcript backfill

Definition of done:

- `index.ts` becomes boot/composition/static-serving only.
- Every route group has an injected dependency object.
- Unit tests can construct each route module without booting the entire app.

### Phase 2: Split MCP server by tool area

Target:

```text
packages/mcp/src/tools/
  work-items.ts
  workflows.ts
  agents.ts
  agent-runs.ts
  quick-tasks.ts
  worktrees.ts
  project-config.ts
  knowledge.ts
  index.ts
```

Each module exports:

```ts
export const tools = [...]
export async function handleTool(name, args, ctx) { ... }
```

The root MCP server only:

- Builds the MCP SDK server.
- Concatenates tool definitions.
- Dispatches handlers.
- Exports `PC_RIG_TOOL_NAMES`.

Definition of done:

- Tool metadata and handler live together.
- Domain/UI catalog derives from tool modules or a shared metadata object.
- Drift test fails when a public tool lacks catalog metadata.

### Phase 3: Split web API client and contracts

Target:

```text
apps/web/src/features/
  projects/client.ts
  runtime/client.ts
  transient-sessions/client.ts
  agents/client.ts
  agent-runs/client.ts
  workflows/client.ts
  work-items/client.ts
  settings/client.ts
```

Contract decision:

- Preferred: create `packages/contracts` or make `packages/domain` explicitly browser-safe and import types from there.
- Avoid long-term duplicate interfaces in `apps/web/src/api/client.ts`.

Definition of done:

- `client.ts` becomes a barrel or disappears.
- Each feature imports only its own client slice.
- Web/server type drift is tested.

### Phase 4: Decompose `ChatSurface`

Do this after Phases 0-3, because chat currently consumes every event shape.

Target modules:

```text
apps/web/src/features/chat/
  ChatSurface.tsx
  ChatTimeline.tsx
  ChatComposer.tsx
  TerminalPane.tsx
  usePendingPrompts.ts
  useChatRenderItems.ts
  normalizeJsonlEnvelope.ts
  toolGrouping.ts
  runtimeState.ts
  approvals.tsx
```

Rules:

- Rendering should not own transport state.
- Terminal pane should not bypass runtime capabilities.
- Pending prompt state should have tests.
- JSONL normalization should be pure and testable.

Definition of done:

- `ChatSurface` is a coordinator, not the implementation of every behavior.
- Agent designer/workflow builder/setup wizard can reuse chat without custom one-off adapters.

### Phase 5: Rebuild cartridges one at a time

Recommended order:

1. Chat/runtime/WebSocket cartridge
2. Transient modal sessions cartridge
3. Agent tools/catalog cartridge
4. Agent run audit/transcript cartridge
5. Workflow builder/visualizer cartridge
6. Work items/stages/field schemas cartridge

For each cartridge:

1. Capture one real trace of current behavior.
2. Write the ideal contract.
3. Port working internals.
4. Replace only the broken internals.
5. Add focused tests and one UI smoke where relevant.

## Boundary Enforcement

Add one of:

- `dependency-cruiser`
- `eslint-plugin-boundaries`
- TypeScript project references with explicit allowed imports

Suggested rules:

- `packages/domain` imports nothing from app packages.
- `packages/db` may import `domain` and `utils`, not server/web/runtime.
- `packages/runtime` may import `domain`, not server/web/db.
- `apps/server/features/*` can import services/contracts but not web files.
- `apps/web/features/*` cannot import server files.
- Feature internals should not cross-import each other except through public barrels.

## Testing Plan

Minimum tests to add before deeper refactors:

- WebSocket heartbeat reconnect test.
- Send queue drains multiple queued prompts without a second artificial `ready` transition.
- Transient modal start race test: start route returns `ready` before WS state event, UI still becomes ready.
- Terminal input gate test: transient terminal is not writable while state is `spawning`.
- Agent transcript backfill test.
- MCP catalog drift test for every public `pc_*` tool.
- Contract drift test for web client/domain types or generated contracts.

## Immediate Next Actions

1. Implement Phase 0 heartbeat and transient modal state fixes. Done.
2. Split MCP tools into feature modules so tool definitions, handlers, catalog metadata, and lifecycle flags stay together.
3. Continue Phase 1 route extraction from `apps/server/src/index.ts`: remaining mixed utility/worktree/workflow-compat/statusline routes remain.
4. Only then start deeper chat UI decomposition.

## Non-Goals

- Do not replace `PtySession`, `InteractiveSession`, `JsonlTailer`, or `AgentRun` just because they are complex. They contain hard-won behavior and tests.
- Do not redesign workflow semantics during the boundary pass.
- Do not add a second event protocol for each modal. Standardize the transient session snapshot instead.
- Do not keep manually mirrored client/domain types indefinitely.

## Bottom Line

Refactor is justified. A total rewrite is not.

The architecture wants clearer feature cartridges around the runtime and agent/workflow surfaces. The highest-value first step is not a new framework or clean-room rebuild; it is making runtime state truthful and observable, then moving the existing behavior behind boundaries that make future rebuilds local.
