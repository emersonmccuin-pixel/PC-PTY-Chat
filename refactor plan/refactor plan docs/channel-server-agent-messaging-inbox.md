# Channel Server Replacement and Agent Messaging Inbox Handoff

## 1. Executive Summary

- **Subsystem:** Channel server replacement / agent messaging inbox.
- **What it does today:** Delivers external webhook messages, workflow review prompts, and agent lifecycle/pause notifications into orchestrator Claude Code sessions through a local Channel bridge.
- **Why it matters:** Agent and workflow reliability currently depends on a live dev-channel bridge and prompt-context parsing. Missed messages can strand agents, hide workflow review gates, or leave the UI and orchestrator with different views of the same event.
- **Current health:** High risk. Agent-originated messages have a partial durable layer in `agent_inbox`, but delivery still depends on Channel registration. External webhook and workflow review messages remain direct best-effort channel posts. There is no general mailbox contract with leases, acknowledgements, retries, dead letters, or UI read state.
- **High-level recommendation:** Remove Channel entirely from the target architecture. Replace it with an app-owned mailbox, UI inbox delivery for human/user decisions, and app-injected orchestrator turns through the existing runtime send path for messages that must wake an orchestrator session.

## 2. Baseline

| Field | Value |
|---|---|
| Date | 2026-05-30 |
| Branch | `dev` |
| Commit | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` |
| Codebase state | Current implementation only. The working tree is already dirty with deleted tests/docs and untracked `refactor plan/`; this handoff changes planning docs only. |
| Assumed implemented recommendations from other docs | None. Prior subsystem docs are context only. |
| Excluded paths | `archive/` ignored entirely. |

Verified baseline notes:

- Current channel runtime is split between `apps/server/src/services/channel-server.ts` and `channel-server/server.js`.
- Existing durable-ish delivery tables are `pending_asks`, `agent_inbox`, and `agent_delivery_audit` in `packages/db/src/schema-agent-system.ts`.
- `rg --files --glob "!archive/**" | rg "(test|spec)\.(ts|tsx|js|mjs)$"` returned no executable test files in the current working tree; many tracked tests are deleted in `git status`.

## 3. Scope and Non-Goals

Included:

- `ChannelServer` HTTP/WS listener and per-session registrant map.
- Per-Claude `channel-server/server.js` stdio bridge.
- Agent delivery through `enqueueAndPush`, `agent_inbox`, `agent_delivery_audit`, and `pending_asks`.
- Workflow orchestrator-review delivery that posts to `/channel/:slug/:source`.
- External webhook entry via `/channel/:slug/:source`.
- UI visibility through `channel-event` websocket envelopes and chat parsing of `<channel>` blocks.
- No-channel migration path to a durable mailbox/message-inbox system, including UI inbox delivery and app-injected orchestrator turns.

Out of scope except as integrations:

- Full agent-run lifecycle design.
- Full workflow DAG semantics.
- Whole live-event outbox design.
- Human Review product UI, except where current code names an inbox but does not implement one.
- Desktop packaging details, except that the bridge is bundled for desktop.

Do not change casually:

- Existing Channel behavior before replacement paths exist; current users still depend on it until migration is complete.
- Existing `agent-*` and `workflow-*` header tag formats.
- `PC_SESSION_ID`, `PC_DISPATCHER_SESSION_ID`, and `pcSessionId` routing semantics.
- Current `/channel/:slug/:source`, `/channel-register`, and `/api/projects/:projectId/channel-send` call sites until they have explicit mailbox/UI inbox/runtime-turn replacements.
- Target design direction: do not add new dependencies on Claude development channels, `notifications/claude/channel`, or `/channel-register`.

## 4. Current System Trace

### 4.1 Server startup

Verified behavior:

- `apps/server/src/index.ts` constructs `ChannelServer` with `CHANNEL_PORT` defaulting to `8788`.
- `ChannelServer` is started during server boot and shut down in `gracefulShutdown`.
- `ChannelServerDeps.onEvent` broadcasts `{ type: 'channel-event', projectId, event }` through the project websocket hub.
- `ChannelServerDeps.onRegister` calls `drainPendingForSession(channelServer, projectId, sessionId, slug)` so pending `agent_inbox` rows for a registering bridge can be replayed.

Current startup flow:

```text
server boot
  -> ChannelServer starts HTTP listener on 127.0.0.1:8788
  -> Hono route POST /channel/:slug/:source is registered
  -> WebSocketServer path /channel-register is registered
  -> project runtime spawns Claude with PC_SESSION_ID
  -> Claude loads webhook MCP bridge from channel-server/server.js
  -> bridge registers (projectId, sessionId, slug)
  -> server drains pending agent_inbox rows for that recipient
```

### 4.2 Per-Claude bridge registration

Verified behavior:

- `apps/server/src/services/claude-runtime-bundle.ts::renderPcMcpBaseline` adds MCP server `webhook`, command `node`, args `channel-server/server.js`, and env `PC_PROJECT_ID`, `PC_PROJECT_SLUG`, `CHANNEL_PORT`.
- `ProjectRuntime.ensurePty()` sets `PC_SESSION_ID` in the Claude process env before spawn.
- `packages/runtime/src/pty-session.ts::buildPtySessionArgs` loads the dev channel with `--dangerously-load-development-channels server:webhook` unless disabled.
- `channel-server/server.js` requires `PC_PROJECT_ID`, `PC_PROJECT_SLUG`, and `PC_SESSION_ID`; it connects to `/channel-register?projectId=...&sessionId=...&slug=...`.
- The server-side registry key is `(projectId, sessionId)` via `registrantKey(projectId, sessionId)` in `apps/server/src/services/channel-server.ts`.

Inference:

- `PC_SESSION_ID` reaches `channel-server/server.js` by inheritance from the parent Claude process, not from the MCP server env block itself.

### 4.3 External webhook flow

Verified behavior:

- External callers POST plain text to `/channel/:slug/:source`.
- `ChannelServer` checks `X-Sender` against `CHANNEL_ALLOWED_SENDERS`; `apps/server/src/index.ts` defaults that allowlist to `test`.
- The route resolves `slug -> projectId` using `getProjectBySlug`.
- `forwardToProjectChildren(project, event)` sends the event to every live registered bridge for that project.
- The same event is broadcast to UI subscribers through `onEvent`.
- If no child is registered, the server logs a warning and drops delivery; no durable row is written.

Current normal flow:

```text
POST /channel/:slug/:source
  -> sender allowlist check
  -> getProjectBySlug(slug)
  -> build ChannelEvent
  -> sendEnvelope() to all live project registrants
  -> websocket UI channel-event broadcast
```

Current failure flow:

- Unknown slug returns `404`.
- Disallowed sender returns `403`.
- No registered child logs `[channel] no registered child ...; dropping event`.
- Bridge send exceptions are not persisted for retry.

### 4.4 Programmatic agent delivery flow

Verified behavior:

- `apps/server/src/services/agent-delivery.ts::enqueueAndPush` is the main hybrid primitive for agent -> dispatcher notifications.
- Default `PC_DELIVERY_TRANSPORT` is `hybrid`; supported modes are `hybrid`, `inbox-only`, and `channel-only`.
- In `hybrid`, `enqueueAndPush` inserts an `agent_inbox` row, calls `ChannelServer.emitToSession`, and flips the row to `delivered` plus writes `agent_delivery_audit` only when the channel push succeeds.
- In `inbox-only`, it writes the inbox row and skips Channel.
- In `channel-only`, it skips inbox writes and pushes directly to Channel.
- `drainPendingForSession` reads pending rows for a `pcSessionId`, filters to the registering project, re-sends through `emitToSession`, and marks delivered on success.

Agent pause flow:

```text
agent calls pc_ask_orchestrator / pc_ask_user / pc_request_approval
  -> MCP posts /api/projects/:projectId/agent-pending-asks
  -> recordExplicitPause()
  -> create pending_asks row
  -> mark AgentRun paused in memory and DB
  -> build [pc:agent-event ...] channel body
  -> enqueueAndPush() to dispatcher PC session
```

Agent terminal flow:

```text
AgentRun terminal event
  -> apply terminal effects and verification
  -> build agent-completed or agent-failed body
  -> enqueueAndPush() to dispatcher PC session
  -> broadcast agent-run-changed for Activity Panel separately
```

Queued-started flow:

```text
AgentRun queued-started event
  -> build agent-queued-started body
  -> enqueueAndPush() to dispatcher PC session
```

### 4.5 Pending ask answer/cancel flow

Verified behavior:

- `pending_asks` stores pause requests with `open | answered | cancelled` status.
- `pc_answer_pending` posts to `/api/projects/:projectId/agent-pending-asks/:askId/answer`.
- `answerPendingAsk` loads the row, atomically flips `open -> answered`, then looks up the active run and calls `resumeWithAnswer`.
- `pc_request_approval` and `pc_ask_user` are routed through the orchestrator-as-proxy. There is not a direct user mailbox UI yet.
- `cancelPendingAsk` flips `open -> cancelled` and calls `entry.run.cancel()` only when an active registry handle exists.

### 4.6 Workflow review delivery

Verified behavior:

- `apps/server/src/services/dag-run-service.ts::makeExecutorDeps` builds a default `postChannel` that calls `fetch("http://127.0.0.1:${channelPort}/channel/${slug}/${source}")`.
- That default `fetch` sets only `content-type: text/plain`; it does not set `X-Sender` and does not check `response.ok`.
- `apps/server/src/services/orchestrator-review-step.ts::runOrchestratorReviewStep` treats `postChannel` as successful if it resolves; it broadcasts a local `review-pending` event and returns async.
- The channel server allowlist defaults to `test`, so the default workflow channel POST can be rejected with `403` without throwing.

Inference:

- With the default allowlist, workflow orchestrator-review can appear pending in local run state while no `<channel>` prompt reaches the orchestrator.

### 4.7 UI projection and chat parsing

Verified behavior:

- `ChannelServer.onEvent` emits `channel-event` websocket envelopes to the React app.
- `channel-server/server.js` converts server WS envelopes into MCP `notifications/claude/channel` notifications. Claude then writes channel content into the session context as `<channel source="...">...</channel>`.
- `packages/runtime/src/jsonl-tailer.ts` turns Claude JSONL `type: 'user'` rows into `jsonl-user` events.
- `apps/web/src/lib/parse-chat-text.ts` parses `<channel>` blocks from user text and identifies `[pc:workflow-event ...]` and `[pc:agent-event ...]` headers.
- `apps/web/src/features/chat/toolGrouping.ts` hoists parsed workflow and agent channel events into grouped chat bubbles.
- `apps/web/src/features/chat/EventBubbles.tsx` renders generic channel blocks that are not workflow/agent events.

## 5. Integration Map

### Inbound integrations

| Caller | Contract | Current side effect | Failure boundary |
|---|---|---|---|
| External webhook/test sender | `POST /channel/:slug/:source`, text body, `X-Sender` allowlist | Sends to all live project bridges and UI WS | No durable retry; no child means drop |
| Per-Claude bridge | `WS /channel-register?projectId&sessionId&slug` | Adds one live registrant keyed by `(projectId, sessionId)` | Supersedes same key; no auth beyond env-provided ids |
| Agent pause tools | MCP -> `/agent-pending-asks` | `pending_asks` row, paused run, `agent_inbox` row, Channel push | Active registry required for pause |
| Agent terminal effects | service call to `enqueueAndPush` | `agent_inbox` row plus Channel push | Push miss remains pending only for agent path |
| Workflow orchestrator-review | direct local HTTP POST to `/channel/:slug/workflow` | Channel prompt and UI event, if accepted | Default path can ignore HTTP 403 |
| Chat test route | `/api/projects/:projectId/channel-send` | Proxies to `/channel/:slug/test` with `X-Sender: test` | Test-only shape, not mailbox-backed |
| Orchestrator MCP | `pc_answer_pending`, `pc_complete_node` | Resumes paused agent or workflow node | Delivery of the prompt is separate and best-effort |

### Outbound integrations

| Target | Caller | Contract |
|---|---|---|
| Claude dev-channel MCP | `channel-server/server.js` | `notifications/claude/channel` |
| UI WebSocket | `ChannelServer.onEvent` | legacy `channel-event` envelope |
| SQLite | `agent-delivery`, `pending-asks` repos | `pending_asks`, `agent_inbox`, `agent_delivery_audit` |
| Agent runtime | `answerPendingAsk`, `cancelPendingAsk` | active in-memory run registry and `resumeWithAnswer` |
| Workflow runtime | `pc_complete_node` after channel prompt | workflow run/node resume semantics |
| Chat renderer | Claude JSONL -> web parser | `<channel>` block text with stable headers |

### Coupling and hidden dependencies

- Channel identity uses `PC_SESSION_ID` as a recipient key; agent run identity uses `agentRunId` plus `ccSessionId`; workflow nodes use `workflowRunId/nodeId`. No shared recipient model exists.
- Agent delivery has durability only for messages that call `enqueueAndPush`; external webhooks and workflow reviews do not.
- UI sees `channel-event` separately from the durable `agent_inbox` row, so UI visibility is not an acknowledgement of delivery.
- The server process owns the channel listener, but delivery to Claude depends on a per-session stdio child spawned by Claude's MCP runtime.
- Prompt parsing of `[pc:agent-event ...]` and `[pc:workflow-event ...]` is the current business protocol for orchestrator behavior.
- `agent-delivery.ts` contains a stale comment saying the file is not wired into channel-server, but `apps/server/src/index.ts` currently wires `drainPendingForSession` on registration.

## 6. Data and State Model

### Owned durable state

| State | Storage | Notes |
|---|---|---|
| Agent pause requests | `pending_asks` | Durable question/approval state; separate from delivery row |
| Agent delivery rows | `agent_inbox` | One row per enqueued agent notification; only `pending` or `delivered` |
| Delivery audit | `agent_delivery_audit` | Written only on successful delivered flip |

### Owned in-memory state

| State | Owner | Notes |
|---|---|---|
| Channel registrants | `ChannelServer.registrants` | Map keyed by `projectId::sessionId`; rebuilds only when bridges reconnect |
| Bridge websocket connection | `channel-server/server.js` | Reconnects every 2 seconds; no local durable cursor |
| Chat ask resolvers | `InMemoryPendingAskStore` in `chat-bridges/routes.ts` | Separate orchestrator hook asks, not agent `pending_asks` |
| Active run handles | `ActiveRunRegistry` | Required for answer/resume in current agent path |

### Current schema summary

- `pending_asks`: `id`, `agentRunId`, `ccSessionId`, `projectId`, `parentWorkItemId`, `kind`, `promptBody`, `context`, `options`, `status`, answer/cancel timestamps.
- `agent_inbox`: `id`, `projectId`, `pcSessionId`, `kind`, `body`, `status`, `driver`, `createdAt`, `deliveredAt`.
- `agent_delivery_audit`: `id`, `inboxId`, `driver`, `deliveredAt`, `latencyMs`.

Concurrency and lifecycle concerns:

- `markInboxDelivered` is atomic and idempotent for one row.
- `listPendingForSession` filters only by `pcSessionId`; `drainPendingForSession` defensively skips rows from other projects.
- There is no lease owner, attempt counter, next-at timestamp, visibility timeout, or dead-letter state.
- There is no durable record of failed delivery attempts.
- `AgentInboxDriver` includes `user-prompt`, but current code found only channel-based delivery flips.

## 7. Invariants and Compatibility Requirements

Must remain true during migration:

- Existing orchestrator sessions still receive current message content until their prompt protocol is replaced; target delivery must not use `<channel>` blocks.
- `agent-asks-orchestrator`, `agent-asks-user`, `agent-approval-request`, `agent-completed`, `agent-failed`, and `agent-queued-started` headers remain parseable.
- `pc_answer_pending` remains idempotent for replayed message prompts or inbox actions.
- A replayed delivery must not resume or answer a pending ask by itself; it should only re-surface the instruction/action.
- Project scoping must prevent cross-project message leaks.
- A recipient session becoming ready should receive still-pending agent messages in order.
- External `/channel/:slug/:source` compatibility must either persist before delivery or remain explicitly best-effort until deprecated.
- UI `channel-event` broadcasts must not be treated as delivery acknowledgement.

Migration compatibility constraints:

- Mailbox acknowledgement must be tied to an explicit app-owned action: UI read/action, app service completion, accepted runtime send, or observed runtime event, depending on final policy.
- The mailbox must support recipient identifiers beyond current `pcSessionId`: orchestrator session, agent run, workflow run node, and possibly user/human-review inbox.
- The system needs prompt renderers for orchestrator turns, but those renderers should not be the durable contract.

## 8. Related Subsystem Docs

| Related subsystem | Current dependency verified in code | Recommendation in that doc | Assumed implemented? | Potential conflict | Coordination needed |
|---|---|---|---|---|---|
| WebSocket/event propagation | `ChannelServer.onEvent` emits `channel-event`; UI consumes legacy WS envelopes. | Add canonical live envelope/outbox and separate delivery truth from UI visibility. | No | Mailbox events and live UI events may duplicate if both emit independently. | Define which mailbox facts generate canonical live events. |
| Chat runtime and transcript UI | Channel messages reach chat as Claude JSONL `jsonl-user` content containing `<channel>` blocks. | Chat should be a view over durable runtime/session facts; pending asks should become durable. | No | Mailbox could own asks, or chat could own pending interactions separately. | Decide whether orchestrator hook asks and agent pending asks share a mailbox/pending-interaction model. |
| Agents and agent runs | Agent pause/terminal notices use `enqueueAndPush`; `pending_asks` and `agent_inbox` are durable. | Replace Channel/inbox hybrid with mailbox after contracts/app service. | No | Agent-run doc keeps `agent_inbox` as compatibility; this doc recommends general mailbox tables. | Preserve agent-run status and ask semantics while migrating delivery rows. |
| Workflows and workflow builder | `orchestrator-review` posts directly to `/channel/:slug/workflow`. | Not yet documented. | No | Workflow review delivery currently bypasses `agent_inbox`; mailbox scope must include workflow review prompts. | Workflow handoff must define workflow-review recipient and ack/resume semantics. |
| MCP and tooling | MCP tools create asks and answer pending rows through hand-written HTTP payloads. | Not yet documented. | No | MCP should not own separate mailbox contracts. | Shared contracts must cover mailbox, pending asks, and answer/resume commands. |

## 9. Current Issues

| Severity | Issue | Evidence | Impact | Likely root cause | Suggested fix direction |
|---|---|---|---|---|---|
| Critical | Workflow review channel POST can silently fail under the default sender allowlist. | `ChannelServer` rejects senders not in `CHANNEL_ALLOWED_SENDERS`, default `test`; `dag-run-service.ts` default `fetch` omits `X-Sender` and does not check `response.ok`. | A workflow can park at orchestrator-review while the orchestrator never receives the prompt. | Workflow delivery uses external channel HTTP as an internal bus and ignores HTTP status. | Route workflow review through an app delivery service/mailbox; immediate compatibility fix should set/check sender response before claiming async success. |
| High | External channel messages are dropped when no bridge is registered. | `forwardToProjectChildren` only sends to open registrants and logs a drop; no inbox/outbox write. | Webhooks can be lost during server startup, Claude restart, session switch, or bridge outage. | Channel server is source of truth for external delivery. | Persist inbound webhook/message events as mailbox messages before delivery fanout. |
| High | `agent_inbox` is not a full mailbox. | Schema has only `pending/delivered`, `driver`, and timestamps; no leases, attempts, retry, read state, recipient table, payload schema, or dead-letter. | Delivery can be replayed on bridge reconnect, but cannot support robust retry policies or multiple recipient types. | Incremental hardening was added around Channel instead of replacing it. | Introduce mailbox tables/services and migrate `agent_inbox` into a temporary migration view or delete it after data cutover. |
| High | Agent ask answer can consume the ask before resume is validated. | `answerPendingAsk` calls `markPendingAskAnswered` before checking active run existence/state and before `resumeWithAnswer`. | A missing handle or resume error can leave no open ask for retry. | Ask state transition and runtime resume are not one recoverable workflow. | Coordinate with agent-run service: validate resumability first or model answer/resume as a saga with recoverable states. |
| High | Cancelled asks can leave paused runs stranded when no active handle exists. | `cancelPendingAsk` marks ask cancelled, then only cancels `entry.run` if registry entry exists. | Paused DB rows may remain non-terminal without an open ask. | Delivery and run lifecycle depend on process-local state. | Make cancel a durable agent-run command that finalizes or marks recoverable without requiring a live handle. |
| Medium | Channel delivery and UI visibility are conflated in naming but not in semantics. | `emitToSession` returns delivery status for the bridge, but always calls `onEvent` for UI broadcast. | UI may show a channel event even when the recipient Claude session did not receive it. | Websocket projection is used beside delivery without an event/audit boundary. | Mailbox should emit separate `message.created`, `delivery.attempted`, `delivery.acknowledged` live events. |
| Medium | Channel bridge authentication is env/slug based and not tied to a durable recipient row. | `/channel-register` accepts query `projectId`, `sessionId`, `slug`; no DB lookup validates that the session belongs to the project. | A wrong/stale bridge can register if it has identifiers. | Registrants are runtime projections, not mailbox recipients. | Validate recipient sessions against durable session/run rows before registering or leasing messages. |
| Medium | Body format is plain-text protocol rather than structured message payload. | `agent-event-header.ts` and `workflow-event-header.ts` construct parseable prose/tag blocks. | Builders must parse prompt text to recover message kind, IDs, and action. | Channel evolved as a Claude prompt adapter. | Store structured mailbox payloads and render text only at the temporary orchestrator prompt-renderer boundary. |
| Medium | Orchestrator hook asks are a separate in-memory mechanism. | `chat-bridges/routes.ts` uses `InMemoryPendingAskStore` for `/api/ask`; agent asks use `pending_asks`. | The app has two ask systems with different durability and UI behavior. | Chat hook asks and agent asks were added through different paths. | Decide in synthesis whether mailbox owns all asks or only delivery; converge contracts. |
| Low | Delivery comments are stale. | `agent-delivery.ts` says it is "NOT wired into channel-server yet"; `index.ts` wires `drainPendingForSession` into `onRegister`. | Future agents may misread current behavior. | Planning-era comment survived implementation. | Update comments during implementation once target design is settled. |
| High | Current working tree lacks available tests. | Test file search found no executable test files; `git status` shows many deleted channel/agent/db tests. | Any mailbox migration has little regression protection. | Current checkout is in planning/reset state. | Restore or recreate focused tests before implementation changes. |

## 10. First-Principles Design

Ideal responsibility split:

- **Mailbox service:** owns message creation, recipient addressing, delivery attempts, leases, acknowledgement, retry, dead-letter, read state, and audit.
- **Application services:** agents, workflows, chat, and webhooks create domain events or commands and ask mailbox to deliver messages.
- **UI inbox delivery:** surfaces user-addressed and human-review messages with read/ack/action state.
- **Orchestrator turn delivery:** converts eligible mailbox messages into normal queued orchestrator prompts through the app runtime send path when the session is ready.
- **Live events:** project mailbox facts to UI; they do not prove delivery.
- **MCP tools:** validate shared contracts and call app services; they do not hand-roll delivery protocols.

Ideal data model:

```text
mailbox_messages
  id, project_id, sender_kind, sender_id, kind, payload_json, text_fallback,
  idempotency_key, created_at, expires_at, priority

mailbox_recipients
  id, message_id, recipient_kind, recipient_id, project_id, created_at

mailbox_deliveries
  id, message_id, recipient_id, status, lease_owner, lease_expires_at,
  attempt_count, next_attempt_at, delivered_at, acknowledged_at, read_at

mailbox_dead_letters
  id, message_id, recipient_id, reason, last_error, created_at

mailbox_audit
  id, message_id, recipient_id, action, driver, actor, at, details_json
```

Ideal command flow:

```text
agent/workflow/webhook event
  -> shared message contract validation
  -> mailbox enqueue in DB transaction
  -> live event: message.created / delivery.pending
  -> delivery policy selects UI inbox, app service command, or orchestrator runtime turn
  -> delivery worker performs the app-owned action
  -> explicit command result or observed runtime send marks delivery acknowledged
  -> retry or dead-letter on failure
```

Ideal external webhook flow:

```text
POST /api/projects/:projectId/mailbox/webhooks/:source
  -> validate sender/source
  -> persist mailbox message with project recipient policy
  -> surface in UI/project inbox or queue an orchestrator turn by policy
  -> return accepted with message id
```

Fit into existing app:

- Do not keep `ChannelServer` as a target adapter.
- Implement mailbox and no-channel delivery workers beside existing code, migrate callers, then delete `channel-server/server.js`, `ChannelServer`, `/channel*` routes, and Claude development-channel load flags.
- Keep legacy body/header builders only as temporary prompt renderers for app-injected orchestrator turns until structured UI surfaces replace them.
- Keep `pending_asks` as the current source of agent pause answer state, while mailbox owns delivery of the prompt.

## 11. Target Architecture Alignment

| Target cartridge part | Current alignment | Gap |
|---|---|---|
| contracts | Partial domain types in `agent-comms.ts` / `agent-system.ts` | No shared mailbox command/query/event schemas |
| domain | Agent ask and event kinds exist | Delivery state machine is not modeled as domain |
| db repo | `agent_inbox`, `agent_delivery_audit`, `pending_asks` repos exist | No general mailbox repos, leases, recipients, retries, dead letters |
| application service | `enqueueAndPush` is a primitive; agent services call it | No mailbox service; workflows bypass it |
| HTTP route | `/channel/:slug/:source` and pending-ask routes exist | Channel route is direct delivery, not mailbox enqueue |
| live events | `channel-event` UI broadcast exists | Not canonical, durable, or delivery-aware |
| web client/hooks | Chat parses channel text; Activity Panel uses separate agent-run hooks | No mailbox inbox UI/client/read state |
| MCP adapter | `pc_answer_pending` and pause tools exist | Hand-written payloads; no mailbox tools/contracts |
| tests | Deleted/unavailable in current tree | Need focused characterization coverage |

Cross-cutting target systems:

- **Shared contracts:** Missing for mailbox messages, recipients, deliveries, asks, and review prompts.
- **Canonical live events:** Missing; `channel-event` is a legacy projection.
- **Durable mailbox:** Partially present only as `agent_inbox`; target not implemented.
- **Runtime host boundary:** Target delivery should use the app runtime send queue/service, not Claude dev-channel loading.
- **MCP adapter boundary:** MCP is tied to HTTP payloads and prompt text protocol.
- **UI fetch discipline:** No mailbox feature client/hook exists; target UI inbox should read mailbox state directly instead of inferring delivery from chat text.

Conflicts/uncertainties for synthesis:

- Whether `pending_asks` should merge into mailbox or remain a domain table referenced by mailbox messages.
- Whether external webhooks address all active orchestrator sessions, the active session only, a project feed, or a user inbox.
- Whether workflow `human-review` belongs to the same mailbox as agent asks.
- Which current `/channel` callers need temporary shims before deletion.

## 12. Recommended Target Architecture

Keep:

- Existing `agent-*` and `workflow-*` body builders only as temporary prompt renderers for app-injected orchestrator turns.
- `pending_asks` for pause/answer state until the agent-run service is refactored.
- `agent_inbox` only as an interim migration source or compatibility view while mailbox tables are introduced.

Replace:

- Direct `/channel` delivery as source of truth with mailbox enqueue.
- `channel-server/server.js`, `ChannelServer`, `/channel-register`, `/channel/:slug/:source`, and `--dangerously-load-development-channels server:webhook` in the target runtime.
- `agent_inbox` as the long-term mailbox schema.
- Best-effort workflow review channel posts with durable workflow review messages.
- In-memory channel registrants as recipient truth.
- `PC_DELIVERY_TRANSPORT=channel-only` with explicit mailbox delivery policies.

Split:

- Delivery state from UI visibility.
- Structured message payloads from Claude prompt text.
- Recipient registration from recipient identity.

Proposed module boundaries:

```text
packages/contracts/src/mailbox.ts
packages/domain/src/mailbox.ts
packages/db/src/repos/mailbox.ts
packages/app-services/src/mailbox.ts
apps/server/src/features/mailbox/routes.ts
apps/server/src/features/mailbox/ui-inbox-delivery.ts
apps/server/src/features/mailbox/orchestrator-turn-delivery.ts
apps/server/src/features/mailbox/webhook-routes.ts
apps/web/src/features/mailbox/client.ts
apps/web/src/features/mailbox/hooks.ts
packages/mcp/src/tools/mailbox.ts
```

No-channel delivery adapters:

- `enqueueAndPush` becomes a wrapper around `MailboxService.enqueue` plus a delivery policy; after migration, remove the old name.
- User-addressed asks, workflow reviews, and external messages surface through a mailbox-backed UI inbox.
- Eligible orchestrator-addressed messages enqueue a normal runtime turn through a service facade over the existing send queue.
- External webhooks enter through mailbox routes and never through `/channel` in the target.
- Legacy `channel-event` WS broadcasts are replaced by canonical mailbox/live events; websocket remains visibility/nudge only.

Decisions requiring holistic synthesis:

- Final mailbox recipient ID model.
- Whether chat `/api/ask` durable pending interactions use mailbox tables.
- Live-event envelope and cursor shared with mailbox audit.
- Human Review inbox ownership and UX.

## 13. Migration Strategy

| Phase | Goal | Files likely affected | Dependencies | Risks | Verification | Rollback | Restart/reload |
|---|---|---|---|---|---|---|---|
| 0 | Restore characterization tests for current Channel/inbox behavior and document delete candidates. | `apps/server/test/*channel*`, `apps/server/test/agent-delivery.test.ts`, `packages/db/test/agent-inbox.test.ts`, `packages/mcp/test/agent-runs-tools.test.ts` | Test tree decision | Current tests are deleted | Tests cover current register, drain, allowlist, enqueue, answer/cancel failure modes | Docs only or tests only | No app restart; test process only |
| 1 | Define no-channel delivery policy and freeze new Channel uses. | contracts/design docs, lint/search checks if available | Phase 0 preferred | Ambiguous recipient policy | Every message kind maps to UI inbox, app service command, or orchestrator turn | Revert policy docs/checks | None for docs/checks |
| 2 | Introduce mailbox contracts and DB schema beside `agent_inbox`. | new contracts/domain/db repos/migrations | Shared contract package decision | Schema migration | Repo tests for enqueue/lease/ack/retry/dead-letter/read state | Keep existing runtime behavior active | DB migration/server restart |
| 3 | Add mailbox-backed UI inbox and live nudges. | `apps/server/src/features/mailbox/*`, `apps/web/src/features/mailbox/*`, live events | Live-event plan | UI duplication with chat bubbles | User/human-review messages are visible, scoped, readable, actionable, and replayable after reconnect | Hide new UI behind flag | Server/web reload |
| 4 | Add orchestrator-turn delivery worker using the existing runtime send queue/service. | runtime send service facade, mailbox worker, agent/workflow renderers | Runtime host interfaces | Mid-turn injection or duplicate prompts | Worker queues only when session is ready; no dev-channel path; ack semantics are tested | Disable delivery policy for orchestrator turns | Server reload |
| 5 | Move agent pause, terminal, and queued-started delivery to mailbox policy. | `agent-delivery.ts`, `pause-resume.ts`, `agent-run-terminal-effects.ts`, `agent-run-factory.ts` | Phases 2-4 | Duplicate delivery during cutover | Idempotency-key tests; offline session persists and later injects one runtime turn or UI inbox item | Feature flag back to current agent delivery temporarily | Server reload |
| 6 | Move workflow orchestrator-review and external webhooks to mailbox routes. | `dag-run-service.ts`, `orchestrator-review-step.ts`, new mailbox webhook routes | Workflow plan and recipient policy | Review gates can strand runs if wrong | Review waits on durable inbox/turn state; webhook with no active session is queued or explicitly rejected by policy | Feature flag route back temporarily | Server reload |
| 7 | Remove Channel runtime from active target paths. | `apps/server/src/index.ts`, `apps/server/src/services/channel-server.ts`, `channel-server/server.js`, runtime spawn env | All callers migrated | Hidden caller still posts to `/channel` | No code path loads `--dangerously-load-development-channels server:webhook`; no active caller requires `/channel-register` or `notifications/claude/channel` | Re-enable old branch only as emergency rollback, not target design | Server/runtime reload |
| 8 | Migrate/delete `agent_inbox` compatibility storage. | DB migrations, mailbox repos, docs | Phase 7 | Data migration mistakes | No code path inserts `agent_inbox`; mailbox owns all delivery state and audit | Read-only migration view if needed | DB/server reload |

## 14. Acceptance Criteria

Functional:

- Agent pause, terminal, and queued-started messages persist before delivery attempts.
- Workflow orchestrator-review prompts cannot be marked delivered until the mailbox delivery policy has created the UI inbox item or accepted the orchestrator runtime turn.
- External webhook messages are either durably queued or explicitly rejected by recipient policy; they are not silently dropped.
- Runtime reconnect/session readiness delivers pending orchestrator-addressed messages exactly once per recipient unless intentionally re-delivered.
- `pc_answer_pending` remains safe under duplicate/replayed prompt text.

Integration:

- Agents, workflows, external webhooks, UI, and MCP use shared mailbox or pending-ask contracts for migrated paths.
- Delivery acknowledgement is separate from UI websocket projection.
- No target code path depends on `notifications/claude/channel`, `/channel-register`, or `--dangerously-load-development-channels server:webhook`.
- `channel-event` is replaced by canonical mailbox/live events for migrated UI surfaces.
- Recipient identity is validated against durable session/run/workflow state.

Regression:

- Existing agent/workflow grouped UI behavior is preserved or intentionally moved to the mailbox inbox/activity surfaces.
- `PC_DELIVERY_TRANSPORT=channel-only` is removed or ignored after migrated paths are proven.
- Background agent completion can wake the dispatcher session by a normal queued runtime turn when policy requires it, without development channels.
- Paused asks cannot be answered twice.

Observability/debuggability:

- Every message has a message id, recipient id, delivery status, attempt count, last error, and audit trail.
- UI inbox and orchestrator-turn delivery logs include message id, recipient id, and runtime/session target when applicable.
- UI can distinguish message created, delivery accepted by the selected target, acknowledged/read, failed, and dead-lettered.

Reliability:

- Retry policy is bounded and inspectable.
- Dead-letter state is queryable.
- No important delivery state exists only in `ChannelServer.registrants`.
- No target delivery state exists only inside a runtime process or websocket connection.

## 15. Test Plan

Existing tests in this working tree:

- No executable test/spec files are present outside `archive/`.
- `git status` shows deleted historical tests including `agent-delivery.test.ts`, `agent-inbox.test.ts`, `pending-asks.test.ts`, `orchestrator-review-step.test.ts`, and many agent/runtime route tests.

Required unit tests:

- Current Channel characterization before deletion:
  - rejects disallowed senders;
  - documents current register/drain behavior;
  - documents current workflow review failure mode when no `X-Sender` is supplied.
- `agent-delivery`:
  - migrated path persists mailbox before any delivery attempt;
  - idempotency key suppresses duplicate prompts/inbox items;
  - offline or unready runtime leaves delivery pending;
  - no migrated mode requires `channel-only`.
- `pending-asks`/pause-resume:
  - duplicate answer is idempotent;
  - missing active run does not consume a retryable ask after target refactor;
  - cancel without active handle has documented run outcome.
- mailbox service after introduction:
  - enqueue idempotency;
  - lease expiration;
  - ack;
  - retry/backoff;
  - dead-letter;
  - recipient scoping.
- UI inbox delivery:
  - create/read/action state is durable;
  - websocket nudges do not imply acknowledgement;
  - reconnect/replay fetches current mailbox state.
- orchestrator-turn delivery:
  - queues only through the runtime send service facade;
  - does not inject mid-turn;
  - acknowledges only after the chosen acceptance point, such as queued, sent to PTY, or observed in JSONL;
  - retries or dead-letters if the runtime never becomes ready.

Required integration tests:

- Agent pause -> mailbox row -> UI inbox item or orchestrator runtime turn -> `pc_answer_pending` resume.
- Agent terminal with runtime offline/unready -> readiness returns -> one queued runtime turn or inbox item is delivered.
- Workflow orchestrator-review cannot park silently; it must have durable inbox/turn state or fail explicitly.
- External webhook with no active runtime persists to the selected inbox or is explicitly rejected by policy.
- UI websocket shows mailbox/message state without implying ack.
- Search/static check proves migrated paths do not load `--dangerously-load-development-channels server:webhook` or call `notifications/claude/channel`.

Manual verification:

- Start an orchestrator session, dispatch an async agent, and observe queued/terminal delivery through mailbox-backed UI inbox or a normal queued orchestrator turn.
- Stop using the Channel bridge path, complete an agent while runtime delivery is unavailable, restore readiness, and confirm pending message replay exactly once.
- Run a workflow with an orchestrator-review node and verify the review prompt reaches the mailbox-backed action surface or orchestrator turn by policy.
- POST a test webhook while no runtime session is ready and confirm target behavior: persisted for later or rejected.
- Answer an agent ask twice and confirm the second call returns the expected idempotent error.

Known hard-to-test areas:

- Runtime send acceptance timing and whether ack should mean queued in app DB, written to PTY, or observed in provider JSONL.
- Server crash after mailbox enqueue but before delivery attempt.
- Runtime readiness/reconnect races while a delivery worker is draining pending messages.
- Multiple orchestrator sessions for one project and the intended fanout semantics.

## 16. Implementation Notes for Next Agent

Recommended starting point:

1. Restore or recreate focused tests that characterize current Channel behavior and lock the no-channel target policy.
2. Define recipient policy for UI inbox versus orchestrator runtime turn before adding mailbox schema.
3. Introduce mailbox contracts and repo APIs without deleting `agent_inbox`.
4. Build UI inbox delivery and orchestrator-turn delivery workers before cutting callers away from Channel.
5. Migrate agent delivery first because it already has the closest durable shape.
6. Migrate workflow review and external webhooks after recipient semantics are explicit.
7. Delete Channel runtime paths only after migrated callers pass the mailbox acceptance tests.

Risky files to inspect before editing:

- `apps/server/src/index.ts`
- `apps/server/src/services/channel-server.ts`
- `channel-server/server.js`
- `apps/server/src/services/agent-delivery.ts`
- `packages/db/src/schema-agent-system.ts`
- `packages/db/src/repos/agent-inbox.ts`
- `packages/db/src/repos/pending-asks.ts`
- `apps/server/src/services/pause-resume.ts`
- `apps/server/src/services/agent-run-terminal-effects.ts`
- `apps/server/src/services/agent-run-factory.ts`
- `apps/server/src/services/dag-run-service.ts`
- `apps/server/src/services/orchestrator-review-step.ts`
- `apps/web/src/lib/parse-chat-text.ts`
- `apps/web/src/features/chat/toolGrouping.ts`

Patterns to follow:

- `markInboxDelivered` transactionally flips status and writes audit.
- Existing `[pc:agent-event ...]` and `[pc:workflow-event ...]` headers can be temporary prompt renderers for app-injected orchestrator turns.
- `pending_asks` atomic `WHERE status='open'` transitions guard replay.

Things to avoid:

- Do not make websocket or Channel registration the durable source of delivery truth.
- Do not design new Channel compatibility as part of the target.
- Do not delete current Channel runtime before UI inbox and orchestrator-turn replacements pass acceptance; deletion is the target, not the first step.
- Do not encode new mailbox semantics only as prose in channel bodies.
- Do not silently merge `pending_asks` into mailbox without deciding answer/resume ownership.
- Do not use `archive/` to recover tests or evidence.

## 17. Handoff Metadata

| Field | Value |
|---|---|
| Subsystem | Channel server replacement / agent messaging inbox |
| Primary owner area | current `apps/server/src/services/channel-server.ts` and `channel-server/server.js` as deletion candidates; `apps/server/src/services/agent-delivery.ts`, `packages/db`, future `packages/mailbox`/`packages/contracts` |
| Runtime process | Target: server mailbox delivery worker plus existing runtime send service; current: server process plus per-Claude MCP stdio bridge spawned by Claude |
| Owns state | Target: mailbox messages, recipients, deliveries, read/action state, audit, dead letters; current: Channel registrants, `agent_inbox`, `agent_delivery_audit` |
| Reads state from | `projects`, `orchestrator_sessions` via env/session identity, `agent_runs`, `pending_asks`, workflow run state |
| Writes state to | Target: mailbox tables, `pending_asks` references/status, canonical live events; current: `agent_inbox`, `agent_delivery_audit`, WebSocket `channel-event`, Claude dev-channel notifications |
| Inbound contracts | Target: mailbox enqueue/routes, mailbox webhook routes, agent pending-ask routes, workflow review commands, MCP `pc_answer_pending`; current: `/channel/:slug/:source`, `/channel-register`, workflow postChannel |
| Outbound contracts | Target: UI inbox state, canonical mailbox/live events, runtime send queue/service, agent/workflow header prompt renderers where still needed; current: `notifications/claude/channel`, `<channel>` text blocks, UI `channel-event` |
| Hard dependencies | SQLite, Hono, `ws`, runtime send service, `PC_SESSION_ID`, project/session registry |
| Soft dependencies | WebSocket/live-event subsystem, chat renderer, Activity Panel, workflow review, MCP tools |
| Restart required for implementation changes | Server reload for server/mailbox changes; runtime session reload only while current Channel bridge remains; DB migration for mailbox tables |
| Migration risk | High |
| Target architecture status | Replace and delete Channel/dev-channel bridge; mailbox plus UI inbox and app-injected orchestrator turns are the target |
| Related docs consulted | `target-architecture.md`, `subsystem-architecture-handoff-prompt.md`, `refactor-tracker.md`, `ui-refresh-websocket-event-propagation.md`, `chat-runtime-and-transcript-ui.md`, `agents-and-agent-runs.md` |

## 18. Tracker Update

Update `refactor plan/refactor-tracker.md`:

- Set `Channel server` status to `needs synthesis`.
- Baseline branch: `dev`.
- Baseline commit: `d114fc2535c1116f6eb2d883f9cac2a9193a8254`.
- Owner area: `apps/server`, `channel-server`, `packages/db`, `packages/domain`, future `packages/contracts`/`packages/mailbox`.
- Runtime process: target server mailbox worker and runtime send service; current per-Claude Channel bridge is legacy code to delete.
- Migration risk: high.
- Target recommendation: replace with durable mailbox/message-inbox, UI inbox delivery, and app-injected orchestrator turns; delete Channel/dev-channel bridge.
- Dependencies/open questions: live-event outbox, chat pending interactions, agent-run pause/resume, workflow review delivery, MCP contracts, recipient identity model, human review inbox.

## 19. Open Questions

Blocking or near-blocking:

- What is the canonical recipient identity: orchestrator PC session, user, agent run, workflow run node, project feed, or a typed union of all of them?
- Should `pending_asks` become part of mailbox, or should mailbox only deliver references to pending-interaction rows?
- What acknowledgement means for an app-injected orchestrator turn: queued in app DB, written to PTY, observed in provider JSONL, or explicit recipient tool ack?
- Should external webhooks fan out to every live orchestrator session, only the active session, or a durable project inbox?

Non-blocking but important:

- How long should mailbox messages be retained after ack/read?
- Should duplicate orchestrator-turn replays be suppressed by idempotency key in the prompt renderer, runtime send queue, or mailbox layer?
- Should `PC_DELIVERY_TRANSPORT` remain during migration only, and when is it deleted?

Product/design decisions:

- Does the user need a first-class "Waiting on you" inbox that includes agent asks, workflow human-review gates, and external webhooks?
- Should generic external webhook messages appear in chat, an inbox, or both?
- How should dead-lettered agent/workflow messages be surfaced to the user?

Builder-discretion decisions:

- Exact mailbox table names, if they preserve message/recipient/delivery/audit/dead-letter separation.
- Whether `agent_inbox` is dual-written, migrated into mailbox rows, or wrapped by a compatibility repo during the first phase.
- Whether the first orchestrator-turn delivery worker writes directly to `orchestrator_send_queue` or calls a service facade over runtime send.
