# UI Realtime Investigation - 2026-05-30

Scope: how backend changes become visible in the React UI.

Commands were read-only except this document.

No servers were started, stopped, or restarted.

## Current Mechanism

The app has one active project websocket:

```text
React App
  -> useProjectWs(activeProject)
  -> ws://host/ws?projectId=<projectId>
  -> ProjectWebSocketHub.subscribe(projectId, socket)
```

Server setup:

- `apps/server/src/index.ts` creates `ProjectWebSocketHub`.
- `broadcastTo(projectId, msg)` sends an in-memory best-effort envelope to current subscribers.
- `broadcastAll(msg)` sends to every current subscriber.
- `registerRuntimeHostWebSocketServer()` owns `/ws`.

Connect snapshot:

```text
/ws connect
  -> session-changed
  -> state, if a live PTY exists
  -> runtime-state
  -> session-replay
  -> send-queue-snapshot
  -> start orchestrator PTY in background
```

The connect snapshot is strong for chat/runtime only.

It does not include agent runs, workflow rows, workflow runs, pods, work items, settings, statusline, or project context.

Backend producers:

- Orchestrator PTY emits `raw`, `state`, `event`, `jsonl`, `turn-end`, `exit`, and `runtime-state`.
- Agent runs emit `agent-run-changed` and `agent-jsonl-event`.
- Workflow CRUD emits `workflow-changed`.
- Workflow execution emits `workflow-v2-run-changed`, `workflow-v2-review-pending`, and `workflow-v2-human-hold`.
- Work items emit `work-items-changed`.
- Field schemas/stages/statusline/project context emit their own one-off envelopes.

Frontend routing:

```text
useProjectWs()
  -> parses envelopes
  -> feeds chat-session-reducer
  -> materialized `events`
  -> Shell
  -> Orchestrator, ActivityPanel, WorkflowsList, AgentsList, WorkItems
```

Important: `events` is not a neutral event bus. It is the materialized output of the chat-session reducer.

Feature hooks then maintain local resource caches:

- `useProjectAgentRuns()` fetches active agent runs once per project, then applies `agent-run-changed`.
- `useProjectWorkflowV2Runs()` fetches workflow runs once per project, then applies `workflow-v2-run-changed`.
- `useProjectWorkflows()` fetches workflow rows once per project, then applies `workflow-changed`.
- `useProjectPods()` fetches pods once per project, then applies `pod-changed`.

## What Is Solid

Chat/runtime is the most mature path:

- Browser heartbeat and reconnect exist.
- Server websocket ping/pong sweep exists.
- Orchestrator JSONL events are persisted before broadcast.
- Reconnect sends a replay checkpoint with sequence numbers.
- The reducer dedupes sequenced chat events.

This explains why chat is closer to correct than the activity/workflow surfaces.

## Gaps Causing Stale UI

### 1. Non-chat events are best-effort only

Most non-chat backend changes are only in-memory broadcasts.

If the socket is closed, stale, reconnecting, or the relevant UI hook is not mounted, the event is gone.

There is no durable outbox, event cursor, or replay for:

- `agent-run-changed`
- `workflow-changed`
- `workflow-v2-run-changed`
- `work-items-changed`
- `pod-changed`
- `field-schemas-changed`
- `stages-changed`
- `statusline-snapshot`

Force refresh fixes this because every feature hook re-runs its HTTP list query.

### 2. Reconnect does not resync resource lists

On reconnect, the server sends chat/runtime replay only.

Frontend resource hooks do not refetch when websocket status changes from closed/connecting back to open.

So a missed activity/workflow/agent event remains missed until:

- another matching event happens later;
- the user switches project/tab in a way that remounts the hook;
- the user force-refreshes.

This directly matches the reported symptom.

### 3. Workflow run creation is not broadcast immediately

`fireDagWorkflow()` creates the `workflow_runs_v2` row and marks it started.

The first `workflow-v2-run-changed` broadcast happens later inside DAG executor `persist()`.

For a workflow whose first node is a long agent task, the Activity Panel may show nothing while the run is already in the DB.

Force refresh shows it because `GET /workflow-v2/runs` reads the DB row.

### 4. Workflow run refetch-on-unknown is unreliable

`useProjectWorkflowV2Runs()` intends to refetch when it sees a `workflow-v2-run-changed` for an unknown run id.

The `needsRefetch` flag is mutated inside the React state updater and read immediately afterward.

That updater is not a safe place to drive side effects.

Result: unknown-run refetch can be skipped.

`useResourceList()` has the same pattern for `sawUnknown`.

### 5. Agent activity has no reconnect checkpoint

Agent dispatch broadcasts an initial `queued` envelope and later lifecycle updates.

The Activity Panel does an HTTP active-run fetch once per project.

If the initial fetch happens before the run starts, and the `queued` envelope is missed, the run will not appear until another lifecycle envelope arrives or the page refreshes.

Terminal agent updates can also be missed, leaving stale cards.

### 6. Global broadcasts are not durable

`broadcastAll()` sends only to sockets that are currently connected.

Global pod/workflow changes are lost if no project socket is active, or if a socket reconnects after the event.

There is also no true app-level websocket subscription in use; `useAllProjectsWs()` exists but is not wired into `App`.

### 7. Feature state is coupled to the chat event buffer

Non-chat UI state depends on the same `events` list used to render chat.

That buffer has chat-specific reset, replay, preservation, and trimming behavior.

This is risky because product resources and chat transcript are different kinds of state.

### 8. Some consumers still inspect only the last event

`AgentsList` detail bundle refresh checks only `events[events.length - 1]`.

If a matching `pod-changed` event is followed by any other envelope in the same render batch, the bundle refresh is missed.

This is an older anti-pattern that was fixed in some hooks but not everywhere.

### 9. Transient session events are not replayable

Agent designer, workflow builder, and setup wizard use project WS envelopes but have no durable event replay comparable to orchestrator chat.

If their modal misses events, refresh/reopen cannot reconstruct the conversation from a canonical source.

## Root Cause

The websocket is currently doing two jobs:

1. Chat/runtime transport with partial durable replay.
2. Generic product invalidation bus with no durable replay.

The first job is relatively well engineered.

The second job is best-effort fanout plus local React caches.

That architectural split is why chat sometimes recovers while activity/workflow surfaces require a forced refresh.

## First-Principles Target

The websocket should not be the source of truth.

The database plus an append-only live event/outbox log should be the source of truth.

Every mutation should follow one pattern:

```text
command
  -> validate shared contract
  -> app service
  -> DB transaction
  -> write outbox event in the same transaction
  -> return HTTP result
  -> fan out outbox event to websocket subscribers
```

Every live event should have one envelope:

```ts
interface LiveEvent<T> {
  id: string;
  cursor: string;
  projectId: string | null;
  scope: 'project' | 'global';
  topic: string;
  entity: string;
  entityId: string | null;
  version: number | null;
  kind: string;
  createdAt: number;
  payload: T;
}
```

Every websocket connection should be resumable:

```text
client connects with lastSeenCursor
  -> server sends missed outbox events after cursor
  -> server sends topic snapshots if cursor is absent/expired
  -> client applies events or refetches by topic
```

Every feature should declare its sync contract:

```text
topic: agent-runs
snapshot: GET /api/projects/:id/agent-runs?active=1
events:
  - agent-run.upsert
  - agent-run.delete/archive
client strategy:
  - patch by id when event has full snapshot
  - refetch topic when event is partial or cursor gap detected
```

Chat can keep its specialized JSONL replay, but it should sit under the same outer live envelope and cursor model.

## Target UI Model

Use one live connection manager, not many ad hoc hooks:

```text
LiveConnectionProvider
  -> owns ws status, cursor, reconnect, gap detection
  -> exposes event stream and topic invalidations

Feature stores/hooks
  -> initial HTTP snapshot
  -> subscribe(topic)
  -> apply typed event or refetch
```

Rules:

- Components do not parse raw WS envelopes.
- Feature hooks own resource sync.
- Chat transcript state and resource-list state are separate.
- Reconnect always triggers either cursor catch-up or topic refetch.
- Partial events are invalidations, not fake snapshots.
- Unknown ids trigger refetch outside React state updaters.

## Target Server Model

Introduce a live-event service:

```text
LiveEventService.publish(event)
  -> validates envelope
  -> writes outbox row
  -> sends to project/global subscribers
```

Routes, MCP tools, runtime services, workflow executor, and agent lifecycle all call application services that publish through the same live-event service.

The websocket server should only:

- authenticate/identify the client;
- register subscriptions;
- replay from cursor;
- send snapshots when needed;
- maintain liveness.

It should not encode product-specific sync rules.

## Concrete Near-Term Fixes

Do these before any full rewrite:

1. Add reconnect refetch for non-chat resource hooks.
2. Broadcast `workflow-v2-run-changed` immediately after `createRun()` / `markStarted()`.
3. Move unknown-id refetch decisions outside React state updater callbacks.
4. Replace last-event consumers with scan-new-events consumers.
5. Add a websocket reconnect integration test for Activity Panel agent runs and workflow runs.
6. Add a `live-sync` debug panel: ws status, cursor, last event, missed/gap count, per-topic last refetch.
7. Define the canonical live envelope and start with non-runtime topics.

## Migration Shape

Do not rewrite runtime first.

Order:

1. Stabilize resource refetch on reconnect.
2. Normalize workflow-run and agent-run broadcasts.
3. Add durable outbox for non-chat product events.
4. Move feature hooks onto topic subscriptions.
5. Fold chat replay into the shared cursor shell without removing JSONL persistence.
6. Only then split/rework runtime internals.

## Open Questions

- Should global events use a separate app-level subscription, or should every project socket subscribe to global topics by default?
- How long should the outbox retain events before clients must fall back to snapshots?
- Which topics need full snapshots on connect: agent runs, workflow runs, workflow rows, pods, work items, statusline?
- Should transient sessions become durable conversations, or remain explicitly ephemeral with clear UI language?
