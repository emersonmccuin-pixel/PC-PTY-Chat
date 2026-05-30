# Chat Runtime and Transcript UI Architecture Handoff

## 1. Executive Summary

- **Subsystem:** Chat runtime and transcript UI.
- **What it does:** Provides the primary orchestrator chat surface, per-session transcript replay, queued prompt delivery, ask/approval UI, terminal fallback mode, and adjacent transcript viewers for agent/subagent runs.
- **Why it matters:** Chat is the main user-facing runtime surface. If it loses events, duplicates rows, sends to the wrong session, or misreports runtime state, every higher-level subsystem appears unreliable.
- **Current health:** Functional but high risk. The current system has many good pieces: durable `orchestrator_sessions`, a DB-backed send queue, per-session JSONL replay files, reconnect snapshots, and a renderer reducer keyed by session sequence. The risk is boundary sprawl: runtime process lifecycle, transcript persistence, websocket projection, UI render policy, pending asks, terminal mode, and agent transcript behavior are split across several local contracts.
- **High-level recommendation:** Treat chat as a projection over durable runtime/session facts, not as a source of truth. Keep the JSONL tailer and send queue ideas, but move contracts, append-only transcript storage, live envelope shape, pending asks, and runtime commands behind explicit services before splitting the deepest runtime code.

## 2. Baseline

| Field | Value |
|---|---|
| Date | 2026-05-30 |
| Branch | `dev` |
| Commit | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` |
| Codebase state | Current working tree only. The tree was already dirty before this analysis, with many deleted legacy docs/tests and untracked `refactor plan/`. |
| Current implementation truth | Code under `apps/`, `packages/`, `channel-server/`, root config, and current refactor planning docs. |
| Assumed implemented recommendations from other docs | None. No prior subsystem handoff doc exists except `refactor plan/refactor plan docs/README.md`. |
| Excluded paths | `archive/` ignored entirely. |

## 3. Scope and Non-Goals

Included:

- Orchestrator chat session lifecycle.
- Runtime websocket events used by chat.
- Per-session replay and past-session view.
- Chat event normalization and render grouping.
- Composer send, queued sends, pending prompt optimism, interruption.
- Ask intercept UI path for `AskUserQuestion` and related tool prompts.
- Terminal fallback mode as part of the chat surface.
- Agent/subagent transcript viewers as adjacent transcript UI patterns.

Out of scope except as integrations:

- Full agent run lifecycle and verification.
- Workflow DAG execution semantics.
- Channel server replacement design.
- Desktop shell startup and process supervision.
- Project/work item/product rules not directly exercised by chat.

Do not change casually:

- The one-active-orchestrator-session-per-project invariant.
- The no-auto-spawn-on-websocket-connect behavior.
- The `session-changed` versus `session-title-updated` distinction.
- The fallback terminal mode; it is the escape hatch when structured chat is blocked.
- Existing session replay compatibility for `jsonl-events.jsonl` and legacy `events.jsonl`.

## 4. Current System Trace

### Startup and composition

Verified:

- `apps/server/src/index.ts` constructs a process-wide `ProjectWebSocketHub`, `OrchestratorRuntimeSnapshots`, and runtime-host PTY controller before route registration (`apps/server/src/index.ts:192`, `apps/server/src/index.ts:206`).
- Runtime routes are registered through `registerRuntimeHostRoutes` (`apps/server/src/index.ts:670`).
- The project websocket server is registered on `/ws` through `registerRuntimeHostWebSocketServer` (`apps/server/src/index.ts:790`).
- Chat bridge routes register the in-memory ask store, subagent transcript route, and channel-send proxy (`apps/server/src/features/chat-bridges/routes.ts:105`).

Startup flow:

```text
server boot
  -> project registry creates ProjectRuntime per project
  -> runtime host routes registered
  -> chat bridge routes registered
  -> project websocket server registered at /ws
  -> runtime snapshots kept in memory per project
```

### Websocket connect and reconnect

Verified:

- The active project hook opens `ws://.../ws?projectId=<id>&intent=chat` (`apps/web/src/hooks/use-project-ws.ts:115`).
- Server websocket connection requires `projectId` and derives `chatIntent` from `intent=chat` (`apps/server/src/features/runtime-host/websocket-server.ts:99`).
- Connect sends `session-changed`, optional PTY `state`, `runtime-state`, and if a session exists, `session-replay` plus `send-queue-snapshot` (`apps/server/src/features/runtime-host/websocket-connect.ts:35`, `apps/server/src/features/runtime-host/websocket-connect.ts:49`, `apps/server/src/features/runtime-host/websocket-connect.ts:64`).
- Connect does not mint or spawn a session by itself. It only attaches handlers if a live PTY already exists (`apps/server/src/features/runtime-host/websocket-connect.ts:51`).
- Browser reconnect uses exponential backoff, heartbeat pings, stale-socket detection, and bumps a websocket epoch so resource hooks refetch after a gap (`apps/web/src/hooks/use-project-ws.ts:135`, `apps/web/src/hooks/use-project-ws.ts:157`, `apps/web/src/hooks/use-project-ws.ts:262`).

Normal reconnect flow:

```text
browser websocket opens
  -> server subscribes socket to project hub
  -> server sends active session metadata
  -> server sends runtime snapshot
  -> server sends durable session replay checkpoint
  -> server sends visible send queue snapshot
  -> client reducer replaces sequenced transcript state from replay
```

Failure flow:

- If the socket drops, `useProjectWs` schedules reconnect and marks status `closed` (`apps/web/src/hooks/use-project-ws.ts:135`).
- If heartbeat times out, the client closes and reconnects (`apps/web/src/hooks/use-project-ws.ts:151`).
- The websocket hub itself is in memory and does not replay missed non-session events (`apps/server/src/services/websocket-hub.ts:38`).

### Session lifecycle

Verified endpoints:

| Endpoint | Purpose | Source |
|---|---|---|
| `GET /api/projects/:projectId/session` | Active orchestrator session row | `apps/server/src/features/runtime-host/routes.ts:93` |
| `GET /api/projects/:projectId/orchestrator/runtime` | No-spawn runtime snapshot | `apps/server/src/features/runtime-host/routes.ts:104` |
| `GET /api/projects/:projectId/sessions` | Session history | `apps/server/src/features/runtime-host/routes.ts:135` |
| `GET /api/projects/:projectId/sessions/:sessionId/events` | Past-session replay | `apps/server/src/features/runtime-host/routes.ts:145` |
| `POST /api/projects/:projectId/sessions/new` | End active, create fresh, broadcast replay, spawn in background | `apps/server/src/features/runtime-host/routes.ts:185` |
| `POST /api/projects/:projectId/sessions/:targetId/resume` | Reactivate past row, replay, spawn in background | `apps/server/src/features/runtime-host/routes.ts:212` |
| `POST /api/projects/:projectId/sessions/close` | End active, kill PTY, show launcher | `apps/server/src/features/runtime-host/routes.ts:246` |

Verified runtime methods:

- `ProjectRuntime.sessionDataPath(sessionId)` maps session state to `<data>/projects/<projectId>/sessions/<sessionId>` (`apps/server/src/services/project-runtime.ts:144`).
- `ProjectRuntime.ensureActiveSession()` creates a durable DB row without spawning Claude (`apps/server/src/services/project-runtime.ts:608`).
- `ProjectRuntime.startNewSession()`, `resumeSession()`, and `closeSession()` own the durable session row and PTY cache transitions (`apps/server/src/services/project-runtime.ts:623`, `apps/server/src/services/project-runtime.ts:652`, `apps/server/src/services/project-runtime.ts:685`).
- `orchestrator_sessions` enforces one active session per project (`packages/db/src/schema.ts:376`, `packages/db/src/schema.ts:405`).

Normal lifecycle:

```text
Start Chat / + New session
  -> POST /sessions/new
  -> end previous active row and cancel open sends
  -> create new orchestrator_sessions row
  -> broadcast session-changed(new-session)
  -> broadcast empty session-replay
  -> broadcast send-queue-snapshot
  -> start PTY in background
```

```text
Resume
  -> POST /sessions/:targetId/resume
  -> reactivate target row
  -> end previous active row if different
  -> broadcast session-changed(resume-session)
  -> broadcast replay checkpoint
  -> start PTY in background with resume-or-fresh provider decision
```

### Runtime process and JSONL tail

Verified:

- `ProjectRuntime.ensurePty()` prepares the orchestrator pod, selects/mints provider session identity, creates an `InteractiveSession`, and passes `transcript.log` plus `jsonl-events.jsonl` paths (`apps/server/src/services/project-runtime.ts:433`, `apps/server/src/services/project-runtime.ts:485`, `apps/server/src/services/project-runtime.ts:506`).
- `resolveSessionForSpawn()` resumes only if the expected provider JSONL exists; otherwise it mints or reuses the recorded provider id as a fresh session target (`apps/server/src/services/project-runtime.ts:1058`).
- `InteractiveSession` wraps the long-running process state machine (`packages/runtime/src/interactive-session.ts:107`).
- `InteractiveSession.send()` moves `ready -> busy` when send succeeds (`packages/runtime/src/interactive-session.ts:157`).
- `InteractiveSession.onJsonlEvent()` persists the normalized event and returns to ready on `jsonl-turn-end` (`packages/runtime/src/interactive-session.ts:374`).
- `InteractiveSession.persistJsonlEvent()` appends `{ type: 'jsonl', event, seq, source }` rows to `jsonl-events.jsonl` (`packages/runtime/src/interactive-session.ts:440`).
- `JsonlTailer` emits typed canonical JSONL events from Claude's provider JSONL file (`packages/runtime/src/jsonl-tailer.ts:202`, `packages/runtime/src/jsonl-tailer.ts:248`, `packages/runtime/src/jsonl-tailer.ts:291`).

Runtime event flow:

```text
Claude provider JSONL line
  -> JsonlTailer typed JsonlEvent
  -> InteractiveSession persists row to jsonl-events.jsonl
  -> InteractiveSession emits jsonl-event with replay metadata
  -> runtime-host PTY handler updates cursor and broadcasts type=jsonl
  -> web reducer stores sequenced envelope
  -> chat renderer converts to render items
```

### PTY handlers and live broadcasts

Verified:

- `attachPtyHandlers()` registers raw, state, turn-end, legacy event, jsonl-event, jsonl-path, cursor, and exit handlers once per session wrapper (`apps/server/src/features/runtime-host/pty-handlers.ts:108`).
- Raw bytes broadcast as `{ type: 'raw', sessionId, terminalSeq, text }` (`apps/server/src/features/runtime-host/pty-handlers.ts:113`).
- State broadcasts as `{ type: 'state', state }` and triggers runtime snapshot broadcast (`apps/server/src/features/runtime-host/pty-handlers.ts:123`).
- JSONL events broadcast as `{ type: 'jsonl', event, ...replayMeta, clientMessageId? }` after send-queue correlation (`apps/server/src/features/runtime-host/pty-handlers.ts:153`).
- JSONL path and cursor are persisted to the active session row (`apps/server/src/features/runtime-host/pty-handlers.ts:181`, `apps/server/src/features/runtime-host/pty-handlers.ts:189`).
- Exit broadcasts `{ type: 'exit', code, signal }` and runtime snapshot (`apps/server/src/features/runtime-host/pty-handlers.ts:191`).

### Send and queued prompt delivery

Verified:

- Web composer sends websocket `{ type: 'send', text, clientMessageId }` from `Orchestrator` (`apps/web/src/components/Orchestrator.tsx:740`).
- Server handles outbound websocket messages in `handleRuntimeHostWsMessage()` (`apps/server/src/features/runtime-host/websocket-message.ts:67`).
- Prompt sends ensure an active session row, ensure or start a PTY, then either enqueue or send directly (`apps/server/src/features/runtime-host/websocket-message.ts:161`).
- Non-ready runtime states enqueue to `orchestrator_send_queue` (`apps/server/src/features/runtime-host/websocket-message.ts:228`).
- Direct sends are recorded as `delivered_to_pty` (`apps/server/src/features/runtime-host/websocket-message.ts:263`).
- The send queue table has a unique `(session_id, client_message_id)` constraint and status index (`packages/db/src/schema.ts:411`, `packages/db/src/schema.ts:444`).
- `maybeAdvanceSendQueueConfirmation()` marks the first matching delivered send as `observed_in_jsonl` when a `jsonl-user` event appears (`apps/server/src/services/orchestrator-send-queue-delivery.ts:133`).
- Client pending prompts reconcile by `send-ack`, `send-queue-snapshot`, stamped `clientMessageId`, and fallback text matching (`apps/web/src/features/chat/usePendingPrompts.ts:36`, `apps/web/src/features/chat/usePendingPrompts.ts:141`, `apps/web/src/features/chat/usePendingPrompts.ts:169`).

Send flow:

```text
Composer submit
  -> client creates clientMessageId and optimistic pending user row
  -> websocket send
  -> server ensures active session and PTY
  -> if ready: PTY send, DB row delivered_to_pty, send-ack received
  -> if busy/spawning/backlog: DB row queued_*, send-ack queued
  -> JSONL tail sees user row
  -> server marks matching send observed_in_jsonl
  -> broadcast jsonl with clientMessageId when matched
  -> client removes optimistic pending row
```

### Replay and past-session UI

Verified:

- `loadSessionReplayCheckpoint()` prefers per-session `jsonl-events.jsonl` and falls back to legacy `events.jsonl` (`apps/server/src/services/session-replay.ts:141`).
- Replay rows are normalized into `ReplayEnvelope` with `seq`, `sessionId`, `kind`, and `source` (`apps/server/src/services/session-replay.ts:21`, `apps/server/src/services/session-replay.ts:93`).
- `useProjectWs` dispatches `session-replay` to `chatSessionReducer` on connect/reconnect (`apps/web/src/hooks/use-project-ws.ts:247`).
- `chatSessionReducer.applySnapshot()` replaces sequenced rows from replay and preserves allowed unsequenced state (`apps/web/src/hooks/chat-session-reducer.ts:153`).
- `Orchestrator` fetches past session events through `runtimeApi.getSessionEvents()` when `viewingSessionId` is set (`apps/web/src/components/Orchestrator.tsx:222`, `apps/web/src/components/Orchestrator.tsx:240`).

### Chat rendering

Verified:

- `ChatSurface` owns render coordination and delegates lifecycle to wrappers (`apps/web/src/features/chat/ChatSurface.tsx:25`).
- `useChatRenderItems()` supports canonical JSONL mode and a frozen legacy path (`apps/web/src/features/chat/useChatRenderItems.ts:51`, `apps/web/src/features/chat/useChatRenderItems.ts:99`, `apps/web/src/features/chat/useChatRenderItems.ts:124`).
- JSONL rows are converted to legacy chat `event` shapes by `normalizeJsonlEnvelope()` (`apps/web/src/features/chat/normalizeJsonlEnvelope.ts:106`).
- Row visibility policy exists in `@pc/runtime/chat-policy` (`packages/runtime/src/chat-policy.ts:52`).
- Tool grouping still carries a local `SUPPRESSED_TOOLS` set separate from `INTERNAL_TOOLS` in chat policy (`apps/web/src/features/chat/toolGrouping.ts:14`, `packages/runtime/src/chat-policy.ts:36`).
- `ChatTimelineRenderer` renders ask cards, tool groups, workflow/agent groups, sidechain groups, event bubbles, and pending-user status (`apps/web/src/features/chat/useChatTimelineRenderer.tsx:30`).

Render flow:

```text
WsEnvelope[]
  -> chatSessionReducer orders/dedupes replay/live rows
  -> useChatRenderItems filters jsonl/ask rows
  -> rowPolicy decides hidden/collapsed/shown
  -> normalizeJsonlEnvelope converts JSONL to ChatEvent shapes
  -> synthesizeRenderItems groups tools/sidechains/workflow/agent events
  -> ChatTimeline renders cards/bubbles
```

### Ask intercept and pending asks

Verified:

- Hook script `ask-intercept.cjs` exits unless `PC_SESSION_ID` is set, then posts to `/api/ask` and blocks for an answer (`packages/runtime/src/hook-scripts/ask-intercept.cjs:12`, `packages/runtime/src/hook-scripts/ask-intercept.cjs:39`, `packages/runtime/src/hook-scripts/ask-intercept.cjs:45`).
- Server `POST /api/ask` broadcasts `{ type: 'ask', sessionId, toolName, toolUseId, toolInput }`, stores a resolver in an in-memory `PendingAskStore`, and returns after answer or timeout (`apps/server/src/features/chat-bridges/routes.ts:122`, `apps/server/src/features/chat-bridges/routes.ts:139`).
- Web replies through websocket `{ type: 'ask-reply', toolUseId, answer }` (`apps/web/src/components/Orchestrator.tsx:749`).
- Server resolves pending asks in websocket message handling (`apps/server/src/features/runtime-host/websocket-message.ts:152`, `apps/server/src/index.ts:801`).

### Terminal fallback mode

Verified:

- Terminal mode reads a bounded tail of `transcript.log` through `GET /sessions/:sessionId/terminal-transcript` (`apps/server/src/features/runtime-host/routes.ts:161`).
- `readTerminalTranscriptTail()` path-guards the transcript under the project session data root (`apps/server/src/services/terminal-mode.ts:72`).
- Live raw bytes are consumed from `raw` websocket envelopes by `TerminalModePanel` (`apps/web/src/components/TerminalModePanel.tsx:175`, `apps/web/src/components/TerminalModePanel.tsx:216`).
- Terminal input bypasses chat send queue through websocket `{ type: 'terminal-input', data }` and `writeRaw()` (`apps/server/src/features/runtime-host/websocket-message.ts:125`, `apps/server/src/services/terminal-mode.ts:43`).

### Agent and subagent transcript UI

Verified:

- Agent transcript modal backfills via `GET /api/projects/:projectId/agent-runs/:runId/events` and appends `agent-jsonl-event` websocket envelopes (`apps/web/src/components/AgentTranscriptModal.tsx:58`, `apps/web/src/features/agent-runs/transcript.ts:21`).
- Agent run events endpoint parses the provider JSONL directly with `AgentRunJsonlTailer` (`apps/server/src/features/agent-runs/routes.ts:82`, `apps/server/src/features/agent-runs/routes.ts:143`).
- Live agent JSONL events broadcast separately as `{ type: 'agent-jsonl-event', runId, event }` (`apps/server/src/services/agent-run-factory.ts:1018`).
- `TranscriptViewer` fetches `/api/subagent-transcript?path=...` directly, not through a feature client (`apps/web/src/components/TranscriptViewer.tsx:35`).

## 5. Integration Map

### Inbound integrations

| Caller | Contract | Current behavior | Failure boundary |
|---|---|---|---|
| `Orchestrator` UI | `runtimeApi`, `/ws`, `ChatSurfaceProps` | Starts/resumes/closes sessions, sends messages, renders events | HTTP errors shown or logged; websocket reconnect best effort |
| `SessionSwitcher` / `SessionsRail` | `runtimeApi.listSessions`, viewing-session store | Lists and selects sessions for read-only view/resume | Refetch required after missed metadata event |
| Claude hook scripts | `/api/ask`, `events.jsonl` writes | Blocks tool call for user answer, writes legacy hook events | Ask store is in memory; hook waits up to timeout |
| Runtime process wrapper | `InteractiveSession` events | Emits raw/state/jsonl/exit to server | Handler broadcasts best effort |
| Agent run system | `agent-jsonl-event` and events endpoint | Supplies separate transcript surface | Separate event contract and no chat replay sequence |
| Terminal mode | raw websocket and terminal transcript endpoint | xterm fallback input/output | Raw event delivery is live only; tail file is source for initial terminal view |

### Outbound integrations

| Target | Caller | Side effect |
|---|---|---|
| SQLite `orchestrator_sessions` | `ProjectRuntime`, runtime handlers | Create/end/reactivate session, title, JSONL path/cursor |
| SQLite `orchestrator_send_queue` | websocket message and queue delivery services | Durable queued prompts, delivery attempts, confirmation state |
| Filesystem session dir | runtime wrappers | `transcript.log`, `jsonl-events.jsonl`, legacy `events.jsonl`, hook debug/stop markers |
| Websocket hub | route services/runtime handlers | Broadcasts chat/runtime/agent/workflow/project events |
| Pod materialization | `ProjectRuntime.ensurePty()` | Session-local orchestrator plugin/settings/MCP config |
| Post-turn summaries table | `maybePersistPostTurnSummary()` | Stores `jsonl-post-turn-summary` rows (`apps/server/src/index.ts:551`) |
| Runtime snapshots | `OrchestratorRuntimeSnapshots` | In-memory lifecycle state projected to UI |

Tight coupling and hidden dependencies:

- `ProjectRuntime` owns chat session spawn, transient sessions, workflow DAG deps, work items, attachments, field schemas, worktrees, hooks, and pod materialization (`apps/server/src/services/project-runtime.ts:91`).
- Renderer event types are mirrored manually in `apps/web/src/features/runtime/ws-types.ts` instead of imported from a shared contract.
- Chat renderer converts canonical JSONL back into legacy hook-shaped `event` rows, so the UI contract is not yet the same as the durable transcript contract.
- `/api/ask` depends on an in-memory resolver surviving until the user answers.
- Agent transcript UI uses a different event envelope and replay strategy from orchestrator chat.

## 6. Data and State Model

### Durable state

| State | Storage | Owner today | Notes |
|---|---|---|---|
| Orchestrator session metadata | SQLite `orchestrator_sessions` | DB repo and `ProjectRuntime` | One active row per project; stores provider id, title, status, JSONL path/cursor |
| Prompt send queue | SQLite `orchestrator_send_queue` | DB repo and send queue delivery service | Durable client message ids and delivery state |
| Normalized chat replay | Filesystem `sessions/<id>/jsonl-events.jsonl` | `InteractiveSession` | Append-only replay rows with seq; not SQLite |
| Raw terminal transcript | Filesystem `sessions/<id>/transcript.log` | Low-level runtime | Bounded tail read for terminal mode |
| Legacy hook events | Filesystem `sessions/<id>/events.jsonl` | hook script / legacy runtime | Replay fallback for pre-cutover sessions and some legacy events |
| Post-turn summaries | SQLite `post_turn_summaries` | `maybePersistPostTurnSummary()` | Derived from JSONL events |

### In-memory state

| State | Owner | Risk |
|---|---|---|
| Live PTY handles | `ProjectRuntime` | Lost on server restart, rebuilt by session row + provider JSONL |
| Websocket subscribers | `ProjectWebSocketHub` | No durable replay for non-session events |
| Runtime lifecycle snapshot | `OrchestratorRuntimeSnapshots` | Resets on server restart; partially reconstructed from files/session row |
| Pending asks | `InMemoryPendingAskStore` | Lost on server restart; blocked hook gets timeout/error |
| Chat open/viewing/session telemetry | Zustand stores | UI-only, acceptable except when mistaken for source truth |
| Pending prompts and send batches | React/Zustand | Optimistic UI; pending unsent batch not persisted |
| Chat reducer event buffer | `chatSessionReducer` | Bounded to 10k timeline entries and 2k raw entries |

### State ownership conclusion

Verified:

- Durable conversation identity is SQLite-backed.
- Durable transcript content is file-backed, not SQLite-backed.
- Live UI projection is websocket/in-memory with session replay catch-up for JSONL transcript rows only.

Recommendation:

- Introduce an explicit `conversation_events` or `runtime_events` append-only repository, or a compatibility repository that abstracts the existing file log first. The UI should consume one query/replay contract whether the backing store is file or SQLite during migration.

## 7. Invariants and Compatibility Requirements

- A project has at most one active orchestrator session row.
- Opening a project websocket must not auto-spawn Claude.
- Starting a new session must end the prior active row, cancel open sends, clear chat replay for the new session, and preserve old replay files.
- Resuming a session must preserve the PC session id, provider session id, title, and replay history.
- `session-changed` means a hard session checkpoint; chat buffers may reset.
- `session-title-updated` must not clear chat buffers.
- JSONL-derived transcript rows must remain replayable after browser reload, websocket reconnect, and server restart.
- Terminal mode must stay available as the recovery path when structured chat cannot progress.
- Sends must be idempotent by `(sessionId, clientMessageId)`.
- Queued sends must remain attached to the session they were created for.
- Ask cards must be scoped by `sessionId` so transient sessions and orchestrator asks do not bleed into each other.
- Legacy `events.jsonl` replay must remain readable until old sessions are migrated or intentionally abandoned.

## 8. Related Subsystem Docs

No completed related subsystem handoff docs exist yet. Related tracker items are still `not started`.

| Related subsystem | Current dependency verified in code | Recommendation in that doc | Assumed implemented? | Potential conflict | Coordination needed |
|---|---|---|---|---|---|
| WebSocket/event propagation | Chat uses `/ws`, `ProjectWebSocketHub`, `session-replay`, `runtime-state`, and direct broadcasts | Not available | No | Chat has its own replay semantics while other events are best-effort | Canonical live envelope and replay cursor design |
| Agents and agent runs | Agent transcript modal uses `agent-jsonl-event` and separate events endpoint | Not available | No | Agent transcript may need same transcript contract as chat | Decide whether agent transcripts share `conversation_events` |
| Workflows and workflow builder | Chat groups workflow events and transient workflow builder uses chat-like surfaces | Not available | No | Workflow review prompts can arrive through chat conventions | Coordinate review/approval event contracts |
| MCP and tooling | Orchestrator pod MCP config is materialized during chat spawn; MCP tools create chat-visible events | Not available | No | MCP may duplicate chat/runtime contracts | Shared command/query contracts |
| Channel server replacement | Channel-origin JSONL meta and agent inbox events surface in chat-adjacent flows | Not available | No | Mailbox may replace several ad hoc ask/channel flows | Durable mailbox versus chat pending asks |
| Runtime host and PTY sessions | Chat depends directly on `ProjectRuntime`, `InteractiveSession`, `JsonlTailer`, `LowLevelSpawn` | Not available | No | Runtime host split cannot break chat replay/send invariants | Split only after transcript/replay contract exists |

## 9. Current Issues

| Severity | Issue | Evidence | Impact | Likely root cause | Suggested fix direction |
|---|---|---|---|---|---|
| High | Runtime, product services, and chat lifecycle are concentrated in `ProjectRuntime`. | Fields/methods for PTY, transient sessions, worktrees, workflows, work items, attachments, field schemas, and hooks live together (`apps/server/src/services/project-runtime.ts:91`, `apps/server/src/services/project-runtime.ts:277`, `apps/server/src/services/project-runtime.ts:747`, `apps/server/src/services/project-runtime.ts:889`). | High blast radius for chat changes; hard to test process lifecycle without unrelated product dependencies. | `ProjectRuntime` evolved as a composition object and became a service locator. | Extract chat session/replay/send use cases behind narrow interfaces before splitting runtime internals. |
| High | Normalized transcript source is file-backed, not database/outbox-backed. | `InteractiveSession.persistJsonlEvent()` appends to `jsonl-events.jsonl` (`packages/runtime/src/interactive-session.ts:440`); replay reads that file (`apps/server/src/services/session-replay.ts:150`). | File log works, but target durable state wants SQLite/server-owned services; live outbox cannot replay all event types uniformly. | JSONL file was the fastest durable replay path during chat reliability work. | Add a transcript event repository abstraction, then move or mirror normalized events to SQLite with cursor/replay API. |
| High | Live websocket events are not one canonical resumable event family. | Hub directly sends to current subscribers (`apps/server/src/services/websocket-hub.ts:38`); `jsonl` has seq replay but `runtime-state`, `ask`, `agent-jsonl-event`, `raw`, and metadata do not share an envelope/cursor. | Reconnect recovery differs by event type; UI has ad hoc preservation rules. | Live event fanout predates target outbox envelope. | Define `LiveEvent<T>` envelope and outbox/replay behavior; migrate chat JSONL first because it already has sequence metadata. |
| High | Orchestrator asks are in-memory and blocking. | `InMemoryPendingAskStore` stores resolvers in a `Map` (`apps/server/src/features/chat-bridges/routes.ts:16`); `/api/ask` blocks on it (`apps/server/src/features/chat-bridges/routes.ts:139`). | Server restart or lost websocket can strand a tool prompt until timeout; asks are not auditable or recoverable. | Hook request/response path was optimized for synchronous Claude hook behavior. | Introduce durable pending interaction rows and use websocket as a nudge. Keep synchronous hook response by polling/waiting on durable state. |
| Medium | Canonical JSONL is converted back into legacy hook-shaped chat events. | `normalizeJsonlEnvelope()` maps `jsonl-*` to `event.kind` rows (`apps/web/src/features/chat/normalizeJsonlEnvelope.ts:106`); `useChatRenderItems()` still has canonical and legacy paths (`apps/web/src/features/chat/useChatRenderItems.ts:99`, `apps/web/src/features/chat/useChatRenderItems.ts:124`). | Renderer policy and durable transcript contract are different, increasing duplicate/drop risk. | Migration preserved legacy renderer as A/B baseline. | Finish policy-driven renderer over canonical JSONL rows; remove legacy path after characterization tests. |
| Medium | Tool suppression policy is duplicated. | `SUPPRESSED_TOOLS` in `toolGrouping.ts` and `INTERNAL_TOOLS` in `chat-policy.ts` (`apps/web/src/features/chat/toolGrouping.ts:14`, `packages/runtime/src/chat-policy.ts:36`). | Drift can hide or show different rows depending on render path. | Policy table was added before grouping cleanup finished. | Use `rowPolicy()` as the single suppression authority and delete grouping-local suppression. |
| Medium | Runtime/web/server contracts are hand mirrored. | Web `JsonlEvent`, `WsEnvelope`, runtime snapshot, and session DTOs live in `apps/web/src/features/runtime/ws-types.ts` and `types.ts`; runtime owns `JsonlEvent` in `packages/runtime/src/jsonl-tailer.ts`. | Type drift across server, web, and runtime is easy. | No `packages/contracts` yet. | Create shared browser-safe runtime/chat contracts and import them from server routes and web clients. |
| Medium | Send confirmation still has text/FIFO matching. | Server matching uses session id plus text (`packages/db/src/repos/orchestrator-send-queue.ts:235`); client still falls back to text matching (`apps/web/src/features/chat/usePendingPrompts.ts:36`). | Identical repeated prompts can confirm the wrong pending row in edge cases. | Provider JSONL lacks client id, so correlation is inferred after PTY delivery. | Preserve `clientMessageId` through a local command envelope or explicit client-origin event where possible; otherwise scope matching by delivered row id plus turn boundary. |
| Medium | Transcript UI has multiple incompatible replay contracts. | Orchestrator replay uses `session-replay`; terminal mode uses raw `transcript.log`; agent modal uses `agent-jsonl-event`; subagent viewer directly fetches `/api/subagent-transcript` (`apps/web/src/components/TerminalModePanel.tsx:175`, `apps/web/src/components/AgentTranscriptModal.tsx:58`, `apps/web/src/components/TranscriptViewer.tsx:35`). | Users see different fidelity and recovery behavior depending on transcript surface. | Each transcript surface was built for a local need. | Define transcript query/replay contracts by transcript kind: orchestrator, agent run, raw terminal, legacy provider JSONL. |
| Medium | Current working tree has no test files outside `archive/`. | `rg --files --glob '!archive/**' | rg '(^|[\\/])(test|tests)[\\/]|\\.test\\.'` returned no files; package scripts expose typecheck/build only. | Refactor risks are high without characterization tests. | Pre-existing workspace state deleted prior tests. | Reintroduce focused tests before implementation: reducer, replay, send queue, websocket connect, ask durability. |
| Low | `TranscriptViewer` bypasses feature-client discipline. | Direct `fetch('/api/subagent-transcript?...')` in component (`apps/web/src/components/TranscriptViewer.tsx:35`). | Harder to share error handling/types; minor compared with runtime risks. | Legacy/simple modal implementation. | Move to a transcript client/hook when transcript contracts are formalized. |

## 10. First-Principles Design

Ideal responsibilities:

- **Runtime host:** Owns PTY/process lifecycle, stdin/stdout/stderr, resize, provider JSONL tailing, raw transcript capture, and process health.
- **Conversation service:** Owns session identity, append-only normalized events, replay cursors, send queue commands, and user-visible runtime state snapshots.
- **Pending interaction service:** Owns asks/approvals that require a user answer, including timeout, cancellation, audit, and recovery.
- **Live service:** Owns canonical outbox envelope, websocket fanout, reconnect cursor, and replay.
- **Web chat feature:** Owns projection from conversation events to render items, composer state, and terminal fallback UI. It should not own backend paths or raw websocket decoding.
- **Transcript feature:** Provides consistent query/replay APIs for orchestrator, agent, subagent, and raw terminal transcripts.

Ideal command flow:

```text
submit chat prompt
  -> shared contract validation
  -> conversation service enqueue/send command
  -> DB transaction for send intent
  -> runtime host delivery if ready
  -> provider JSONL fact observed
  -> normalized event append
  -> live outbox event
  -> UI replaces optimistic row by id/cursor
```

Ideal replay flow:

```text
client connect with cursor
  -> live service replays outbox after cursor
  -> conversation service supplies transcript checkpoint if needed
  -> UI reducer applies typed events idempotently
```

Ideal data model:

- `orchestrator_sessions`: keep.
- `orchestrator_send_queue`: keep, but move behind app service.
- `conversation_events` or `runtime_events`: append-only normalized JSONL facts with session id, seq, provider cursor, kind, payload, createdAt.
- `runtime_snapshots`: optional latest materialized runtime state per session/project.
- `pending_interactions`: ask/approval rows with status, session id, tool use id, prompt payload, answer, timestamps.
- `live_outbox`: canonical event envelope for UI/MCP/mailbox nudges.

Fit into existing app:

- Do not replace `JsonlTailer` or `InteractiveSession` first. They already provide the right low-level facts.
- Introduce services around current file-backed replay before moving storage.
- Keep `jsonl-events.jsonl` compatibility until existing sessions can be replayed through the new repository.

## 11. Target Architecture Alignment

| Target cartridge layer | Current state | Gap |
|---|---|---|
| Contracts | Web/runtime/server types are manually mirrored | Needs shared `packages/contracts` runtime/chat schemas |
| Domain | Session and settings types exist in `@pc/domain` | Chat event policy is partly in runtime package, not a formal domain/contract layer |
| DB repo | `orchestrator_sessions`, `orchestrator_send_queue`, summaries exist | Transcript events and asks are not durable DB-backed |
| Application service | Send queue delivery exists; route handlers and `ProjectRuntime` still own use cases | Need `ConversationService`, `PendingInteractionService`, `RuntimeSessionService` boundaries |
| HTTP route | Runtime-host routes are grouped | Routes call repos/runtime directly; contracts local |
| Live events | Direct websocket broadcasts with some replay | No canonical envelope/outbox cursor |
| Web client/hooks | `runtimeApi`, `useProjectWs`, chat feature hooks exist | Web owns raw websocket decoding and many event shape decisions |
| MCP adapter | MCP affects chat via pod tools/channel/agent events | MCP not yet using shared chat/runtime contracts |
| Tests | No current test files visible | Need characterization and regression tests |

Cross-cutting target alignment:

- **Shared contracts:** Not aligned. Manual DTO/event duplication is widespread.
- **Canonical live events:** Partially aligned for `jsonl` replay, not aligned for other live events.
- **Durable mailbox:** Not aligned for chat asks/channel-adjacent delivery. Current pending asks are in-memory.
- **Runtime host boundary:** Not aligned. `ProjectRuntime` remains broad.
- **MCP adapter boundary:** Not directly in chat code, but orchestrator spawn materializes MCP/pod config and chat-visible MCP events.
- **UI fetch discipline:** Mostly aligned through `runtimeApi`, except `TranscriptViewer` direct fetch and raw websocket decoding in `useProjectWs`.

Conflicts and uncertainties for synthesis:

- Whether normalized transcript events should move directly into SQLite or first hide file storage behind a repository.
- Whether `agent-jsonl-event` should converge with chat `jsonl`/`session-replay` or stay a separate transcript kind.
- Whether pending asks belong in the future mailbox subsystem or a smaller pending-interactions table.
- How much raw terminal transcript should be considered product state versus runtime diagnostic state.

## 12. Recommended Target Architecture

Keep:

- `JsonlTailer` as the provider JSONL decoder.
- `InteractiveSession` as the long-running interactive process wrapper, after narrowing its public contract.
- `orchestrator_sessions` as durable conversation identity.
- `orchestrator_send_queue` as durable send intent/delivery state.
- `ChatSurface` split from `Orchestrator` lifecycle wrapper.
- Terminal fallback mode.
- Legacy replay fallback while old sessions exist.

Refactor/split:

- Split `ProjectRuntime` into:
  - `RuntimeHostAdapter`: process spawn, PTY, JSONL tail, raw transcript.
  - `ConversationSessionService`: active/new/resume/close session use cases.
  - `ConversationReplayService`: load checkpoint, append event, cursor management.
  - `ConversationSendService`: send/enqueue/retry/cancel/confirm commands.
  - `TransientSessionService`: agent-designer/workflow-builder/setup-wizard modal runtime.
- Move websocket envelope construction to a live-event adapter with a shared envelope type.
- Move chat row policy and event DTOs into browser-safe shared contracts.
- Move `TranscriptViewer` into a transcript feature client/hook.

Replace:

- Replace in-memory `PendingAskStore` with durable pending interaction rows.
- Replace ad hoc websocket event families with canonical `LiveEvent<TPayload>`.
- Replace file-only normalized event storage with DB-backed append or a repository abstraction that can bridge file and DB.

Mark for holistic synthesis:

- Mailbox versus pending-interactions ownership for asks.
- Agent transcript convergence with chat transcript events.
- Exact outbox/live cursor model.
- Whether runtime snapshots should be persisted or remain rebuildable projections.

## 13. Migration Strategy

### Phase 0: Characterize before moving boundaries

- **Goal:** Lock current behavior with tests and a contract inventory.
- **Files likely affected:** tests under `apps/server/test`, `apps/web/src/**/__tests__` or equivalent, package test scripts.
- **Dependencies:** Restore/choose test harness.
- **Risks:** Current tree has no visible tests, so harness work may be nontrivial.
- **Verification:** Reducer, replay, send queue, ask, and websocket connect tests pass.
- **Rollback:** Remove new tests only; no runtime behavior change.
- **Restart/reload required:** No app restart for tests; normal test process only.

### Phase 1: Shared contracts for chat/runtime envelopes

- **Goal:** Define shared types for `JsonlEvent`, `WsEnvelope`/future live envelope, session DTO, runtime snapshot, send queue item, replay checkpoint.
- **Files likely affected:** new `packages/contracts`, `packages/runtime/src/jsonl-tailer.ts`, `apps/server/src/features/runtime-host/*`, `apps/web/src/features/runtime/*`.
- **Dependencies:** Target package layout decision.
- **Risks:** Type-only churn can hide behavior changes if done too broadly.
- **Verification:** Typecheck and contract round-trip tests.
- **Rollback:** Keep old exported web types as aliases during migration.
- **Restart/reload required:** Build/reload only after implementation.

### Phase 2: Service boundaries around current storage

- **Goal:** Move route logic into conversation send/session/replay services without changing storage.
- **Files likely affected:** `apps/server/src/features/runtime-host/routes.ts`, `websocket-message.ts`, `pty-handlers.ts`, `services/project-runtime.ts`, new service files.
- **Dependencies:** Phase 0 tests.
- **Risks:** Session transition ordering and send-queue broadcasts are easy to regress.
- **Verification:** New/resume/close, reconnect replay, queued-send, retry/cancel tests.
- **Rollback:** Keep route-level wrappers delegating to old functions until coverage passes.
- **Restart/reload required:** Server restart after implementation.

### Phase 3: Durable pending interactions

- **Goal:** Replace `InMemoryPendingAskStore` with durable pending ask/interaction rows while preserving synchronous hook response.
- **Files likely affected:** `apps/server/src/features/chat-bridges/routes.ts`, runtime hook scripts, DB schema/repos, `useChatTimelineRenderer`.
- **Dependencies:** Decide whether mailbox owns this.
- **Risks:** Claude hook still expects one HTTP response; durable async UX must still unblock or time out predictably.
- **Verification:** Ask survives websocket reconnect; server restart behavior defined; timeout/cancel paths tested.
- **Rollback:** Compatibility adapter can still use in-memory resolver behind service if needed.
- **Restart/reload required:** DB migration and server restart.

### Phase 4: Transcript event repository

- **Goal:** Introduce append/query API for normalized conversation events. Initially mirror `jsonl-events.jsonl`; later make SQLite primary.
- **Files likely affected:** `InteractiveSession`, `session-replay.ts`, runtime routes, DB schema/repos, tests.
- **Dependencies:** Shared contracts and replay tests.
- **Risks:** Duplicate or skipped replay rows; old session compatibility.
- **Verification:** Replay from old file, new mirrored storage, reconnect high-water sequence, cursor persistence.
- **Rollback:** File replay remains fallback.
- **Restart/reload required:** DB migration and server restart.

### Phase 5: Policy-driven canonical renderer

- **Goal:** Remove legacy render path and local suppression duplication.
- **Files likely affected:** `useChatRenderItems.ts`, `normalizeJsonlEnvelope.ts`, `toolGrouping.ts`, `chat-policy.ts`, event bubble components.
- **Dependencies:** Characterization tests for hidden/shown rows.
- **Risks:** User-visible rows may disappear or duplicate.
- **Verification:** Snapshot tests for representative JSONL transcripts, manual chat dogfood.
- **Rollback:** Keep feature flag until parity verified.
- **Restart/reload required:** Web rebuild/reload.

### Phase 6: Converge transcript surfaces

- **Goal:** Bring agent, subagent, orchestrator, and terminal transcript reads under a transcript feature/service.
- **Files likely affected:** `AgentTranscriptModal.tsx`, `TranscriptViewer.tsx`, `agent-runs/routes.ts`, runtime routes, new transcript client.
- **Dependencies:** Agent subsystem plan.
- **Risks:** Agent run transcript semantics may differ from orchestrator sessions.
- **Verification:** Backfill/live merge for running agent, missing/empty transcript states, path containment.
- **Rollback:** Keep existing endpoints as compatibility until new client is stable.
- **Restart/reload required:** Server/web reload after implementation.

## 14. Acceptance Criteria

Functional:

- Start chat, send prompt, receive JSONL transcript, close, resume, and view past session all preserve current behavior.
- Queued sends remain attached to the correct session and reconcile by stable client id where available.
- Ask cards are session-scoped and answer the correct blocked hook.
- Terminal mode can load transcript tail, stream live raw output, send raw input, and resize.
- Old sessions with only `events.jsonl` still render until migration removes support intentionally.

Integration:

- Runtime routes, websocket messages, and web clients use shared contract types.
- Chat replay and live event rows share one envelope shape or a clearly documented compatibility adapter.
- Runtime host can emit facts without owning work item/workflow/product rules.
- Agent transcript UI either shares transcript contracts or explicitly documents why it remains separate.

Regression:

- `session-title-updated` never clears chat rows.
- New session clears sequenced transcript rows for the old session.
- Reconnect after missed JSONL rows replays from durable source.
- Repeated identical prompts do not incorrectly retire pending placeholders.
- Missing provider JSONL on resume falls back to the current safe behavior.

Observability/debuggability:

- Runtime snapshot exposes session id, provider id, health, wait point, raw JSONL path, replay path, cursor, queue depth.
- Pending asks/interactions have inspectable durable rows or diagnostics.
- Replay loader reports skipped malformed rows in tests or diagnostics without breaking session replay.

Performance/reliability:

- Long sessions remain bounded or virtualized in the renderer.
- Terminal raw streaming avoids O(history^2) scans.
- Websocket reconnect does not require manual refresh for chat transcript recovery.

## 15. Test Plan

Existing tests found:

- None in the current working tree outside `archive/`.

Required unit tests:

- `chatSessionReducer`: session transition, replay replacement, out-of-order seq insertion, stale session filtering, raw buffer trim.
- `session-replay`: valid JSONL replay, malformed-line skip, legacy fallback, high-water seq.
- `orchestrator-send-queue-delivery`: queue status selection, delivery in-flight guard, observed confirmation, retry/cancel.
- `runtimeState`: input capability decisions for ready/busy/spawning/exited/provider-missing.
- `rowPolicy` and render conversion: hidden/shown parity and no duplicate suppression set.
- `usePendingPrompts`: send ack, queue snapshot, clientMessageId confirmation, repeated text fallback.

Required integration tests:

- Websocket connect sends session metadata, runtime snapshot, replay, and send queue without spawning when no session exists.
- `POST /sessions/new` and `/resume` broadcast correct transition and replay checkpoint.
- Send while spawning enqueues, then drains when ready.
- `/api/ask` broadcasts ask and resolves through websocket `ask-reply`.
- Terminal transcript endpoint path containment and tail truncation.
- Agent transcript endpoint backfills provider JSONL and live `agent-jsonl-event` merge dedupes.

Manual verification:

- Start a fresh chat, send a prompt, switch tabs, return, and confirm chat remains open.
- Refresh renderer mid-turn and confirm replay plus pending/queue state is coherent.
- Simulate websocket disconnect and confirm reconnect recovers transcript.
- Use terminal mode during spawn/blocked prompt and confirm input reaches PTY.
- AskUserQuestion/permission prompt displays one ask card and answer resumes Claude.
- Open a past session read-only, then return to live.
- Open a running agent transcript modal and verify backfill plus live append.

Known hard-to-test areas:

- Real Claude provider JSONL timing and missing transcript behavior.
- Windows ConPTY raw repaint behavior.
- Claude hook blocking semantics during server restart.
- Identical repeated prompt correlation without provider-side client ids.

## 16. Implementation Notes for Next Agent

Recommended starting point:

1. Restore focused tests around current behavior before changing runtime code.
2. Start with contracts and service seams, not `ProjectRuntime` surgery.
3. Keep storage compatibility until replay tests cover current and old sessions.

Suggested work order:

- Add contract types for current envelopes and re-export them from web/server.
- Wrap `loadSessionReplayCheckpoint()` behind a `ConversationReplayService`.
- Wrap send queue operations behind a `ConversationSendService`.
- Replace `PendingAskStore` with an interface that can later use SQLite.
- Move row visibility into one policy-driven renderer path.
- Only then split `ProjectRuntime.ensurePty()` dependencies.

Risky areas to inspect before editing:

- `apps/server/src/features/runtime-host/pty-handlers.ts:153` for send confirmation before JSONL broadcast.
- `apps/web/src/hooks/chat-session-reducer.ts:153` for snapshot replacement/preservation.
- `apps/web/src/components/Orchestrator.tsx:301` for session metadata patching.
- `apps/web/src/features/chat/usePendingPrompts.ts:36` for optimistic placeholder retirement.
- `apps/server/src/services/project-runtime.ts:1058` for resume/fresh provider decision.

Things to avoid:

- Do not make websocket delivery the source of truth.
- Do not remove legacy replay fallback without a migration decision.
- Do not split `ProjectRuntime` before stable contracts/tests exist.
- Do not route terminal raw input through chat send queue.
- Do not use `session-changed` for title-only updates.
- Do not assume agent transcript events are equivalent to orchestrator chat events without verifying run/session identity semantics.

## 17. Handoff Metadata

| Field | Value |
|---|---|
| Subsystem | Chat runtime and transcript UI |
| Primary owner area | `apps/web/src/features/chat`, `apps/web/src/components/Orchestrator.tsx`, `apps/server/src/features/runtime-host`, `apps/server/src/services/project-runtime.ts`, `packages/runtime` |
| Runtime process | Server process plus Claude/PTY child process; renderer consumes websocket; agent transcript also consumes agent run processes |
| Owns state | Chat projection state, session open/viewing UI state, pending prompts, send batches, normalized session replay files, send queue commands |
| Reads state from | `orchestrator_sessions`, `orchestrator_send_queue`, provider JSONL, `jsonl-events.jsonl`, `transcript.log`, runtime snapshots, websocket stream |
| Writes state to | `orchestrator_sessions`, `orchestrator_send_queue`, `jsonl-events.jsonl`, `transcript.log`, post-turn summaries, UI stores |
| Inbound contracts | HTTP runtime routes, `/ws` inbound messages, hook `/api/ask`, chat surface props |
| Outbound contracts | Websocket envelopes, runtime process input, DB repo writes, filesystem replay writes |
| Hard dependencies | `ProjectRuntime`, `InteractiveSession`, `JsonlTailer`, DB repos, websocket hub, pod materialization |
| Soft dependencies | Agent transcripts, workflow/agent event grouping, statusline, channel bridge, terminal mode |
| Restart required for changes | Server restart for runtime/server changes; web reload for renderer changes; DB migration if state moves to SQLite |
| Migration risk | High |
| Target architecture status | Split/refactor; keep core tailer/session/queue concepts; replace in-memory asks and file-only transcript ownership over time |
| Related docs consulted | `refactor plan/target-architecture.md`, `refactor plan/subsystem-architecture-handoff-prompt.md`, `refactor plan/refactor-tracker.md`, `refactor plan/refactor plan docs/README.md` |

## 18. Tracker Update

Update `refactor plan/refactor-tracker.md`:

- Set `Chat runtime and transcript UI` status to `needs synthesis`.
- Baseline branch: `dev`.
- Baseline commit: `d114fc2535c1116f6eb2d883f9cac2a9193a8254`.
- Owner area: `apps/web`, `apps/server`, `packages/runtime`, `packages/db`.
- Runtime process: `Renderer/server/runtime/Claude PTY`.
- Migration risk: `high`.
- Target recommendation: `split/refactor; keep JSONL tailer, session rows, and send queue; add shared contracts, durable transcript/interactions, canonical live envelope`.
- Key dependencies: `Runtime host, WebSocket/event propagation, agents, workflows, MCP/channel, database`.
- Open questions: durable transcript storage model, pending asks versus mailbox, event envelope/cursor, agent transcript convergence.

## 19. Open Questions

Blocking or near-blocking:

- Should normalized chat transcript events move directly to SQLite, or should the first implementation introduce a repository abstraction while retaining file storage?
- Should orchestrator asks be owned by a durable pending-interactions subsystem or by the future mailbox subsystem?
- What is the canonical live-event cursor: transcript seq, global outbox id, or both?

Non-blocking but important:

- Should raw terminal transcript remain filesystem-only diagnostic state?
- Should agent transcript replay use the same `session-replay` envelope shape with run id as entity id?
- When is it safe to delete legacy render mode and legacy `events.jsonl` replay?
- Should `rowPolicy` live in `packages/runtime`, `packages/domain`, or future `packages/contracts`?
- How should repeated identical user prompts be correlated if provider JSONL cannot carry `clientMessageId`?

Builder-discretion decisions:

- Exact service file names and dependency injection style, as long as routes stop owning use-case logic.
- Whether tests live next to packages or in restored package-level `test/` folders.
- Whether initial transcript event repository is read-only abstraction or write-through mirror.
