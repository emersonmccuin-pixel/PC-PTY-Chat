# Mailbox and Pending Interactions Foundation Spec

## 1. Baseline and Scope

| Field | Value |
|---|---|
| Date | 2026-05-30 |
| Branch | `dev` |
| Commit | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` |
| Inputs | `target-architecture.md`, `holistic-architecture-synthesis.md`, `implementation-roadmap.md`, `shared-contracts-and-app-services.md`, `live-events-and-outbox.md`, `refactor-tracker.md`, and synthesized subsystem handoffs |
| Artifact status | Planned foundation spec |
| Scope | Durable mailbox, recipient identity, delivery leases/retries/acks, pending-interaction ownership, UI inbox, orchestrator-turn delivery policy, Channel migration, compatibility, rollback, and tests. No implementation code changes. |

Evidence rule:

- Verified facts below come from current non-archive code inspection.
- Synthesis and recommendations come from the roadmap, foundation specs, holistic synthesis, and subsystem handoffs.
- `archive/` was not searched, read, cited, or used.

## 2. Decisions

| Decision | Status | Rationale |
|---|---|---|
| Create mailbox as the durable delivery primitive; do not add new target Channel behavior. | Accepted | Channel currently depends on live registrants and Claude development-channel notifications. Target architecture names Channel as a deletion target. |
| Keep pending interaction state separate from mailbox delivery state. | Accepted | Answer/resume/review decisions mutate agent or workflow state. Mailbox should deliver actionable references, not own those product transitions. |
| Introduce a general `pending_interactions` contract/table for new cross-system asks and reviews. | Accepted | Chat hook asks, agent `pending_asks`, workflow review gates, future human-review, and approvals share lifecycle semantics but currently live in separate mechanisms. |
| Keep `pending_asks` as the agent-run compatibility source until agent-run resume semantics are moved safely. | Accepted | Current `pending_asks` has atomic open-to-answered/cancelled guards and direct resume coupling. Replacing it in the first mailbox slice would raise risk. |
| Use a typed recipient address union, not plain `(projectId, sessionId)` strings. | Accepted | Current callers address orchestrator sessions, project-level webhooks, user decisions, agent runs, and workflow review nodes differently. A typed union makes policy explicit. |
| UI inbox is the first-class surface for user/human decisions. | Accepted | `pc_ask_user`, approvals, workflow `human-review`, and user-facing webhooks need durable actionable UI state instead of orchestrator-as-proxy as the only path. |
| Orchestrator-addressed messages deliver through the app send service facade over `orchestrator_send_queue`. | Accepted | This preserves the normal runtime turn path and avoids mid-turn out-of-band Channel delivery. |
| First orchestrator-turn delivery acknowledgement means "accepted by the app send service", with the send queue row id stored as the target reference. | Accepted for first migration | The current send queue already tracks `queued_*`, `delivered_to_pty`, `observed_in_jsonl`, `failed`, and `cancelled`. Stronger observed-in-JSONL mailbox acknowledgement can wait for the runtime transcript spec. |
| WebSocket/live events are visibility nudges, not delivery acknowledgement. | Accepted | The live-events spec explicitly separates projection facts from delivery truth. Mailbox deliveries need their own leases, attempts, acknowledgements, and dead-letter state. |
| External webhooks must be durably queued by explicit policy or rejected. | Accepted | Current `/channel/:slug/:source` can drop messages when no child is registered. Target behavior must not silently drop. |
| `human-review` is unsupported for reliable execution until mailbox-backed UI inbox/action state exists. | Accepted | Current prompts warn that standalone human-review UI is not wired. Before the inbox exists, new reliable paths should reject or disable it rather than parking with no action surface. |

## 3. Verified Current-State Evidence

| Label | Finding | Evidence |
|---|---|---|
| Verified fact | Existing packages are `agent-host`, `db`, `domain`, `mcp`, `runtime`, `utils`, and `workflows`; there is no `packages/mailbox`, `packages/contracts`, `packages/app-services`, or `packages/live` package. | `packages/` directory listing; `rg "mailbox"` across `apps` and `packages` returned no target mailbox implementation. |
| Verified fact | Agent pause state is durable in `pending_asks`. | `packages/db/src/schema-agent-system.ts:100` |
| Verified fact | Agent delivery has partial durability in `agent_inbox` and successful-delivery audit in `agent_delivery_audit`. | `packages/db/src/schema-agent-system.ts:138`, `packages/db/src/schema-agent-system.ts:169` |
| Verified fact | `pending_asks` has repo functions for create, answer, and cancel, and answer/cancel use guarded status transitions. | `packages/db/src/repos/pending-asks.ts:35`, `packages/db/src/repos/pending-asks.ts:110`, `packages/db/src/repos/pending-asks.ts:127` |
| Verified fact | `agent_inbox` can enqueue pending rows, list pending rows by `pcSessionId`, and atomically mark delivered with an audit row. | `packages/db/src/repos/agent-inbox.ts:34`, `packages/db/src/repos/agent-inbox.ts:52`, `packages/db/src/repos/agent-inbox.ts:78` |
| Verified fact | Agent delivery supports `hybrid`, `inbox-only`, and `channel-only`; `channel-only` bypasses inbox durability. | `apps/server/src/services/agent-delivery.ts:33`, `apps/server/src/services/agent-delivery.ts:35`, `apps/server/src/services/agent-delivery.ts:71` |
| Verified fact | Agent pause creates a `pending_asks` row, marks the run paused, then calls `enqueueAndPush` to deliver a channel body to the dispatcher session. | `apps/server/src/services/pause-resume.ts:105`, `apps/server/src/services/pause-resume.ts:131`, `apps/server/src/services/pause-resume.ts:146`, `apps/server/src/services/pause-resume.ts:167` |
| Verified fact | Answering a pending ask flips the row to answered before resuming the active run handle with the answer. | `apps/server/src/services/pause-resume.ts:220`, `apps/server/src/services/pause-resume.ts:251`, `apps/server/src/services/pause-resume.ts:301` |
| Verified fact | `ChannelServer` owns `/channel/:slug/:source`, `/channel-register`, a live registrant map, `emitToSession`, and `channel-event` envelopes. | `apps/server/src/services/channel-server.ts:59`, `apps/server/src/services/channel-server.ts:73`, `apps/server/src/services/channel-server.ts:115`, `apps/server/src/services/channel-server.ts:194`, `apps/server/src/services/channel-server.ts:247` |
| Verified fact | Server startup wires Channel events to project WebSocket broadcasts and drains pending `agent_inbox` rows on registration. | `apps/server/src/index.ts:267`, `apps/server/src/index.ts:272` |
| Verified fact | The per-Claude bridge registers with `/channel-register` and re-emits events as `notifications/claude/channel`. | `channel-server/server.js:64`, `channel-server/server.js:75` |
| Verified fact | Chat hook asks are in-memory: `/api/ask` stores a resolver by `toolUseId`, and WS `ask-reply` resolves it. | `apps/server/src/features/chat-bridges/routes.ts:16`, `apps/server/src/features/chat-bridges/routes.ts:122`, `apps/server/src/features/chat-bridges/routes.ts:139`, `apps/server/src/features/runtime-host/websocket-message.ts:152`, `apps/server/src/index.ts:802` |
| Verified fact | The chat bridge has a test channel proxy route that posts to `/channel/:slug/test`. | `apps/server/src/features/chat-bridges/routes.ts:76`, `apps/server/src/features/chat-bridges/routes.ts:186` |
| Verified fact | Workflow `orchestrator-review` posts through Channel, while `human-review` only emits the review-pending WebSocket event. | `apps/server/src/services/dag-run-service.ts:323`, `apps/server/src/services/dag-run-service.ts:327`, `apps/server/src/services/dag-run-service.ts:607`, `apps/server/src/services/dag-run-service.ts:618`, `apps/server/src/services/dag-run-service.ts:622` |
| Verified fact | Workflow builder prompt text says standalone `human-review` approval UI is not wired and defaults authors to `orchestrator-review`. | `apps/server/src/services/workflow-builder-pod-content.ts:90`, `apps/server/src/services/workflow-builder-pod-content.ts:91`, `apps/server/src/services/workflow-builder-pod-content.ts:93` |
| Verified fact | MCP agent ask/answer tools hand-roll HTTP calls to `/agent-pending-asks` routes. | `packages/mcp/src/tools/agent-runs.ts:486`, `packages/mcp/src/tools/agent-runs.ts:539`, `packages/mcp/src/tools/agent-runs.ts:555`, `packages/mcp/src/tools/agent-runs.ts:580` |
| Verified fact | MCP workflow review uses `pc_complete_node` over `/workflow-v2/review`. | `packages/mcp/src/tools/workflows.ts:72`, `packages/mcp/src/tools/workflows.ts:506`, `packages/mcp/src/tools/workflows.ts:533` |
| Verified fact | The current orchestrator send queue is durable and tracks queued, delivered-to-PTY, observed-in-JSONL, failed, and cancelled states. | `packages/db/src/schema.ts:412`, `packages/db/src/schema.ts:430`, `packages/db/src/repos/orchestrator-send-queue.ts:83`, `packages/db/src/repos/orchestrator-send-queue.ts:113`, `apps/server/src/services/orchestrator-send-queue-delivery.ts:73`, `apps/server/src/services/orchestrator-send-queue-delivery.ts:133` |
| Verified fact | Web has local agent pending-ask client types and calls, but no general mailbox feature folder. | `apps/web/src/features/agent-runs/client.ts:45`, `apps/web/src/features/agent-runs/client.ts:50`; `apps/web/src/features/mailbox` is missing. |
| Verified fact | No current non-archive test/spec files are discoverable. | `rg --files --glob "!archive/**" \| rg "(test\|spec)\.(ts\|tsx\|js\|mjs)$"` returned no matches. |

## 4. Boundary Rules

| Layer | Owns | Must not own |
|---|---|---|
| `packages/contracts` | Browser-safe mailbox DTOs, pending-interaction DTOs, recipient address union, enqueue/ack/list command contracts, live payload DTOs | DB access, Hono, React, Channel, runtime process handles |
| `packages/db` | Mailbox and pending-interaction schemas, repos, transaction helpers, lease queries, idempotency indexes | Business policy, prompt rendering, socket fanout |
| `packages/app-services` | `MailboxService`, `PendingInteractionService`, recipient policy, enqueue/read/action/ack commands, transactional writes, outbox event creation | WebSocket registries, React state, raw PTY sends, Channel registrants |
| Server adapters | HTTP routes, webhook routes, worker loop, runtime-turn delivery adapter, live-event fanout/legacy bridges | Product state transitions outside app services |
| Runtime send facade | Enqueue a normal orchestrator turn into the send queue and report the accepted send row | Mailbox lease/retry policy or prompt text contracts |
| Web feature | Mailbox/UI inbox client, hooks, action forms, read/dismiss state, live refetch policy | Backend route strings in components, raw mailbox event parsing in view components |
| MCP | Typed localhost client over shared mailbox/pending-interaction contracts | Independent ask/review semantics or direct DB access |

Target write flow:

```text
sender command
  -> shared contract parser
  -> PendingInteractionService when action state is needed
  -> MailboxService enqueue
  -> DB transaction
       -> pending_interactions row, when applicable
       -> mailbox_messages row
       -> mailbox_recipients rows
       -> mailbox_deliveries rows
       -> live_outbox rows for UI visibility
  -> delivery worker lease
  -> UI inbox read/action or runtime send queue acceptance
  -> mailbox ack/audit/dead-letter state
```

Mailbox is not:

- the source of agent-run status;
- the source of workflow-run state;
- the transcript store;
- a WebSocket delivery receipt;
- a prompt-text protocol;
- a replacement for `orchestrator_send_queue`.

## 5. Contracts

Recommended files:

```text
packages/contracts/src/mailbox.ts
packages/contracts/src/pending-interactions.ts
```

Recipient address:

```ts
export type MailboxAddress =
  | { kind: 'user-inbox'; userId: 'local-user'; projectId: string | null }
  | { kind: 'project-inbox'; projectId: string }
  | { kind: 'active-orchestrator'; projectId: string }
  | { kind: 'orchestrator-session'; projectId: string; sessionId: string }
  | { kind: 'agent-run'; projectId: string; agentRunId: string }
  | { kind: 'workflow-review'; projectId: string; workflowRunId: string; nodeId: string };
```

Rules:

- `user-inbox` is the first single-user/local-app address. It can evolve to real user ids later without changing message semantics.
- `project-inbox` is for external or diagnostic messages that belong to a project but are not yet assigned to a human or runtime turn.
- `active-orchestrator` resolves at delivery time to the project's active orchestrator session, if policy allows.
- `orchestrator-session` is the compatibility address for current agent dispatcher `PC_SESSION_ID` delivery.
- `workflow-review` is an action target, not a transport. It should usually produce a `user-inbox` or orchestrator-turn recipient based on node kind.

Mailbox DTOs:

```ts
export type MailboxMessageKind =
  | 'agent-question'
  | 'agent-approval'
  | 'agent-terminal'
  | 'workflow-review'
  | 'external-webhook'
  | 'runtime-hook-ask'
  | 'system-notice';

export type MailboxDeliveryChannel =
  | 'ui-inbox'
  | 'orchestrator-turn'
  | 'compat-channel';

export type MailboxDeliveryStatus =
  | 'pending'
  | 'leased'
  | 'accepted'
  | 'retrying'
  | 'failed'
  | 'dead-lettered'
  | 'cancelled';

export interface MailboxMessageDto {
  id: string;
  projectId: string | null;
  kind: MailboxMessageKind;
  subject: string | null;
  body: string;
  payload: Record<string, unknown>;
  source: { kind: string; id: string | null };
  interactionId: string | null;
  idempotencyKey: string;
  createdAt: number;
  updatedAt: number;
}

export interface MailboxRecipientDto {
  id: string;
  messageId: string;
  address: MailboxAddress;
  readAt: number | null;
  actionedAt: number | null;
  dismissedAt: number | null;
}

export interface MailboxDeliveryDto {
  id: string;
  messageId: string;
  recipientId: string;
  channel: MailboxDeliveryChannel;
  status: MailboxDeliveryStatus;
  attempts: number;
  nextAttemptAt: number | null;
  targetRef: { kind: 'send-queue' | 'ui-inbox' | 'channel' | null; id: string | null };
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}
```

Pending-interaction DTOs:

```ts
export type PendingInteractionKind =
  | 'agent-asks-orchestrator'
  | 'agent-asks-user'
  | 'agent-approval-request'
  | 'workflow-orchestrator-review'
  | 'workflow-human-review'
  | 'runtime-hook-ask';

export type PendingInteractionStatus =
  | 'open'
  | 'answered'
  | 'cancelled'
  | 'expired'
  | 'failed';

export interface PendingInteractionDto {
  id: string;
  projectId: string;
  kind: PendingInteractionKind;
  status: PendingInteractionStatus;
  source: { kind: 'agent-run' | 'workflow-run-node' | 'runtime-hook'; id: string };
  prompt: string;
  context: string | null;
  options: { value: string; label: string }[] | null;
  answer: string | null;
  answeredBy: 'orchestrator' | 'user' | null;
  createdAt: number;
  answeredAt: number | null;
  cancelledAt: number | null;
  version: number;
}
```

Compatibility mapping:

| Current shape | Target contract | First migration |
|---|---|---|
| `pending_asks` row | `PendingInteractionDto` for agent ask/approval | Adapter reads/writes `pending_asks`; optional mirror to `pending_interactions` waits for AgentRunService. |
| `agent_inbox` row | `MailboxMessageDto` plus `MailboxDeliveryDto` | Dual-write or bridge by message kind; keep current drain until cutover. |
| `workflow-v2-review-pending` event | `PendingInteractionDto` plus mailbox message | Create durable review interaction before Channel fallback. |
| `/api/ask` in-memory resolver | `runtime-hook-ask` interaction | Runtime transcript spec must define blocking response compatibility before replacing resolver. |
| `<channel>` body text | temporary prompt renderer | Keep renderers, but durable truth is structured payload plus interaction id. |

## 6. Database Model

Recommended additive tables:

```text
pending_interactions
mailbox_messages
mailbox_recipients
mailbox_deliveries
mailbox_dead_letters
mailbox_audit
```

`pending_interactions` fields:

- `id`, `project_id`, `kind`, `status`, `source_kind`, `source_id`, `source_ref_json`.
- `prompt`, `context`, `options_json`, `answer_body`, `answered_by`.
- `created_at`, `updated_at`, `answered_at`, `cancelled_at`, `expires_at`.
- `version` for live-event stale-update guards.
- Indexes on `(project_id, status, created_at)`, `(source_kind, source_id)`, and `(kind, status)`.

`mailbox_messages` fields:

- `id`, `project_id`, `kind`, `subject`, `body`, `payload_json`.
- `source_kind`, `source_id`, `interaction_id`.
- `idempotency_key`, `created_at`, `updated_at`, `expires_at`.
- Unique index on `idempotency_key`.

`mailbox_recipients` fields:

- `id`, `message_id`, `address_kind`, `address_json`.
- `read_at`, `actioned_at`, `dismissed_at`.
- Indexes on `(address_kind, message_id)`, project address fields extracted as needed, and unread UI queries.

`mailbox_deliveries` fields:

- `id`, `message_id`, `recipient_id`, `channel`, `status`.
- `lease_owner`, `lease_expires_at`, `attempts`, `next_attempt_at`.
- `target_ref_kind`, `target_ref_id`, `last_error`.
- `created_at`, `updated_at`, `accepted_at`, `failed_at`.
- Indexes on `(status, next_attempt_at)`, `(recipient_id, status)`, and `(target_ref_kind, target_ref_id)`.

`mailbox_dead_letters` fields:

- `id`, `message_id`, `recipient_id`, `delivery_id`, `reason`, `last_error`, `created_at`.

`mailbox_audit` fields:

- `id`, `message_id`, `recipient_id`, `delivery_id`, `action`, `actor_kind`, `actor_id`, `details_json`, `created_at`.

Repo rules:

- Enqueue message, recipients, deliveries, pending interaction, and live outbox rows in one transaction when they are part of one command.
- Delivery workers must acquire a lease before attempting a delivery.
- A delivery attempt must either update `accepted`, schedule retry, or write dead-letter state with an audit row.
- UI `readAt` and `actionedAt` are recipient state, not delivery state.
- Idempotency keys must be stable for replayable sources such as agent event kind plus run id plus pending ask id, workflow run plus node id, or external webhook event id.

## 7. Message Policies

| Message source | Pending interaction? | Recipient policy | Delivery channel | Compatibility |
|---|---|---|---|---|
| `pc_ask_orchestrator` | Yes, agent ask | `orchestrator-session` using dispatcher `PC_SESSION_ID` | `orchestrator-turn` | Keep `pending_asks` and Channel fallback until mailbox worker is proven. |
| `pc_ask_user` | Yes, user ask | `user-inbox`, with optional orchestrator notification only as a compatibility path | `ui-inbox` first | Current orchestrator-as-proxy stays as fallback before UI inbox exists. |
| `pc_request_approval` | Yes, human approval | `user-inbox` | `ui-inbox` | Keep `pc_answer_pending` response semantics. |
| Agent terminal/queued-started | No, unless action is needed | dispatcher `orchestrator-session` or project inbox by policy | `orchestrator-turn` or `ui-inbox` | Existing header builders can render temporary turns. |
| Workflow `orchestrator-review` | Yes, workflow review | `active-orchestrator` or selected `orchestrator-session` | `orchestrator-turn` | Keep `pc_complete_node` and review route compatibility. |
| Workflow `human-review` | Yes, workflow review | `user-inbox` | `ui-inbox` | Reject/disable reliable execution until UI inbox exists. |
| Chat `/api/ask` hook | Yes, runtime hook ask | current session UI or `user-inbox` | UI action plus blocking response | Coordinate with runtime transcript spec because the hook currently blocks on an in-memory resolver. |
| External webhook | Usually no, unless configured as action | default `project-inbox`; explicit policy may target `active-orchestrator` or `user-inbox` | `ui-inbox` or `orchestrator-turn` | `/channel` remains compatibility only until mailbox webhook route exists. |

Delivery policy rules:

- If no recipient can be resolved, return `UNSUPPORTED` or `NOT_FOUND` from the command unless the configured policy says "park in project inbox".
- Do not fan out to every orchestrator session by default. Fanout must be an explicit message policy.
- Do not treat a WebSocket live event, UI render, or chat bubble as delivery acknowledgement.
- Do not answer, resume, or complete a pending interaction during delivery. Delivery only surfaces the actionable reference.
- A repeated delivery should be safe because action commands validate the current pending-interaction state.

## 8. Orchestrator-Turn Delivery

Recommended first port:

```ts
export interface RuntimeTurnDeliveryPort {
  enqueueRuntimeTurn(input: {
    projectId: string;
    sessionId: string;
    clientMessageId: string;
    text: string;
    source: 'mailbox';
    messageId: string;
    deliveryId: string;
  }): Promise<{ ok: true; sendQueueId: string } | { ok: false; error: string; retryable: boolean }>;
}
```

Implementation guidance:

- The port should call a conversation/send service facade, not `InteractiveSession.send()` directly.
- The facade should write or reuse an `orchestrator_send_queue` row with a mailbox-derived `clientMessageId`.
- Mailbox delivery status becomes `accepted` when the send service returns a send queue row.
- Store `{ kind: 'send-queue', id: sendQueueId }` on `mailbox_deliveries.target_ref`.
- The send queue remains responsible for `queued_*`, `delivered_to_pty`, `observed_in_jsonl`, `failed`, and retry/cancel UI for the runtime turn.
- Later, the runtime transcript spec can add a stronger mailbox milestone when the send queue reaches `observed_in_jsonl`.

Temporary prompt renderer rules:

- Existing `[pc:agent-event ...]` and `[pc:workflow-review ...]` body builders can render orchestrator turns during migration.
- The renderer must include the durable `messageId` and `interactionId` when available.
- Prompt text is not the durable contract; structured payloads and action commands are.

## 9. Live Events

Mailbox should emit canonical live events for visibility only:

| Fact | Entity | Scope | Payload |
|---|---|---|---|
| `mailbox.message.changed` | `mailbox-message` | `project` when project-scoped, otherwise `global` only if safe | Message id, kind, recipient summary, unread/action state hint. |
| `mailbox.delivery.changed` | `mailbox-message` | `project` | Delivery id, status, attempts, target ref, last error summary. |
| `pending-interaction.changed` | `mailbox-message` or future `pending-interaction` entity | `project` | Interaction id, kind, status, version. |

Rules:

- Live payloads must not leak another project's message body or recipient data.
- UI inbox hooks should refetch on mailbox events first; patching can come after contract DTOs stabilize.
- Mailbox worker acknowledgement does not depend on live outbox publication.
- `channel-event` remains a legacy compatibility envelope and should not be expanded.

## 10. Migration Phases

| Phase | Goal | Files likely affected | Risk | Verification | Rollback |
|---|---|---|---|---|---|
| 0 | Restore/recreate characterization tests for Channel, `agent_inbox`, `pending_asks`, workflow review, chat `/api/ask`, and send queue behavior. | Test harness only | Low behavior risk | Tests document current drops, idempotency, and missing UI inbox behavior. | Tests only. |
| 1 | Add contracts for mailbox, pending interactions, recipient addresses, and service result shapes. | `packages/contracts/*` | Build/import risk | Contract parser and import-boundary tests. | Additive package files can be removed. |
| 2 | Add additive DB schema and repos with no active callers. | `packages/db/src/schema*`, repos, migrations | DB migration risk | Enqueue, lease, retry, ack, dead-letter, audit, and idempotency repo tests. | Additive tables can sit unused. |
| 3 | Add `PendingInteractionService` and adapters over current agent `pending_asks`. | `packages/app-services`, agent-run route adapters | Medium/high | Existing `pc_answer_pending` responses and idempotency remain unchanged. | Route back to current `pause-resume.ts`. |
| 4 | Add mailbox-backed UI inbox routes, web client/hooks, and live refetch nudges. | Server mailbox feature, web mailbox feature, live adapter | Medium | User inbox list/read/action state survives refresh and reconnect. | Hide feature and keep old chat/Activity behavior. |
| 5 | Add orchestrator-turn delivery worker over runtime send service facade. | Mailbox worker, runtime send facade, send queue adapters | High | One mailbox delivery creates at most one send queue row and records target ref. | Disable worker by message kind; keep Channel fallback. |
| 6 | Migrate agent ask/approval/terminal delivery by message kind. | `agent-delivery.ts`, `pause-resume.ts`, terminal effects, MCP typed contracts | High | Offline/unready runtime leaves delivery pending or accepted into queue; duplicate answers stay idempotent. | Feature flag back to current `enqueueAndPush` path. |
| 7 | Migrate workflow review delivery and define `human-review` behavior. | `dag-run-service.ts`, workflow review service/routes, MCP workflow tools | High | Review request is durable before run parks; `human-review` is either inbox-backed or rejected. | Keep current `orchestrator-review` Channel path temporarily. |
| 8 | Add mailbox webhook route and deprecate `/channel/:slug/:source`. | Server mailbox webhook routes, docs/prompts | Medium/high | No active-session webhook is silently dropped; unknown policy rejects explicitly. | Keep `/channel` as compatibility until callers migrate. |
| 9 | Remove Channel target paths and retire `agent_inbox` compatibility. | `apps/server/src/index.ts`, `channel-server`, runtime spawn config, DB cleanup later | High | Static search and integration tests show no target caller needs `/channel-register`, `notifications/claude/channel`, or `agent_inbox`. | Cleanup isolated after compatibility window. |

Roadmap alignment:

- Contracts depend on roadmap Phase 1.
- Live mailbox events depend on Phase 3 live-event semantics.
- Agent migration depends on agent-run service hardening enough to preserve pause/resume behavior.
- Orchestrator-turn delivery depends on conversation/send service boundaries from the runtime transcript spec.
- Channel removal waits for mailbox delivery plus UI inbox plus workflow/agent cutover.

## 11. Compatibility and Rollback

Compatibility requirements:

- Keep `pc_answer_pending` and `pc_complete_node` tool names and response compatibility.
- Keep `pending_asks` semantics until the agent-run service owns a replacement transition.
- Keep existing agent/workflow header body renderers as temporary prompt renderers.
- Keep `agent_inbox` and Channel fallback by message kind until mailbox tests pass.
- Keep `/channel/:slug/:source`, `/channel-register`, and `channel-event` only as compatibility paths during migration.
- Do not change chat `/api/ask` blocking behavior until the runtime transcript/conversation spec defines a durable replacement.
- Do not convert `human-review` into another best-effort chat prompt; either build the UI inbox action or reject/disable it.

Rollback posture:

- Contracts and DB tables are additive.
- Mailbox workers should be disabled by message kind.
- Each sender migration should support a temporary fallback to current Channel/inbox behavior.
- The first orchestrator-turn worker should use the existing send queue so it can be disabled without changing runtime send mechanics.
- Destructive removal of Channel and `agent_inbox` waits for a static-search and integration-test gate.

## 12. Acceptance Criteria

This foundation spec is build-ready when:

- Mailbox ownership is clear: messages, recipients, delivery leases, retries, acknowledgements, dead letters, and audit.
- Pending interaction ownership is clear: ask/review/approval state, answers, cancellations, and product transitions.
- Recipient identity uses a typed address union.
- UI inbox and orchestrator-turn policies are explicit.
- First orchestrator-turn acknowledgement is defined as send-service acceptance with a send queue target reference.
- External webhooks are queued by policy or rejected, never silently dropped in target paths.
- `human-review` behavior is explicit before reliable workflow execution depends on it.
- Live mailbox events are visibility facts and not delivery receipts.
- Migration, rollback, and tests are defined.

Implementation still requires user confirmation.

## 13. Test Plan

Required characterization tests before behavior changes:

- Channel:
  - sender allowlist rejects disallowed senders;
  - external post with no registrant currently drops after UI event/log;
  - `/channel-register` drain attempts pending `agent_inbox` rows;
  - `channel-only` bypasses inbox durability.
- Agent asks:
  - `recordExplicitPause` creates `pending_asks`, marks run paused, and enqueues/pushes one message;
  - duplicate `pc_answer_pending` returns already-answered or cancelled without double resume;
  - cancel without an active run has the current documented behavior.
- Workflow review:
  - `orchestrator-review` posts through Channel and emits `workflow-v2-review-pending`;
  - `human-review` can park without a wired action surface today;
  - `pc_complete_node` route accepts current approve/reject payloads.
- Chat `/api/ask`:
  - ask resolver is in-memory;
  - timeout resolves with current timeout text;
  - WS `ask-reply` resolves by `toolUseId`.
- Send queue:
  - busy/spawning/backlog sends enqueue rows;
  - direct ready sends write `delivered_to_pty`;
  - observed JSONL advances to `observed_in_jsonl`.

Required contract/repo tests:

- Recipient address parser rejects missing project/session/run/node ids.
- Enqueue command writes message, recipients, deliveries, pending interaction, audit, and live outbox rows transactionally.
- Idempotency key prevents duplicate mailbox messages for replayed agent/workflow events.
- Lease acquisition is exclusive and expires.
- Retry backoff increments attempts and schedules `nextAttemptAt`.
- Dead-letter writes a queryable dead-letter and audit row.
- UI read/action state is separate from delivery status.

Required service/integration tests after implementation starts:

- Agent `pc_ask_user` creates or maps a pending interaction, creates a UI inbox item, and `pc_answer_pending` still resumes exactly once.
- Agent `pc_ask_orchestrator` creates one mailbox delivery and one send queue row for the dispatcher session.
- Agent terminal event while runtime is unavailable stays pending or retryable until policy can accept it.
- Workflow `orchestrator-review` creates durable review state before pausing and delivers by orchestrator-turn policy.
- Workflow `human-review` is rejected before inbox support or creates an actionable UI inbox item after support.
- External webhook with no active runtime is queued to project/user inbox or explicitly rejected by policy.
- WebSocket mailbox events trigger UI refetch but do not mark messages delivered or read.
- Static search confirms migrated target paths no longer load `--dangerously-load-development-channels server:webhook`, call `notifications/claude/channel`, or require `/channel-register`.

Manual verification after implementation starts:

- Complete a background agent while the orchestrator runtime is busy; verify one queued runtime turn or one UI inbox item appears by policy.
- Answer an agent ask from the UI inbox and verify the resumed agent receives the answer once.
- Run a workflow with an orchestrator-review node and verify the review request survives refresh/reconnect.
- Try a `human-review` workflow before UI inbox support and verify it fails explicitly rather than silently parking.
- POST an external webhook with no ready runtime and verify the configured target behavior.

Current gap:

- No current non-archive tests exist, so the phase-0 test characterization plan remains a build-readiness dependency.

## 14. Observability

Recommended diagnostics:

- Message id, kind, project id, source, interaction id, idempotency key.
- Recipient id, address kind, read/action/dismiss timestamps.
- Delivery id, channel, status, attempts, lease owner, next attempt, target ref, last error.
- Pending interaction id, kind, source ref, status, version.
- Dead-letter reason and last error.
- Worker lease acquisition/release, retry decision, and disabled-by-policy decisions.

Debug surfaces:

- Mailbox inspector for pending, accepted, retrying, dead-lettered, and unread messages.
- Pending-interaction inspector grouped by agent run, workflow run/node, and runtime hook ask.
- Runtime send queue cross-link from mailbox delivery target ref.
- Static diagnostic showing whether Channel fallback is still enabled by message kind.

## 15. Open Questions

Blocking for implementation slice planning:

- What exact route shape should mailbox use first: `/api/projects/:projectId/mailbox/*`, `/api/mailbox/*`, or both project and app-level routes?
- Should the first UI inbox be project-scoped only, or include a global single-user inbox for messages without project context?
- Which first message kind should migrate after schemas exist: agent terminal, `pc_ask_orchestrator`, or workflow review?
- Should the first implementation mirror agent `pending_asks` into `pending_interactions`, or expose them through an adapter DTO without a mirror table?
- What feature flag or config key controls per-message-kind fallback to Channel during cutover?

Deferred to runtime transcript/conversation store spec:

- Whether mailbox should later wait for `observed_in_jsonl` before marking an orchestrator-turn delivery complete.
- How mailbox-created runtime turns appear in transcript replay and user-visible chat history.
- How blocking `/api/ask` hook compatibility moves from in-memory resolver to durable pending interactions.

Deferred to workflow hardening:

- Whether `pc_complete_node` should answer a `pending_interaction_id` directly or keep `(workflowRunId, nodeId)` as the stable command identity.
- How duplicate or wrong-node review decisions are rejected atomically.
- Whether `human-review` is rejected at publish time, fire time, or execution time before UI inbox support.

Non-blocking:

- Retention policy for read/actioned messages, delivery audit, and dead letters.
- Whether mailbox needs per-recipient ordering guarantees beyond `created_at` plus idempotency.
- Whether external webhook sources need authentication beyond current local allowlist semantics.
- How dead-lettered messages should be surfaced in the normal UI versus diagnostics.

## 16. Next Planning Artifact Notes

The next foundation spec, `refactor plan/foundation specs/runtime-transcript-and-conversation-store.md`, should consume these decisions:

- Orchestrator-turn delivery should call a send service facade over `orchestrator_send_queue`, not raw PTY or Channel.
- Mailbox's first runtime-turn acknowledgement is send-service acceptance; stronger observed-in-JSONL acknowledgement is deferred.
- Chat `/api/ask` is currently an in-memory blocking resolver and needs a durable pending-interaction compatibility plan.
- Mailbox messages may render temporary prompt text into chat, but transcript storage must treat the structured message id/interaction id as the durable reference once available.

