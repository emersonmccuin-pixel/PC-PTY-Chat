# Chat System Contract

Drafted: 2026-05-27

This document defines what the Caisson chat system must guarantee from the user's point of view. It is intentionally written as a product/runtime contract first, not an implementation plan.

## Scope

The chat system includes:

- The chat timeline and composer.
- Terminal mode for the same live session.
- Session start, resume, switch, replay, and refresh behavior.
- WebSocket live events.
- HTTP control and recovery APIs.
- Server runtime state for the live Claude process.
- Send queue behavior.
- JSONL transcript tailing and replay.
- Runtime status shown to the user.
- Tool, approval, workflow, and agent events rendered inside chat.
- Transient modal chats such as agent designer, workflow builder, and setup wizard.

Adjacent systems such as agent execution, workflow execution, work items, and MCP tools can emit events into chat, but chat should not own their internal rules.

## Core Principle

Chat is a durable ordered conversation between the user and an agent, with a live UI projection.

The projection may lag briefly, but it must never lie, silently drop events, reorder reality, or require manual refresh to converge on reality.

## User Needs

### 1. Every User Message Must Reach The Agent

When the user sends a message, the system must either deliver it to the agent or clearly show that it failed.

The user should never be left wondering whether a message was sent.

Acceptance criteria:

- Every user send gets a stable message id.
- The UI shows whether the message is sending, queued, delivered, observed in transcript, or failed.
- Failed sends stay visible with a reason and a retry/cancel path when possible.
- A browser refresh, WebSocket reconnect, or server restart does not create duplicate sends.

### 2. Every Agent Message Must Reach The User

When the agent produces output, the user should see it without needing to refresh.

Acceptance criteria:

- Agent output is captured from the canonical transcript/event stream.
- Live events are persisted before or at the same time they are broadcast.
- Reconnect reloads the latest persisted timeline automatically.
- If transcript capture stalls, the UI says the system is waiting for transcript data instead of pretending nothing is wrong.

### 3. Ordering Must Be Correct

The user must see events in the order they actually happened.

Acceptance criteria:

- User messages, queued sends, tool calls, agent responses, approvals, and terminal events have a consistent ordering model.
- Replay and live events dedupe by stable ids or sequence numbers.
- Reconnect cannot reorder old and new events.
- Messages sent while the agent is busy reach the agent in the same order the user sent them.

### 4. The UI Must Represent Reality

The interface should show what is really happening, not a best guess from one subsystem.

Acceptance criteria:

- There is one runtime state contract for ready, starting, thinking, waiting, queued, disconnected, exited, and failed.
- Chat composer state and terminal writability come from the same runtime truth.
- The UI cannot say "Starting..." while also allowing normal interactive input unless it explicitly labels that as raw boot terminal access.
- The UI updates after state changes without requiring a refresh.

### 5. No Silent Failure

If something breaks, the user should see it clearly.

Acceptance criteria:

- WebSocket disconnects and reconnects are visible.
- Half-open/dead WebSocket connections are detected by heartbeat or equivalent liveness checks.
- Claude process exits are visible.
- Send queue stalls are visible.
- Transcript/JSONL stalls are visible.
- Runtime failures include a reason when the system has one.

### 6. Busy-State Queueing Must Be Trustworthy

Users should be able to send follow-up messages while the agent is busy, and trust the queue.

Acceptance criteria:

- Queued messages are visible in the chat timeline or composer area.
- Queue order is visible or inferable.
- Queue delivery is automatic when the agent becomes ready.
- The queue drains completely unless a message fails.
- Queue items can be cancelled or retried when appropriate.

### 7. Recovery Must Be Automatic

The UI should recover from normal local-first failures without a manual refresh.

Acceptance criteria:

- WebSocket reconnect triggers session replay/resync.
- Session replay replaces stale local assumptions with persisted truth.
- Server restart does not permanently strand the UI.
- Laptop sleep/wake does not leave the UI in a false-open state.
- Refresh is allowed, but should not be required for correctness.

### 8. Session Continuity Must Be Clear

The user should understand which conversation they are in.

Acceptance criteria:

- New session, resumed session, active session, and past session are visually distinct.
- Switching sessions cannot leak messages from one session into another.
- A resumed session preserves history and continues from the right transcript.
- Past sessions render from persisted events, not from leftover live buffers.

### 9. Terminal And Chat Must Stay Consistent

Terminal mode is part of the chat system because it controls the same underlying session.

Acceptance criteria:

- Terminal mode and chat mode use the same session id.
- Terminal output appears in the correct session only.
- Terminal input is gated by runtime capability, not just "PTY object exists".
- Terminal transcript backfill cannot duplicate or skip live terminal bytes.
- Switching between chat and terminal does not change the actual agent state.

### 10. Progress Should Be Understandable

Long-running work should not feel frozen.

Acceptance criteria:

- Thinking state shows last activity time.
- Long tool calls show a useful progress surface when available.
- Agent dispatch, workflow events, approvals, and asks render as understandable chat events.
- "Waiting on user" and "waiting on orchestrator" are distinct from "thinking".
- A stalled turn is distinguishable from a legitimately long turn.

### 11. History Must Be Trustworthy

Chat history should be a record of what happened, not a polished fiction.

Acceptance criteria:

- Errors, interruptions, failed sends, failed tools, and runtime exits remain visible when relevant.
- Replay does not invent successful delivery for messages that never reached the transcript.
- The system can explain why a prompt is shown as pending, failed, queued, or delivered.

### 12. Performance Must Stay Bounded

Long conversations should not freeze the app.

Acceptance criteria:

- Timeline rendering is bounded or virtualized enough for long sessions.
- Replay has caps and does not block the UI indefinitely.
- Terminal output buffering is bounded.
- Large tool results are collapsed or truncated in the UI.
- Repeated state updates do not cause full-app freezes.

### 13. The System Must Be Traceable

For any message or event, we should be able to answer where it is in the pipeline.

Acceptance criteria:

- User message trace: browser created -> server received -> queued/delivered to PTY -> observed in transcript -> rendered.
- Agent message trace: transcript event -> persisted replay event -> broadcast -> rendered.
- Runtime trace: WebSocket status, PTY state, queue depth, JSONL cursor/high-water sequence, last activity time.
- Debug surfaces expose enough state to diagnose without guessing from UI symptoms.

## First Audit Questions

Use these questions to audit the current implementation:

1. What is the single source of truth for runtime state?
2. Can the UI miss a state transition?
3. Can a WebSocket be dead while the UI still says open?
4. Can a queued message remain queued after the agent is ready?
5. Can terminal input reach a session that chat says is unavailable?
6. Can replay drop, duplicate, or reorder events?
7. Can a transient modal miss the `ready` state?
8. Can an agent or workflow event appear in the wrong session?
9. Can transcript backfill duplicate live terminal bytes?
10. What does the user see when JSONL stops moving?

## Immediate Work Sequence

1. Add instrumentation for message ids, queue state, WebSocket liveness, PTY state, JSONL cursor, and replay sequence. Partially done; queue/runtime fields exist and heartbeat/reconnect diagnostics are exposed in the status footer.
2. Add WebSocket heartbeat/dead-socket detection. Done.
3. Fix transient modal state snapshots so "Starting..." cannot get stuck after the process is ready. Done.
4. Gate terminal input from the same runtime capability contract as chat input. Partially done for transient modals; fuller capability object remains.
5. Confirm send queue drains in order across multiple queued messages. Started; late-confirmation drain is tested.
6. Add replay/backfill tests for refresh, reconnect, and session switch.
7. Only then decompose the UI components and server modules.

## Definition Of Done For Chat Stability

The chat system is stable enough to refactor deeper when:

- The user can send messages during ready, busy, reconnecting, and spawning states and always sees truthful delivery state.
- Multiple queued messages arrive at the agent in order.
- Agent responses render in order without refresh.
- Sleep/wake or server restart recovers automatically or shows a clear failure state.
- Terminal mode and chat mode agree about session and writability.
- Agent designer and workflow builder modals do not get stuck on "Starting..." while terminal input works.
- A long session does not freeze the UI during live use or replay.
