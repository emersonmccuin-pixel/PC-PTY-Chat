# Runtime Transcript and Conversation Store Foundation Spec

## 1. Baseline and Scope

| Field | Value |
|---|---|
| Date | 2026-05-30 |
| Branch | `dev` |
| Commit | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` |
| Inputs | `target-architecture.md`, `holistic-architecture-synthesis.md`, `implementation-roadmap.md`, prior foundation specs, `refactor-tracker.md`, and synthesized chat/runtime, WebSocket, agents, workflows, MCP, and Channel handoffs |
| Artifact status | Planned foundation spec |
| Scope | Runtime conversation/session contracts, transcript repository strategy, file compatibility, SQLite mirror decision, replay cursor semantics, send queue service boundary, pending ask compatibility, migration, rollback, and tests. No implementation code changes. |

Evidence rule:

- Verified facts come from current non-archive code inspection.
- Synthesis and recommendations come from the roadmap, foundation specs, holistic synthesis, and subsystem handoffs.
- `archive/` was not searched, read, cited, or used.

## 2. Decisions

| Decision | Status | Rationale |
|---|---|---|
| Keep `orchestrator_sessions` as the durable conversation/session identity. | Accepted | It already stores project, provider session id, active/ended state, title, JSONL path, and JSONL line cursor. |
| Keep `orchestrator_send_queue` as the durable send intent/delivery table. | Accepted | It already has stable `clientMessageId`, session scoping, delivery statuses, retry/cancel support, and JSONL observation state. |
| Introduce a transcript repository abstraction before changing storage. | Accepted | Current replay compatibility depends on existing per-session files. A repository seam lowers risk before any DB primary or mirror migration. |
| First repository implementation remains file-backed over `jsonl-events.jsonl` with `events.jsonl` fallback. | Accepted | Current sessions must keep replaying without data migration. |
| SQLite transcript storage is mirror-only until parity tests prove old and new replay agree. | Accepted | Moving the source of truth directly to SQLite risks skipped/duplicated transcript rows and old-session breakage. |
| Transcript replay cursor is session-local `seq`; live outbox cursor remains separate. | Accepted | `jsonl-events.jsonl` replay has per-session `seq`/`highWaterSeq`, while the live-events spec defines a global `live_outbox.seq`. Mixing them would make reconnect semantics ambiguous. |
| Runtime live events are visibility/projection nudges, not transcript source of truth. | Accepted | Transcript data comes from repository reads; live events can tell clients to fetch/apply new rows. |
| Move send/enqueue/retry/cancel/observe behavior behind a `ConversationSendService`. | Accepted | Mailbox orchestrator-turn delivery needs a service facade over the send queue rather than raw PTY or Channel delivery. |
| First mailbox runtime-turn acknowledgement remains send-service acceptance. | Accepted here from mailbox spec | Stronger "observed in JSONL" acknowledgement can be added after transcript repository parity is proven. |
| Keep chat `/api/ask` blocking behavior as compatibility until pending interactions can safely replace the in-memory resolver. | Accepted | The Claude hook currently expects one HTTP response and times out after waiting; changing this without a compatibility plan can block tool execution. |
| Agent and subagent transcripts should use the same read contract later, but should not be forced into the first orchestrator storage migration. | Accepted | Agent transcripts currently backfill provider JSONL directly and have different identity/lifecycle owners. |
| Terminal raw transcript remains diagnostic, not canonical conversation transcript. | Accepted | `transcript.log` is used for terminal fallback; chat replay is already based on normalized JSONL rows. |

## 3. Verified Current-State Evidence

| Label | Finding | Evidence |
|---|---|---|
| Verified fact | The repo is on branch `dev` at commit `d114fc2535c1116f6eb2d883f9cac2a9193a8254`. | `git branch --show-current`; `git rev-parse HEAD` |
| Verified fact | `orchestrator_sessions` stores `jsonl_path` and `jsonl_line_cursor` and enforces one active session per project. | `packages/db/src/schema.ts:376`, `:399`, `:401`, `:407` |
| Verified fact | `orchestrator_send_queue` exists with a unique `(session_id, client_message_id)` index and status indexes. | `packages/db/src/schema.ts:411`, `:444` |
| Verified fact | Session repo functions create, list, reactivate, end, title, JSONL path, and cursor updates. | `packages/db/src/repos/orchestrator-sessions.ts:62`, `:111`, `:126`, `:143`, `:167`, `:183`, `:193`, `:204` |
| Verified fact | Send queue repo statuses include queued, delivering, delivered-to-PTY, observed-in-JSONL, failed, and cancelled. | `packages/db/src/repos/orchestrator-send-queue.ts:7`, `:83`, `:164`, `:202`, `:221`, `:271` |
| Verified fact | `ProjectRuntime.sessionDataPath()` maps a session id to the session data directory, and `ensurePty()` passes `jsonl-events.jsonl` as `replayEventsPath`. | `apps/server/src/services/project-runtime.ts:144`, `:433`, `:506` |
| Verified fact | `InteractiveSession` appends normalized JSONL rows to `replayEventsPath` before emitting `jsonl-event`. | `packages/runtime/src/interactive-session.ts:75`, `:374`, `:440`, `:455` |
| Verified fact | PTY handlers correlate a `jsonl-user` event to the send queue before broadcasting the `jsonl` envelope, then persist JSONL path/cursor metadata. | `apps/server/src/features/runtime-host/pty-handlers.ts:153`, `:160`, `:167`, `:181`, `:187` |
| Verified fact | Runtime connect snapshot sends `session-changed`, optional live `state`, `runtime-state`, `session-replay`, and `send-queue-snapshot`. | `apps/server/src/features/runtime-host/websocket-connect.ts:49`, `:63`, `:64` |
| Verified fact | Replay loader prefers `jsonl-events.jsonl`, falls back to legacy `events.jsonl`, skips malformed lines, and returns `highWaterSeq`. | `apps/server/src/services/session-replay.ts:146`, `:150`, `:179` |
| Verified fact | Runtime routes expose active session, session list, historical session events, terminal transcript, start/resume/close, and send queue cancel/retry endpoints. | `apps/server/src/features/runtime-host/routes.ts:145`, `:161`, `:185`, `:212`, `:246`, `:260`, `:285` |
| Verified fact | Web runtime client hand-writes route paths and response types for sessions, session events, terminal transcript, and send queue actions. | `apps/web/src/features/runtime/client.ts` |
| Verified fact | WebSocket runtime/chat envelopes are local web types, including `WsEnvelope`, `SessionReplayEnvelope`, `SendQueueSnapshotEnvelope`, `JsonlEvent`, and outbound `send`/`ask-reply`. | `apps/web/src/features/runtime/ws-types.ts:3`, `:37`, `:47`, `:369`, `:575` |
| Verified fact | Chat hook asks are in-memory: `/api/ask` stores a resolver by `toolUseId`; websocket `ask-reply` resolves it. | `apps/server/src/features/chat-bridges/routes.ts:16`, `:122`, `:136`, `:139`; `apps/server/src/features/runtime-host/websocket-message.ts:152` |
| Verified fact | The ask hook script posts to `/api/ask` only when `PC_SESSION_ID` is present and times out after 10 minutes. | `packages/runtime/src/hook-scripts/ask-intercept.cjs:12`, `:39`, `:45`, `:73` |
| Verified fact | Agent transcript modal backfills from `/agent-runs/:runId/events` and live-appends `agent-jsonl-event`. | `apps/server/src/features/agent-runs/routes.ts:143`, `:155`; `apps/server/src/services/agent-run-factory.ts:1018`; `apps/web/src/components/AgentTranscriptModal.tsx:7` |
| Verified fact | Subagent transcript viewer fetches `/api/subagent-transcript?path=...` directly. | `apps/server/src/features/chat-bridges/routes.ts:152`; `apps/web/src/components/TranscriptViewer.tsx:35` |
| Verified fact | No `conversation_events`, `runtime_events`, `transcript_events`, `pending_interactions`, or `live_outbox` table exists in current `apps`/`packages` code. | Targeted `rg` search returned no matches. |
| Verified fact | No `packages/contracts`, `packages/app-services`, `packages/live`, or `packages/mailbox` package exists in current `packages/`. | `rg --files --glob "!archive/**" --glob "!apps/server/data/**" \| rg "^packages/(contracts\|app-services\|live\|mailbox)/"` returned no matches. |
| Verified fact | No current non-archive `*.test.*` or `*.spec.*` files are discoverable. | `rg --files --glob "!archive/**" --glob "!apps/server/data/**" \| rg "(test\|spec)\.(ts\|tsx\|js\|mjs)$"` returned no matches. |

## 4. Boundary Rules

| Layer | Owns | Must not own |
|---|---|---|
| `packages/contracts` | Browser-safe session DTOs, transcript replay DTOs, send queue DTOs, websocket/HTTP command contracts, error/result shapes | DB access, Hono, React, Node fs/path, PTY handles, provider-specific process classes |
| `packages/db` | Existing session/send queue repos, future mirror transcript schema/repo, transaction helpers | Replay policy, process IO, renderer grouping, mailbox delivery policy |
| `packages/app-services` or server-local first seam | `ConversationSessionService`, `ConversationSendService`, `ConversationReplayService`, pending ask adapter boundaries | Hono route objects, React state, raw WebSocket sockets, Channel, direct UI rendering |
| Runtime host adapter | PTY spawn, stdin/stdout/stderr, resize/interrupt, JSONL tailer, provider JSONL path/cursor discovery | Product/session command rules, mailbox leases, workflow/agent product state |
| Server route/WS adapter | Existing HTTP paths, `/ws` compatibility, route status mapping, legacy envelope fanout | Transcript storage decisions or send queue state transitions outside services |
| Web runtime feature | Feature clients/hooks, reducer, render state, optimistic prompt UI | Backend route strings inside components, unknown raw event ownership outside typed adapter |
| Mailbox worker | Calls send service facade for orchestrator-turn delivery | Raw PTY sends, transcript writes, treating live socket receipt as delivery ack |
| MCP adapter | Typed localhost use of migrated conversation commands when needed | Direct DB writes or independent send/replay contracts |

Target service split:

```text
RuntimeHostAdapter
  -> emits raw process facts and normalized JSONL facts

ConversationSessionService
  -> active/new/resume/close/list session commands over orchestrator_sessions

ConversationSendService
  -> send/enqueue/cancel/retry/drain/observe commands over orchestrator_send_queue

ConversationReplayService
  -> transcript checkpoint and after-seq reads through TranscriptRepository

TranscriptRepository
  -> file-backed first, optional SQLite mirror later

RuntimeHookAskAdapter
  -> blocking /api/ask compatibility first, pending-interaction backed later
```

## 5. Contracts

Recommended files:

```text
packages/contracts/src/conversations.ts
packages/contracts/src/runtime-transcript.ts
packages/contracts/src/runtime-send-queue.ts
```

Session DTOs:

```ts
export type ConversationKind = 'orchestrator-session' | 'agent-run' | 'subagent-transcript';

export interface ConversationSessionDto {
  id: string;
  projectId: string;
  provider: 'claude';
  providerSessionId: string | null;
  model: string | null;
  title: string | null;
  status: 'active' | 'ended';
  endedReason: string | null;
  startedAt: number;
  endedAt: number | null;
  jsonlPath: string | null;
  jsonlLineCursor: number;
}
```

Transcript event DTOs:

```ts
export type TranscriptSourceKind =
  | 'pc-jsonl-events'
  | 'legacy-events-jsonl'
  | 'provider-jsonl'
  | 'terminal-log';

export interface TranscriptSourceDto {
  kind: TranscriptSourceKind;
  path: string | null;
  cursor: number | null;
}

export interface TranscriptEventDto<TEvent = unknown> {
  id: string;
  projectId: string;
  conversationKind: ConversationKind;
  conversationId: string;
  sessionId: string | null;
  seq: number;
  type: 'jsonl' | 'event' | 'raw';
  kind: string | null;
  event: TEvent;
  source: TranscriptSourceDto;
  clientMessageId?: string;
  createdAt: number | null;
}

export interface TranscriptReplayResponse {
  ok: true;
  projectId: string;
  conversationKind: ConversationKind;
  conversationId: string;
  sessionId: string | null;
  highWaterSeq: number;
  events: TranscriptEventDto[];
  resetRequired?: boolean;
}
```

Send queue DTOs:

```ts
export type RuntimeSendStatus =
  | 'queued_busy'
  | 'queued_spawning'
  | 'queued_backlog'
  | 'delivering'
  | 'delivered_to_pty'
  | 'observed_in_jsonl'
  | 'failed'
  | 'cancelled';

export interface RuntimeSendQueueItemDto {
  id: string;
  projectId: string;
  sessionId: string;
  clientMessageId: string;
  text: string;
  status: RuntimeSendStatus;
  createdAt: number;
  updatedAt: number;
  deliveryAttempts: number;
  failureReason: string | null;
}

export interface SendRuntimeTurnRequest {
  projectId: string;
  sessionId?: string | null;
  clientMessageId: string;
  text: string;
  source: 'user' | 'mailbox' | 'workflow' | 'system';
  sourceRef?: { kind: string; id: string } | null;
}

export interface SendRuntimeTurnResponse {
  ok: true;
  status: 'received' | 'queued';
  queueItem: RuntimeSendQueueItemDto;
}
```

Runtime hook ask compatibility:

```ts
export interface RuntimeHookAskRequest {
  projectId: string;
  sessionId: string | null;
  toolName: string;
  toolUseId: string;
  toolInput: unknown;
}

export interface RuntimeHookAskResponse {
  answer: string;
  interactionId?: string;
}
```

Compatibility requirements:

- Preserve current HTTP paths until migrated clients are verified.
- Preserve websocket envelopes `session-changed`, `runtime-state`, `session-replay`, `jsonl`, `send-ack`, `send-queue-snapshot`, `ask`, `terminal-input-ack`, `raw`, `state`, and `exit`.
- Preserve `highWaterSeq` and per-row `seq` semantics for active reconnect and historical session reads.
- Preserve legacy `events.jsonl` replay fallback until a migration explicitly ends support.
- Preserve current send queue statuses as wire-compatible strings.
- Preserve `/api/ask` blocking response behavior until hook compatibility is tested against pending interactions.

## 6. Transcript Repository Strategy

Recommended first interface:

```ts
export interface TranscriptRepository {
  loadCheckpoint(input: {
    projectId: string;
    conversationKind: ConversationKind;
    conversationId: string;
    sessionId?: string | null;
  }): Promise<TranscriptReplayResponse>;

  listAfter(input: {
    projectId: string;
    conversationKind: ConversationKind;
    conversationId: string;
    afterSeq: number;
    limit: number;
  }): Promise<TranscriptReplayResponse>;

  appendNormalizedEvent?(input: {
    projectId: string;
    conversationKind: ConversationKind;
    conversationId: string;
    sessionId: string;
    event: unknown;
    source: TranscriptSourceDto;
    clientMessageId?: string;
  }): Promise<TranscriptEventDto>;
}
```

First implementation:

- `FileTranscriptRepository` wraps current `loadSessionReplayCheckpoint()` behavior.
- Reads orchestrator sessions from `<data>/projects/<projectId>/sessions/<sessionId>/jsonl-events.jsonl`.
- Falls back to `events.jsonl` for legacy sessions.
- Skips malformed rows without failing the whole replay.
- Returns current `seq`/`highWaterSeq` as the replay cursor.
- Does not change `InteractiveSession` writes in the first build slice.

Second implementation step:

- Move append responsibility behind the repository only after replay tests exist.
- The first write-through repository must append to `jsonl-events.jsonl` first or in the same observable order the UI currently depends on.
- SQLite mirror rows can be inserted after file append, but mirror failure must not break the existing file-backed runtime until SQLite-primary is deliberately selected.

SQLite mirror table, if added:

```text
conversation_events
  id
  project_id
  conversation_kind
  conversation_id
  session_id
  seq
  type
  kind
  event_json
  source_kind
  source_path
  source_cursor
  client_message_id
  created_at
```

Recommended indexes:

- unique `(conversation_kind, conversation_id, seq)`;
- index `(project_id, conversation_kind, conversation_id, seq)`;
- optional unique source index `(source_kind, source_path, source_cursor)` when `source_cursor` is non-null.

SQLite mirror is not:

- a replacement for `live_outbox`;
- a mailbox delivery queue;
- a raw terminal log store;
- proof that a runtime turn was delivered to Claude;
- a deletion trigger for old session files.

## 7. Replay and Cursor Semantics

Cursor rules:

- Transcript replay cursor is per conversation and equals the maximum transcript `seq` returned as `highWaterSeq`.
- `source.cursor` is provider/file cursor metadata for server resume and diagnostics; clients should not use it as the UI replay cursor.
- Live outbox cursor is global and separate. A `conversation.transcript.appended` live event may include `{ conversationId, highWaterSeq }`, but the client fetches transcript rows by `afterSeq`.
- A missing transcript cursor means "load checkpoint".
- An expired or unavailable transcript cursor should return `resetRequired: true` and a fresh checkpoint, not partial unknown state.
- Clients dedupe transcript rows by `id` and ignore rows for non-current `sessionId` unless explicitly viewing historical sessions.

Recommended replay endpoints:

```text
GET /api/projects/:projectId/conversations/orchestrator/:sessionId/events
GET /api/projects/:projectId/conversations/orchestrator/:sessionId/events?afterSeq=<n>&limit=<n>
```

Compatibility:

- Keep existing `GET /api/projects/:projectId/sessions/:sessionId/events`.
- The existing route can delegate to `ConversationReplayService` and map the result back to current `{ ok, sessionId, highWaterSeq, events }`.

## 8. Send Queue Service Boundary

Recommended service: `ConversationSendService`.

Use cases:

| Use case | Service owns | Adapter still owns initially |
|---|---|---|
| `sendUserTurn` | Ensure active session, choose direct send vs enqueue, insert send row, return typed ack | WebSocket message parsing and legacy `send-ack` envelope |
| `enqueueRuntimeTurn` | Mailbox/system enqueue into `orchestrator_send_queue`, idempotent `clientMessageId`, return send queue row | Mailbox worker lease/retry policy |
| `deliverNextQueuedTurn` | Select next queued row, mark delivering, call runtime host port, mark delivered/failed | Runtime host process implementation |
| `observeUserJsonl` | Match `jsonl-user` text FIFO to delivered row, mark `observed_in_jsonl`, emit/send queue snapshot | PTY JSONL handler invokes it before live broadcast |
| `cancelQueuedTurn` | Guard status/session, mark cancelled | HTTP status mapping |
| `retryFailedTurn` | Guard status/session, choose queued status from runtime state/backlog | HTTP status mapping |
| `listVisibleTurns` | Public send queue DTO query | Existing connect/replay envelope shape |

Recommended runtime send port:

```ts
export interface RuntimeTurnPort {
  getState(projectId: string): 'ready' | 'busy' | 'spawning' | 'exited' | string;
  sendToPty(projectId: string, sessionId: string, text: string): Promise<'ok' | string>;
}
```

Mailbox integration:

- The mailbox worker must call `enqueueRuntimeTurn`, not raw PTY.
- Mailbox delivery status may become `accepted` when `enqueueRuntimeTurn` returns a row.
- Store send queue row id as mailbox delivery target ref.
- A later milestone can listen for `observed_in_jsonl` and mark a stronger delivery completion, but that is not required for first mailbox cutover.

Compatibility:

- Direct ready sends may continue to write a `delivered_to_pty` row immediately, as current `recordDeliveredOrchestratorSend()` does.
- Existing `send-ack` statuses remain `received`, `queued`, `invalid-message`, `no-session`, and `error`.
- Existing `send-queue-snapshot` remains the recovery surface for pending/failed sends.

## 9. Pending Ask Compatibility

Current problem:

- `/api/ask` stores an in-memory resolver keyed by `toolUseId`.
- The hook blocks until a response or timeout.
- A server restart loses the resolver and cannot answer the in-flight hook cleanly.

Target shape:

```text
hook POST /api/ask
  -> RuntimeHookAskAdapter
  -> optional PendingInteractionService row
  -> live/ui ask prompt
  -> answer command resolves waiting hook when still connected
  -> timeout/cancel updates pending interaction state
  -> HTTP response preserves { answer }
```

Migration rule:

- Do not replace the in-memory resolver until the compatibility behavior is specified and tested.
- First durable step can create a `pending_interactions` row while still using the in-memory resolver for the blocking HTTP response.
- If the process restarts while a hook is waiting, the durable row should move to `failed`/`expired` or stay inspectable according to pending-interaction policy; it cannot magically unblock the old HTTP connection.
- UI answer commands should eventually answer a pending interaction id, with `toolUseId` as compatibility lookup.

Open dependency:

- The mailbox/pending-interactions spec owns the table and answer lifecycle. This spec only requires that runtime hook asks preserve blocking HTTP semantics until the hook protocol changes.

## 10. Agent and Subagent Transcript Convergence

Target read contract:

```text
TranscriptRepository
  -> orchestrator sessions from jsonl-events.jsonl
  -> agent runs from provider JSONL adapter
  -> subagent transcript path adapter
```

Migration guidance:

- Do not make agent transcript storage part of the first orchestrator transcript migration.
- First convergence step should be read-contract only:
  - `ConversationKind = 'agent-run'` maps to `agent_runs.id`;
  - backfill continues to use `AgentRunJsonlTailer` and `jsonlPathFor`;
  - live still accepts `agent-jsonl-event` until canonical live event migration.
- Subagent path reads should move behind a server feature client/contract and keep path containment guards.
- Agent and subagent transcripts can later mirror into `conversation_events` if their owner services provide stable identity and sequence semantics.

Compatibility:

- Preserve `GET /api/projects/:projectId/agent-runs/:runId/events`.
- Preserve `agent-jsonl-event` websocket envelopes until agent-run live events migrate.
- Preserve `/api/subagent-transcript?path=...` until caller surfaces move to a typed transcript client.

## 11. Live Events Integration

Recommended canonical live facts after the live-outbox layer exists:

| Event | Entity | Scope | Payload policy |
|---|---|---|---|
| `conversation.session.changed` | `runtime-session` | `project` | Session id, transition, status/title snapshot or refetch hint. |
| `conversation.transcript.appended` | `conversation` | `project` | Conversation id, session id, appended seq range, highWaterSeq. No full long transcript payload. |
| `conversation.send-queue.changed` | `conversation` | `project` | Session id plus send queue item id/status or refetch hint. |
| `conversation.ask.changed` | `conversation` or future `pending-interaction` | `project` | Interaction id/toolUseId/status only. |

Rules:

- Live events should not replace `session-replay` until transcript repository and client replay are implemented.
- Runtime JSONL payloads can remain legacy `jsonl` frames during compatibility.
- The client may use live events to fetch `afterSeq` transcript rows, but durable replay remains repository-backed.
- Do not put full long transcript history in `live_outbox.payload`.

## 12. Migration Phases

| Phase | Goal | Files likely affected | Risk | Verification | Rollback |
|---|---|---|---|---|---|
| 0 | Restore/recreate characterization tests for current session, replay, send queue, ask, terminal, and agent transcript behavior. | Test harness only | Low behavior risk | Tests document current behavior and known gaps. | Tests only. |
| 1 | Add shared contracts for session DTOs, transcript replay, send queue, and hook asks. | `packages/contracts/*` | Build/import risk | Contract parser/type tests and import-boundary checks. | Additive files can be removed. |
| 2 | Add `ConversationReplayService` and `FileTranscriptRepository` that delegate to current replay loader. | Server services/routes | Low/medium | Existing session events route returns identical response for file fixtures. | Route delegates back to current `loadSessionReplayCheckpoint()`. |
| 3 | Add `ConversationSendService` facade over current send queue repo and delivery helper. | Runtime-host WS/routes, send queue delivery service | Medium/high | Send ready, enqueue while busy/spawning, cancel, retry, observe JSONL tests. | Keep current websocket-message and delivery helper path. |
| 4 | Move runtime routes and connect snapshot to services without changing envelopes. | `runtime-host/routes.ts`, `websocket-connect.ts` | Medium | Active/new/resume/close/replay/send queue snapshots match current shapes. | Route wrappers call old helpers. |
| 5 | Add optional SQLite mirror repo behind no primary reads. | `packages/db`, migrations, transcript repo | DB migration risk | File replay and mirror replay parity tests. | Mirror disabled; files remain source. |
| 6 | Add after-seq transcript replay endpoint/client hook. | Server transcript feature, web runtime client/reducer | Medium | Reconnect after missed rows applies/dedupes transcript rows. | Keep current full checkpoint replay. |
| 7 | Add pending-interaction shadow row for `/api/ask` while keeping in-memory blocking resolver. | Chat bridge routes, pending interaction service | Medium/high | Ask answer/timeout behavior unchanged; row is inspectable. | Disable shadow write. |
| 8 | Expose mailbox runtime-turn delivery through `enqueueRuntimeTurn`. | Mailbox worker, send service facade | High | One mailbox delivery creates at most one send queue row and returns target ref. | Disable mailbox message kind; Channel fallback remains. |
| 9 | Migrate agent/subagent transcript reads to shared transcript read contract. | Agent-run routes, TranscriptViewer, web transcript client | Medium/high | Agent transcript backfill/live merge still works; path guards preserved. | Keep existing endpoints. |
| 10 | Promote SQLite transcript mirror to primary only if parity, retention, and backup decisions are made. | Transcript repo, DB, routes, migration docs | High | Old file replay and SQLite replay agree; rollback path documented. | Use file-backed repository as fallback. |

Roadmap alignment:

- Contracts align with roadmap Phase 1.
- Conversation/session/send/replay service aligns with roadmap Phase 7.
- Mailbox runtime-turn delivery depends on roadmap Phase 8.
- Runtime host splitting waits until this service boundary is stable.

## 13. Compatibility and Rollback

Compatibility requirements:

- Keep old session files readable:
  - `jsonl-events.jsonl` as current normalized replay;
  - `events.jsonl` as legacy fallback.
- Keep current HTTP routes and websocket envelopes during migration.
- Keep one active session per project invariant.
- Keep websocket connect non-spawning.
- Keep send queue idempotency by `(sessionId, clientMessageId)`.
- Keep `clientMessageId` stamping on observed `jsonl-user` envelopes when possible.
- Keep terminal raw input outside the chat send queue.
- Keep `/api/ask` blocking response behavior until the hook protocol is deliberately changed.
- Keep agent transcript endpoints and `agent-jsonl-event` until convergence is tested.

Rollback posture:

- Contracts are additive.
- Replay service can delegate back to file loader.
- Send service can be bypassed by existing runtime-host handlers until tests pass.
- SQLite mirror can be disabled without changing runtime replay.
- Mailbox orchestrator-turn delivery can be disabled by message kind.
- Legacy full `session-replay` remains fallback even after after-seq endpoint exists.

## 14. Acceptance Criteria

This foundation spec is build-ready when:

- Session, transcript replay, send queue, and hook ask contract shapes are explicit.
- `TranscriptRepository` starts file-backed and preserves old session compatibility.
- SQLite transcript storage is clearly mirror-only until parity tests pass.
- Replay cursor semantics distinguish transcript `seq` from global live outbox cursor.
- `ConversationSendService` owns send/enqueue/cancel/retry/observe behavior and exposes a mailbox-safe `enqueueRuntimeTurn` facade.
- Pending ask compatibility preserves `/api/ask` blocking semantics while allowing future durable pending interactions.
- Agent/subagent transcript convergence is staged as read-contract first, not forced into the first orchestrator migration.
- Migration, rollback, and tests are defined.

Implementation still requires user confirmation.

## 15. Test Plan

Required characterization tests before behavior changes:

- Session lifecycle:
  - websocket connect with no session does not spawn a PTY;
  - start new session ends prior active row and broadcasts empty replay/send queue;
  - resume reactivates the selected row;
  - close ends active row and kills live PTY.
- Replay:
  - `jsonl-events.jsonl` valid rows replay in `seq` order;
  - malformed rows are skipped;
  - legacy `events.jsonl` fallback still renders;
  - `highWaterSeq` is stable.
- Send queue:
  - ready send records `delivered_to_pty` and returns `send-ack`;
  - busy/spawning/backlog sends enqueue with correct status;
  - `jsonl-user` marks the first matching delivered row `observed_in_jsonl`;
  - cancel only affects queued rows;
  - retry only affects failed rows.
- Ask compatibility:
  - `/api/ask` broadcasts `ask`, stores resolver, resolves through websocket `ask-reply`;
  - timeout returns current timeout text;
  - missing `projectId` returns current fallback answer.
- Terminal:
  - terminal transcript endpoint stays path-contained and tail-limited;
  - terminal raw input bypasses send queue.
- Agent/subagent transcripts:
  - agent run events endpoint backfills provider JSONL;
  - live `agent-jsonl-event` merge/dedupe works;
  - subagent transcript path guard rejects invalid paths.

Required contract/repo tests after implementation starts:

- `TranscriptRepository` file implementation returns current response shape for fixtures.
- `listAfter(afterSeq)` returns only rows with greater `seq` and dedupes by id.
- SQLite mirror write stores event JSON, source metadata, and client message id without changing file replay.
- File replay and SQLite mirror replay parity over representative transcripts.
- `ConversationSendService.enqueueRuntimeTurn` is idempotent by `sessionId + clientMessageId`.
- `ConversationSendService.observeUserJsonl` stamps the matching `clientMessageId` exactly once.
- Import-boundary tests keep `packages/contracts` browser-safe.

Required integration tests after implementation starts:

- Refresh renderer mid-turn and recover transcript plus send queue without duplicate user rows.
- Socket disconnect during a turn then reconnect; session replay/checkpoint recovers visible transcript.
- Mailbox delivery creates one send queue row and does not raw-send to PTY.
- Ask shadow pending interaction does not change blocking hook behavior.
- Agent transcript shared read adapter returns the same event list as the old endpoint.

Manual verification after implementation starts:

- Start chat, send a prompt, refresh mid-turn, and confirm replay/queue state is coherent.
- Send multiple identical prompts and verify placeholder reconciliation remains stable.
- Switch to a past session, view events, resume it, and confirm the active session changes correctly.
- Use terminal mode and confirm raw input/output still works.
- Trigger `AskUserQuestion` and verify one ask card appears and answering unblocks the hook.
- Open a running agent transcript modal and verify backfill plus live append.

Current gap:

- No current non-archive tests exist, so the phase-0 test characterization plan remains a build-readiness dependency.

## 16. Observability

Recommended diagnostics:

- Session id, project id, provider session id, status, title, JSONL path, JSONL cursor.
- Transcript repository source: file path, source kind, highWaterSeq, malformed-row count, mirror parity status.
- Send queue depth by status, oldest queued row age, delivery attempts, observed-in-JSONL count.
- Runtime turn source: user, mailbox, workflow, system, plus source ref.
- Ask id/toolUseId, pending interaction id when present, timeout/cancel/answer timestamps.
- Live event correlation: live outbox id/cursor when a transcript/send/session nudge is emitted.

Debug surfaces:

- Runtime inspector should show active session, replay path, highWaterSeq, JSONL path/cursor, and send queue depth.
- Transcript inspector should compare file replay and SQLite mirror when the mirror exists.
- Send queue inspector should cross-link mailbox delivery target refs.
- Pending ask inspector should show in-memory resolver state plus durable pending interaction shadow row when present.

## 17. Open Questions

Blocking for implementation slice planning:

- What exact first routes should expose after-seq replay: new `/conversations/*` only, or existing `/sessions/:id/events?afterSeq=` first?
- Should SQLite mirror writes be synchronous with file append or best-effort async during the first mirror phase?
- What feature flag or config disables SQLite transcript mirror if parity fails?
- What is the first mailbox message kind to call `enqueueRuntimeTurn` once the send service exists?

Deferred to pending interactions/mailbox:

- Should `/api/ask` create a pending interaction before or after broadcasting the ask card?
- How should a pending interaction created for a hook be terminalized after server restart while the original HTTP request is gone?
- Should UI ask answers eventually target `interactionId`, `toolUseId`, or both?

Deferred to runtime host split:

- Which `ProjectRuntime` methods become ports versus stay in a compatibility facade?
- Should JSONL path/cursor persistence live in runtime host or conversation session service?
- Should provider JSONL missing-on-resume errors terminalize the session or keep the current fallback behavior?

Non-blocking:

- Retention policy for file transcripts after SQLite primary exists.
- Whether raw terminal logs should ever be indexed for search.
- Whether transcript events should carry `createdAt` from provider timestamp when available or append time only.
- Whether agent transcript events should use one sequence per run or preserve provider line numbers as sequence.

## 18. Next Planning Artifact Notes

The next artifact, `refactor plan/refactor plan docs/work-items-stages-fields-attachments.md`, can rely on these decisions:

- Conversation/runtime send service will be the adapter point for future mailbox-created orchestrator turns.
- Transcript replay remains file-compatible while service boundaries are introduced.
- Live events are projection nudges; work-item plans should not depend on chat websocket delivery as durable truth.
- Pending interactions are the future durable action state, but `/api/ask` remains compatibility-bound until tested.
