# Chat Runtime WebSocket Pod Audit

Status: `auditing`.

Owner: Codex.

Worktree: `E:\Claude Code Projects\Personal\PC-PTY-Chat-phase5`.

Branch: `codex/phase-5-hardening`.

Base: `dev` at `44980f1`.

## Ownership

Server modules:

- `apps/server/src/features/runtime-host/routes.ts`: orchestrator session, runtime snapshot, replay, terminal transcript, new/resume session, send queue retry/cancel.
- `apps/server/src/features/runtime-host/websocket-server.ts`: `/ws` server, connection validation, keepalive sweep.
- `apps/server/src/features/runtime-host/websocket-connect.ts`: deterministic connect snapshot.
- `apps/server/src/features/runtime-host/websocket-message.ts`: inbound WebSocket message protocol.
- `apps/server/src/features/runtime-host/pty-handlers.ts`: PTY event listeners and broadcast fanout.
- `apps/server/src/services/project-runtime.ts`: project-scoped durable orchestrator PTY lifecycle and adjacent transient PTY lifecycle.
- `apps/server/src/services/websocket-hub.ts`: per-project subscriber registry.
- `apps/server/src/services/orchestrator-runtime-snapshot.ts`: public runtime snapshot payload.
- `apps/server/src/services/orchestrator-runtime-health.ts`: health and wait-point derivation.
- `apps/server/src/services/orchestrator-send-queue-delivery.ts`: prompt queue public shape, delivery, and JSONL confirmation.
- `apps/server/src/services/session-replay.ts`: replay checkpoint loader from normalized session logs.
- `apps/server/src/services/terminal-mode.ts`: raw terminal input validation and transcript tail reads.

Runtime modules:

- `packages/runtime/src/interactive-session.ts`: orchestrator wrapper used by `ProjectRuntime.ensurePty()`.
- `packages/runtime/src/pty-session.ts`: interactive PTY primitive used by transient sessions and related event contracts.
- `packages/runtime/src/jsonl-tailer.ts`: canonical Claude JSONL event normalizer and cursor source.
- `packages/runtime/src/send-protocol.ts`: text send mechanics used by PTY sessions.
- `packages/runtime/src/ready-gate.ts`: ready signal detection used during spawn.
- `packages/runtime/src/path-resolver.ts`: provider JSONL path resolution.
- `packages/runtime/src/agent-run-jsonl-tailer.ts`: adjacent transcript backfill/live transcript parser for agent runs.

Web modules:

- `apps/web/src/hooks/use-project-ws.ts`: active-project WebSocket, heartbeat, reconnect, outbound messages, diagnostics.
- `apps/web/src/hooks/use-all-projects-ws.ts`: sibling sockets for non-active project activity.
- `apps/web/src/hooks/ws-heartbeat.ts`: shared heartbeat timeout, ping, and reconnect backoff helpers.
- `apps/web/src/hooks/chat-session-reducer.ts`: replay ordering, high-water dedupe, active-session filtering.
- `apps/web/src/features/runtime/client.ts` and `types.ts`: HTTP client and web-side runtime contracts.
- `apps/web/src/components/Orchestrator.tsx`: runtime coordinator, session controls, input capability adapter.
- `apps/web/src/components/StatusBar.tsx`: runtime and WebSocket diagnostics display.
- `apps/web/src/features/chat/*`: ChatSurface, timeline, composer, pending prompts, terminal pane, JSONL normalization.
- `apps/web/src/components/TerminalModePanel.tsx`: xterm surface, terminal transcript tail attach, raw input and resize callbacks.
- `apps/web/src/components/SessionsRail.tsx`: session history surface.
- `apps/web/src/components/AgentTranscriptModal.tsx`: adjacent agent transcript backfill plus live WS merge.

Public entry points:

- HTTP: `/api/projects/:projectId/session`.
- HTTP: `/api/projects/:projectId/orchestrator/runtime`.
- HTTP: `/api/projects/:projectId/sessions`.
- HTTP: `/api/projects/:projectId/sessions/:sessionId/events`.
- HTTP: `/api/projects/:projectId/sessions/:sessionId/terminal-transcript`.
- HTTP: `/api/projects/:projectId/sessions/new`.
- HTTP: `/api/projects/:projectId/sessions/:targetId/resume`.
- HTTP: `/api/projects/:projectId/send-queue/:sendId/cancel`.
- HTTP: `/api/projects/:projectId/send-queue/:sendId/retry`.
- WebSocket: `/ws?projectId=<ULID>`.

DB tables and repos:

- `orchestratorSessions` via `repos/orchestrator-sessions.ts`.
- `orchestratorSendQueue` via `repos/orchestrator-send-queue.ts`.
- Adjacent status surfaces: `statuslineSnapshots`, `postTurnSummaries`, `agentRuns`.

Persisted files:

- `<dataDir>/projects/<projectId>/sessions/<sessionId>/jsonl-events.jsonl`: normalized replay source of truth.
- `<dataDir>/projects/<projectId>/sessions/<sessionId>/events.jsonl`: legacy replay fallback.
- `<dataDir>/projects/<projectId>/sessions/<sessionId>/transcript.log`: raw PTY terminal transcript.
- Provider JSONL from `jsonlPathFor(project.folderPath, providerSessionId)`.
- `orchestrator_sessions.jsonl_path` and `orchestrator_sessions.jsonl_line_cursor` persist provider path/cursor.

WebSocket envelopes:

- Inbound: `send`, `interrupt`, `terminal-input`, `resize`, `ask-reply`, `client-ping`.
- Outbound core: `session-changed`, `session-replay`, `runtime-state`, `send-ack`, `send-queue-snapshot`, `server-pong`.
- Outbound runtime stream: `state`, `turn-end`, `event`, `jsonl`, `raw`, `exit`.
- Adjacent shared bus: `agent-jsonl-event`, `agent-run-changed`, `channel-event`, `statusline-snapshot`, `work-items-changed`, `workflow-run-changed`, `pod-changed`.

MCP and workflow hooks:

- No `pc_*` tool is owned directly by this pod.
- The orchestrator process is spawned with the `orchestrator` pod, session-local MCP config, and PC session env.
- Pending ask replies enter through the chat WebSocket `ask-reply` message.
- Agent transcript and channel events share the same project WebSocket bus but belong primarily to the agent-runs/channel pods.

## Trace Evidence

Captured from the current implementation with focused tests, not by restarting or manually driving the live app.

Connect/replay trace:

1. `/ws?projectId=<id>` is accepted only when `projectId` resolves.
2. Server subscribes the socket in `ProjectWebSocketHub`.
3. Connect snapshot sends, in order: `session-changed`, optional live `state`, `runtime-state`, `session-replay`, `send-queue-snapshot`.
4. Background PTY start happens after the snapshot, so reconnect can reconcile before process activity resumes.
5. Replay high-water and queue state are rebuilt from disk/DB, not lifecycle memory.

Heartbeat/reconnect trace:

1. Client heartbeat sends `client-ping` every 15 seconds while the socket is open and inbound traffic is fresh.
2. Server replies with `server-pong` carrying nonce, client sent timestamp, and server time.
3. Client treats 45 seconds of inbound silence as stale, closes the socket, records timeout diagnostics, and schedules reconnect.
4. Reconnect backoff advances `2s -> 5s -> 15s -> 30s` and caps there.
5. Server protocol keepalive separately pings clients and terminates sockets that miss pong across sweeps.

Prompt send trace:

1. Web composer creates a `clientMessageId` and optimistic pending prompt.
2. `send` with ready PTY writes to `PtySession.send()`, records `orchestrator_send_queue` as `delivered_to_pty`, sends `send-ack: received`, and broadcasts a queue snapshot.
3. `send` while busy/spawning/backlogged inserts a queued row, sends `send-ack: queued`, and broadcasts a queue snapshot without writing to PTY.
4. If no active session exists, send creates one, broadcasts `session-changed` plus `session-replay`, then queues/writes according to runtime state.
5. A later `jsonl-user` event advances the delivered row to `observed_in_jsonl`; if the runtime is still ready, queued delivery continues.

Terminal trace:

1. Terminal mode loads `/terminal-transcript` for the active session.
2. Live `raw` envelopes append by `terminalSeq`, with transcript/live overlap removal during attach.
3. `terminal-input` validates a string payload, caps byte size, and writes to the live PTY.
4. Invalid, oversized, and absent-PTY input are rejected server-side without queue mutation.
5. Orchestrator and transient terminal stdin intentionally remain writable during `spawning` so a user can dismiss unexpected provider boot/resume prompts that block readiness.

Session switch trace:

1. `sessions/new` cancels open sends for the replaced session and broadcasts its queue snapshot.
2. A fresh session row is created, then `session-changed`, `session-replay`, and the new queue snapshot are broadcast.
3. `sessions/:targetId/resume` reactivates the target, cancels replaced-session sends, broadcasts replay/queue surfaces, and starts the PTY in the background.

## User Workflows

Create/start:

- Opening a project calls `useProjectWs(activeProject)` and connects to `/ws?projectId=<id>`.
- Server validates the project, subscribes the socket, sends the connect snapshot, then starts the orchestrator PTY in the background.
- `ProjectRuntime.ensureActiveSession()` creates a durable session row without blocking on process spawn.

Read/list/open:

- Connect snapshot sends the active `session-changed`, current `runtime-state`, `session-replay`, and `send-queue-snapshot`.
- `runtimeApi.listSessions()` reads session history for the sessions rail.
- `runtimeApi.getSessionEvents()` reads past session replay.
- `runtimeApi.getTerminalTranscript()` reads the raw transcript tail for terminal mode.

Update/send/continue:

- Composer send creates a client message id and optimistic pending prompt.
- WebSocket `send` writes directly to the PTY if state is `ready` and no queue backlog exists.
- If PTY is busy, spawning, or has backlog, the server inserts `orchestrator_send_queue`.
- Server returns `send-ack` and broadcasts `send-queue-snapshot`.
- JSONL `jsonl-user` confirmation advances delivered sends to `observed_in_jsonl`.
- Queue delivery retries one prompt per ready turn and continues after JSONL confirmation if runtime is still ready.

Stop/delete/restore:

- `interrupt` calls the live PTY interrupt path.
- `sessions/new` ends the current durable session, cancels open sends, kills the PTY, creates a fresh session, broadcasts replay and queue surfaces, then starts a background PTY.
- `sessions/:targetId/resume` reactivates a prior session, cancels replaced-session queue items, kills current PTY, broadcasts replay and queue surfaces, then starts a background PTY.
- Send queue rows can be cancelled or retried through HTTP endpoints.

Terminal mode:

- Terminal panel attaches by reading the transcript tail, then applies live `raw` envelopes ordered by `terminalSeq`.
- Terminal input is sent through WebSocket `terminal-input`.
- Server validates the byte payload and writes raw bytes only if a live PTY is attached.
- Current web behavior intentionally allows terminal stdin for live non-terminal process states, including spawning, as a recovery escape hatch.

Error and empty states:

- Unknown project returns HTTP 404 or WS policy close.
- Missing active session is created lazily on first connect/send path.
- Invalid `send.text` returns `send-ack` with `invalid-message`.
- Missing PTY during send can return `send-ack` with `no-session`.
- Invalid terminal input returns `terminal-input-ack`, but the web UI does not yet surface this explicitly.
- Missing transcript returns empty terminal bytes, not failure.
- Past sessions with no replay render as empty.

Reload/reconnect/resume:

- Server keepalive uses protocol ping/pong and terminates sockets that miss pong across sweeps.
- Client app heartbeat sends `client-ping`, expects `server-pong`, and reconnects on inbound silence.
- Reconnect uses exponential backoff and wake/focus/online stale-socket checks.
- Reconnect snapshot replays durable session state and queue state without needing process lifecycle memory.

Agent transcript adjacency:

- `AgentTranscriptModal` backfills with `GET /api/projects/:projectId/agent-runs/:runId/events`.
- Live transcript events append from `agent-jsonl-event` envelopes on the project WebSocket.
- This is cross-pod behavior; keep audit findings linked to the agent-runs/transcripts pod.

## Dependency Map

Imports into the pod:

- Runtime-host server modules import `@pc/domain`, `@pc/db`, Hono, `ws`, and runtime-host services.
- `ProjectRuntime` imports DB repos, domain types, runtime classes, pod materialization, workflow/work-item services, and settings/runtime bundle helpers.
- Web runtime surfaces import feature clients/types, `use-project-ws` envelope types, and chat feature helpers.

Imports out of the pod:

- `apps/server/src/index.ts` composes runtime-host routes, WebSocket server, PTY controller, hub, and runtime snapshot service.
- `apps/web/src/App.tsx` creates the active project WebSocket hook and passes events through the shell.
- Many web features import `WsEnvelope` from `use-project-ws.ts` to listen for their own broadcast deltas.
- Work item, workflow, pod, agent-run, statusline, and project-context features broadcast onto the same project WebSocket hub.

Cross-pod calls that should stay explicit:

- Agent-run transcript live events use the same WebSocket bus but are not owned by the chat runtime.
- Work item, workflow, pod, statusline, project context, and channel events use `WsEnvelope` as a shared event bus.
- `terminal-mode.ts` is shared by runtime-host and transient-session routes.
- `ProjectRuntime` still owns durable orchestrator plus transient modal PTYs; transient sessions are a separate audit pod.

Duplicate adapters or protocol translations:

- `apps/web/src/hooks/use-project-ws.ts` defines broad event and JSONL types that mirror runtime/server event shapes.
- `apps/web/src/features/runtime/types.ts` mirrors server runtime snapshot/session/queue payloads.
- `chat-session-reducer.ts` converts `session-replay` items back into `WsEnvelope` shape.
- `usePendingPrompts.ts` confirms prompts by both queue item status and matching transcript text.

## Dead Code And Drift

- `turn-end` is marked vestigial in `packages/runtime/src/pty-session.ts` but remains part of web live-state derivation.
- `events.jsonl` legacy fallback still exists for old sessions; no safe-delete decision yet.
- The Phase 0 plan said transient terminal input should wait for ready, but current code intentionally allows raw terminal input while spawning for recovery.
- Server sends `terminal-input-ack` failures, but the web contract and UI do not have an explicit display path for them.
- `WsEnvelope` lives in `use-project-ws.ts` and is imported broadly, so a hook file is acting as a public cross-feature event contract.
- Client heartbeat/reconnect pure helpers exist, but no dedicated web-side test file was found for focus/visibility/online reconnect behavior.
- Agent transcript dedupe uses a serialized event key rather than a stable cursor or sequence id.
- No unused runtime files or safe deletes were proven during this initial pass.

## Tests And Gaps

Existing focused tests:

- `apps/server/test/runtime-host-websocket-server.test.ts`: connection validation, subscribe/detach, keepalive sweep, send callback closed-socket guard.
- `apps/server/test/runtime-host-websocket-connect.test.ts`: connect snapshot ordering.
- `apps/server/test/runtime-host-websocket-message.test.ts`: `client-ping`, ready send, busy queue, no-session creation, terminal/resize/interrupt/ask routing.
- `apps/server/test/runtime-host-routes.test.ts`: runtime snapshot route, new/resume sessions, queue retry.
- `apps/server/test/runtime-host-pty-handlers.test.ts`: ready drain, JSONL replay metadata/cursor/queue confirmation, path persistence, exit lifecycle.
- `apps/server/test/orchestrator-send-queue-delivery.test.ts`: JSONL confirmation continues queued delivery while ready.
- `apps/server/test/orchestrator-runtime-snapshot.test.ts`: replay high-water, line count, reconnect snapshot queue state.
- `apps/server/test/orchestrator-runtime-health.test.ts`: health and wait point derivation.
- `apps/server/test/session-replay.test.ts`: normalized replay loading, high-water, legacy fallback, malformed lines.
- `apps/server/test/terminal-mode.test.ts`: terminal input validation and transcript tail containment.
- `apps/server/test/web-pending-prompts.test.ts`: optimistic pending prompt metadata and confirmation.
- `apps/server/test/web-terminal-capabilities.test.ts`: orchestrator/transient terminal writability during spawning and unavailable-state blocking.
- `apps/server/test/web-ws-heartbeat.test.ts`: reconnect schedule, heartbeat timeout threshold, client ping shape.
- `apps/server/test/web-boundaries.test.ts`: chat feature and client boundary guards.
- `apps/server/test/websocket-hub.test.ts`: broadcast fanout, detach behavior, closed-socket skip, global broadcast.
- `apps/server/test/project-runtime-session-resume.test.ts`: legacy resume when provider JSONL is missing.

Missing tests or trace evidence:

- No live browser/user-driven prompt trace has been captured yet from composer through JSONL confirmation.
- No browser-level test covers heartbeat timeout, focus/online stale reconnect, and replay restoration together.
- Browser-level reconnect behavior still lacks a UI smoke for focus/visibility/online recovery.
- No UI smoke was run for terminal transcript attach plus live raw-event overlap removal.
- No test was found that asserts `terminal-input-ack` failures are visible to the user.
- Agent transcript modal still needs active, historical, empty, failed, and missing transcript state coverage.

## Cleanup Plan

Do not change runtime behavior until a trace identifies a specific failure.

Small cleanup candidates after trace:

- Move shared WebSocket envelope contracts out of `use-project-ws.ts` into a feature contract module.
- Done in this slice: extracted shared heartbeat/backoff helpers to `apps/web/src/hooks/ws-heartbeat.ts` and added focused tests.
- Done in this slice: extracted orchestrator input capability calculation to `apps/web/src/features/chat/runtimeState.ts` and added spawning-policy tests.
- Surface `terminal-input-ack` failures in the terminal/chat UI or remove the unused ack if product decides it is not useful.
- Give agent transcript backfill/live merge stable cursor keys if the agent-runs audit confirms repeated identical events can collide.
- Decide whether `turn-end` and `events.jsonl` legacy fallback are retained compatibility or safe-delete candidates.

Verification commands to use before any cleanup patch:

- `pnpm --filter @pc/server test -- runtime-host-websocket-server.test.ts runtime-host-websocket-message.test.ts runtime-host-websocket-connect.test.ts runtime-host-routes.test.ts runtime-host-pty-handlers.test.ts orchestrator-send-queue-delivery.test.ts orchestrator-runtime-snapshot.test.ts session-replay.test.ts terminal-mode.test.ts web-pending-prompts.test.ts websocket-hub.test.ts`
- `pnpm --filter @pc/server typecheck`
- `pnpm --filter @pc/web typecheck`
- `git diff --check`

## Completion Criteria

Kickoff status:

- `docs/system-map.md` exists.
- `docs/pods/index.md` exists.
- This pod audit file exists and has initial ownership, workflow, dependency, drift, test, and cleanup sections.
- Runtime behavior has not been changed.
- No app, dev server, dogfood app, Vite server, channel server, or restart endpoint has been touched.

Commands run so far:

- `git worktree list --porcelain`
- `git status --short --branch`
- `git log --oneline -8`
- `git worktree add -b codex/phase-5-hardening "E:\Claude Code Projects\Personal\PC-PTY-Chat-phase5" dev`
- `pnpm install --frozen-lockfile`
- `rg --files` across server, web, DB, domain, runtime, and MCP areas.
- `rg -n` for route registrations, WebSocket surfaces, MCP tools, DB tables, runtime-host tests, and terminal/input surfaces.
- `Get-Content` for required kickoff docs and focused runtime-host, runtime, web, and agent transcript modules.
- `pnpm --filter @pc/server exec tsx --test test/runtime-host-websocket-server.test.ts test/runtime-host-websocket-message.test.ts test/runtime-host-websocket-connect.test.ts test/runtime-host-routes.test.ts test/runtime-host-pty-handlers.test.ts test/orchestrator-send-queue-delivery.test.ts test/orchestrator-runtime-snapshot.test.ts test/orchestrator-runtime-health.test.ts test/session-replay.test.ts test/terminal-mode.test.ts test/web-pending-prompts.test.ts test/websocket-hub.test.ts`
- `pnpm --filter @pc/server exec tsx --test test/web-ws-heartbeat.test.ts test/runtime-host-websocket-server.test.ts test/runtime-host-websocket-message.test.ts test/runtime-host-websocket-connect.test.ts test/runtime-host-routes.test.ts test/runtime-host-pty-handlers.test.ts test/orchestrator-send-queue-delivery.test.ts test/orchestrator-runtime-snapshot.test.ts test/orchestrator-runtime-health.test.ts test/session-replay.test.ts test/terminal-mode.test.ts test/web-pending-prompts.test.ts test/websocket-hub.test.ts`
- `pnpm --filter @pc/server exec tsx --test test/web-terminal-capabilities.test.ts test/web-ws-heartbeat.test.ts test/web-pending-prompts.test.ts test/runtime-host-websocket-message.test.ts test/terminal-mode.test.ts`
- `pnpm --filter @pc/server exec tsx --test test/web-terminal-capabilities.test.ts test/web-ws-heartbeat.test.ts test/runtime-host-websocket-server.test.ts test/runtime-host-websocket-message.test.ts test/runtime-host-websocket-connect.test.ts test/runtime-host-routes.test.ts test/runtime-host-pty-handlers.test.ts test/orchestrator-send-queue-delivery.test.ts test/orchestrator-runtime-snapshot.test.ts test/orchestrator-runtime-health.test.ts test/session-replay.test.ts test/terminal-mode.test.ts test/web-pending-prompts.test.ts test/websocket-hub.test.ts`
- `pnpm --filter @pc/server typecheck`
- `pnpm --filter @pc/web typecheck`
- `git diff --check`

Verification results:

- Focused runtime/WebSocket server tests: 58 passed, 0 failed.
- Focused runtime/WebSocket plus heartbeat tests: 61 passed, 0 failed.
- Focused terminal capability slice tests: 21 passed, 0 failed.
- Focused runtime/WebSocket plus heartbeat and terminal capability tests: 64 passed, 0 failed.
- Server typecheck: passed.
- Web typecheck: passed.
- Diff whitespace check: passed.

Manual workflow checks run:

- None yet.

Open risks:

- The first real trace still needs to be captured before choosing cleanup work.
- Client-side reconnect behavior is partly protected by pure helper logic but lacks a browser-level smoke in this audit.
- Terminal writability policy conflicts with the earlier Phase 0 wording and should be documented as an intentional product decision or revised.
