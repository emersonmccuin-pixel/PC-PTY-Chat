// Section 16b — Agent comms primitives (contract layer).
//
// Five MCP tools (`pc_invoke_agent`, `pc_ask_orchestrator`, `pc_ask_user`,
// `pc_request_approval`, `pc_answer_pending`) + five channel-event kinds
// (`agent-asks-orchestrator`, `agent-asks-user`, `agent-approval-request`,
// `agent-completed`, `agent-failed`). Pause-state persisted in
// `pending_asks` (table lands in 16b.2).
//
// Pause semantics (locked in Planning 2026-05-20):
// - `pc_invoke_agent` is NOT a pause kind. With `wait: true` the caller blocks
//   inside its own turn until the child returns. With `wait: false` the call
//   returns immediately and an `agent-completed` / `agent-failed` event lands
//   on the caller's stream when the child finishes.
// - `pc_ask_orchestrator` / `pc_ask_user` / `pc_request_approval` ARE pause
//   kinds. Tool returns a pending-ask handle; the agent's process exits
//   cleanly at turn end; runtime re-spawns with `--resume <sessionId>` once
//   the answer lands and writes the answer as the next user message.
// - `pc_answer_pending` is the orchestrator's tool to resume a paused agent.

import type { ULID } from './ulid.ts';

// ─── Pending-ask state (rows in `pending_asks`, 16b.2) ────────────────────

/** Which of the three pause primitives produced this row. `pc_invoke_agent`
 *  does NOT mint a pending-ask — sync waits block in-turn; async waits track
 *  via the spawned run-id, not via a pending-ask. */
export type PendingAskKind = 'ask-orchestrator' | 'ask-user' | 'approval';

export const PENDING_ASK_KINDS: readonly PendingAskKind[] = [
  'ask-orchestrator',
  'ask-user',
  'approval',
];

/** Lifecycle of a pending-ask. `waiting` is the only state that admits an
 *  answer; `answered` + `cancelled` are terminal. Status check on the
 *  orchestrator side prevents double-answering when JSONL replay re-fires an
 *  already-handled event. */
export type PendingAskStatus = 'waiting' | 'answered' | 'cancelled';

export const PENDING_ASK_STATUSES: readonly PendingAskStatus[] = [
  'waiting',
  'answered',
  'cancelled',
];

/** A paused agent waiting on a single question. One CC session can mint
 *  many pending-asks over its lifetime. Audit + answer routing key off
 *  `pendingAskId`, not `sessionId`. */
export interface PendingAsk {
  /** PC-minted ULID. The handle the orchestrator passes to
   *  `pc_answer_pending` to resume the agent. */
  id: ULID;
  /** CC session-id of the paused agent. Used by the resume primitive
   *  (`--agent <name> --resume <sessionId>`). One session, many pending-asks
   *  over time. */
  sessionId: string;
  /** Pod-row name of the paused agent (orchestrator includes this when
   *  formatting the question for the user). */
  agentName: string;
  /** Project this pause belongs to. Required for cross-project bell badges
   *  + project-scoped lists. */
  projectId: ULID;
  /** Optional: the parent agent run that owns this pause. Populated when the
   *  pause originates inside a tracked agent-run row (16b.2). NULL for
   *  orchestrator-direct pauses. */
  runId: ULID | null;
  /** Optional: the work-item the paused agent is operating on (taken from
   *  the spawning context). Drives Activity Panel filtering + bell scoping. */
  parentWorkItemId: ULID | null;
  kind: PendingAskKind;
  /** The question / decision text the agent surfaced. */
  question: string;
  /** Free-form context payload — recent transcript snippet, files inspected,
   *  candidate options. Orchestrator decides how much to surface. */
  context: string | null;
  /** Multi-choice options for `approval` (and optionally `ask-user`).
   *  Null for free-form text answers. */
  options: PendingAskOption[] | null;
  status: PendingAskStatus;
  /** The answer once the orchestrator resolves the pause. NULL while
   *  `status === 'waiting'`. */
  answer: string | null;
  /** Who answered. `'orchestrator'` for answers the orchestrator produced
   *  from its own context; `'user'` for answers it forwarded via
   *  `pc_ask_user` / `pc_request_approval`. NULL while waiting. */
  answeredBy: 'orchestrator' | 'user' | null;
  createdAt: number;
  answeredAt: number | null;
  cancelledAt: number | null;
}

/** One choice in an `options` list. `value` is what `pc_answer_pending`
 *  passes back as the answer; `label` is the user-facing string. */
export interface PendingAskOption {
  value: string;
  label: string;
}

// ─── Channel-event kinds (`agent-*` envelope on `<channel ...>` blocks) ───

/** Five new event kinds emitted by the agent runtime to either the
 *  orchestrator's stream (when an agent is asking) or the caller's stream
 *  (when a background-dispatched agent terminates). All ride the existing
 *  channel-server forwarder — agent processes register against
 *  `/channel-register` exactly like the per-project orchestrator does. */
export type AgentChannelEventKind =
  | 'agent-asks-orchestrator'
  | 'agent-asks-user'
  | 'agent-approval-request'
  | 'agent-completed'
  | 'agent-failed';

export const AGENT_CHANNEL_EVENT_KINDS: readonly AgentChannelEventKind[] = [
  'agent-asks-orchestrator',
  'agent-asks-user',
  'agent-approval-request',
  'agent-completed',
  'agent-failed',
];

/** Common fields every `agent-*` event carries. Concrete payloads extend
 *  this. `at` is epoch-ms of the event's emission. */
interface AgentEventCommon {
  pendingAskId: ULID | null;
  sessionId: string;
  agentName: string;
  runId: ULID | null;
  parentWorkItemId: ULID | null;
  at: number;
}

/** A paused agent asking the orchestrator. Orchestrator's handler protocol
 *  entry #1: read question + context, answer via `pc_answer_pending` if
 *  context-known, else escalate via `pc_ask_user`. */
export interface AgentAsksOrchestratorPayload extends AgentEventCommon {
  kind: 'agent-asks-orchestrator';
  pendingAskId: ULID;
  question: string;
  context: string | null;
}

/** A paused agent asking the user (delivered via orchestrator-as-proxy).
 *  Orchestrator's handler protocol entry #2: render via chat surfaces;
 *  forward the user's reply via `pc_answer_pending`. */
export interface AgentAsksUserPayload extends AgentEventCommon {
  kind: 'agent-asks-user';
  pendingAskId: ULID;
  question: string;
  context: string | null;
  options: PendingAskOption[] | null;
}

/** A paused agent requesting human approval. Orchestrator's handler
 *  protocol entry #3: render the approval gate; forward decision via
 *  `pc_answer_pending`. Reuses the existing approval-bubble surface. */
export interface AgentApprovalRequestPayload extends AgentEventCommon {
  kind: 'agent-approval-request';
  pendingAskId: ULID;
  decision: string;
  options: PendingAskOption[];
  context: string | null;
}

/** A background-dispatched agent finished successfully. Orchestrator's
 *  handler protocol entry #4: start a new turn surfacing the result with
 *  enough context to remind the user what was originally asked. */
export interface AgentCompletedPayload extends AgentEventCommon {
  kind: 'agent-completed';
  /** The originating `pc_invoke_agent` call's run-id (per 16b.2). */
  runId: ULID;
  /** Whatever the child returned (free-form text or JSON-encoded string). */
  result: string;
}

/** A background-dispatched agent failed. Orchestrator's handler protocol
 *  entry #5: surface failure + suggest a next step (retry / drop /
 *  hand-write). */
export interface AgentFailedPayload extends AgentEventCommon {
  kind: 'agent-failed';
  runId: ULID;
  /** One-line failure summary. */
  reason: string;
  /** Optional structured error code. Matches the values the orchestrator pod
   *  prompt's handler-protocol §5 documents. `error` stays as the catch-all
   *  for anything the runtime can't classify (e.g. unexpected exceptions). */
  cause:
    | 'timeout'
    | 'loop-cap'
    | 'depth-cap'
    | 'cancelled'
    | 'unknown-agent'
    | 'spawn-failed'
    | 'error'
    | null;
}

export type AgentChannelEventPayload =
  | AgentAsksOrchestratorPayload
  | AgentAsksUserPayload
  | AgentApprovalRequestPayload
  | AgentCompletedPayload
  | AgentFailedPayload;

// ─── Section 18 — Inbox + delivery audit (hybrid transport) ───────────────
//
// The inbox is the durability layer of the hybrid: every agent → orchestrator
// event lands as an `agent_inbox` row before any best-effort channel push.
// The `agent_delivery_audit` table records per-event delivery telemetry —
// how the event eventually reached the orchestrator (autonomous channel push
// vs caught on the next user prompt by the UserPromptSubmit hook drain).
//
// `AgentInboxEventKind` is a superset of `AgentChannelEventKind`: drops
// `agent-asks-user` (architecture-review merge into `agent-asks-orchestrator`)
// and adds two dispatch-contract events (`agent-acked` for ack-pattern
// fire-after-confirm, `agent-queued-started` for over-cap dispatches that
// fire later when the queue drains).

/** Event-kind tag stored in `agent_inbox.event_kind`. Superset of the wire
 *  `AgentChannelEventKind` — adds dispatch-contract events that are
 *  inbox-only (never originate from a child agent). */
export type AgentInboxEventKind =
  | 'agent-acked'
  | 'agent-completed'
  | 'agent-failed'
  | 'agent-asks-orchestrator'
  | 'agent-approval-request'
  | 'agent-queued-started';

export const AGENT_INBOX_EVENT_KINDS: readonly AgentInboxEventKind[] = [
  'agent-acked',
  'agent-completed',
  'agent-failed',
  'agent-asks-orchestrator',
  'agent-approval-request',
  'agent-queued-started',
];

/** Lifecycle of an inbox row. `pending` admits draining (channel push or hook
 *  prepend); `delivered` is terminal. Status check prevents double-delivery
 *  when both transports race. */
export type AgentInboxStatus = 'pending' | 'delivered';

export const AGENT_INBOX_STATUSES: readonly AgentInboxStatus[] = [
  'pending',
  'delivered',
];

/** How an inbox row eventually reached the orchestrator. `'autonomous'` =
 *  channel push delivered while the orchestrator was idle (woke it up).
 *  `'user-prompt'` = channel didn't deliver in time; UserPromptSubmit hook
 *  drained the row as preamble on the next prompt. `'unknown'` covers
 *  recorded-but-not-yet-routed rows (e.g. immediately after enqueue). */
export type AgentDeliveryDriver = 'autonomous' | 'user-prompt' | 'unknown';

export const AGENT_DELIVERY_DRIVERS: readonly AgentDeliveryDriver[] = [
  'autonomous',
  'user-prompt',
  'unknown',
];

/** One inbox row. Matches the `agent_inbox` table shape. */
export interface AgentInboxRow {
  id: ULID;
  projectId: ULID;
  /** CC sessionId of the orchestrator that should receive this event. */
  recipientSessionId: string;
  eventKind: AgentInboxEventKind;
  /** Pre-rendered `<channel>...</channel>` body, ready to splice into a
   *  prompt or push via channel. Authored at enqueue time so the drain
   *  paths don't have to re-render. */
  payloadBody: string;
  status: AgentInboxStatus;
  createdAt: number;
  /** null until status flips to `'delivered'`. */
  deliveredAt: number | null;
}

/** One audit row. Matches the `agent_delivery_audit` table shape. Records
 *  the validation-pass's success metric: how often does the channel push
 *  autonomously wake the orchestrator vs the user-prompt fallback. */
export interface AgentDeliveryAuditRow {
  id: ULID;
  inboxId: ULID;
  channelPushAttemptedAt: number | null;
  /** 0/1 when attempted; null when not attempted (skipped or transport
   *  unavailable). */
  channelPushSucceeded: boolean | null;
  hookDrainedAt: number | null;
  driver: AgentDeliveryDriver;
}

// ─── MCP tool input / output shapes ───────────────────────────────────────

// pc_invoke_agent ─────────────────────────────────────────────────────────

/** `pc_invoke_agent` — dispatch an agent. With `wait: true` the call blocks
 *  inside the caller's turn until the child returns. With `wait: false` it
 *  returns immediately and a terminal `agent-completed` / `agent-failed`
 *  channel event lands on the caller's stream. Orchestrator's prompt
 *  defaults to `wait: false` (don't block the chat composer). Background
 *  agents' prompts default to `wait: true` (child's result is the next
 *  input). */
export interface PcInvokeAgentInput {
  /** Pod-row name (kebab-case). */
  name: string;
  /** Free-form input passed to the child as its first user message. */
  input: string;
  /** Defaults to `true` (sync). Orchestrator pod prompt overrides to
   *  `false` per handler convention. */
  wait?: boolean;
  /** Optional: the work-item the child is operating on. Carried forward
   *  on every `pc_ask_*` the child emits and on its terminal event. */
  parentWorkItemId?: ULID;
}

export type PcInvokeAgentResult =
  | PcInvokeAgentResultSync
  | PcInvokeAgentResultAsync
  | PcInvokeAgentResultError;

/** `wait: true` return — child completed in-line. */
export interface PcInvokeAgentResultSync {
  ok: true;
  mode: 'sync';
  sessionId: string;
  runId: ULID;
  result: string;
}

/** `wait: false` return — child is running; terminal event will land
 *  separately. */
export interface PcInvokeAgentResultAsync {
  ok: true;
  mode: 'async';
  sessionId: string;
  runId: ULID;
  startedAt: number;
}

export interface PcInvokeAgentResultError {
  ok: false;
  error: string;
  /** Optional structured cause for caller-side handling. */
  cause?: 'unknown-agent' | 'depth-cap' | 'loop-cap' | 'spawn-failed' | 'error';
}

// pc_ask_orchestrator ─────────────────────────────────────────────────────

/** `pc_ask_orchestrator` — pause-and-ask. Tool returns a pending-ask
 *  handle; the agent ends its turn naturally; runtime resumes via
 *  `--resume <sessionId>` once `pc_answer_pending` lands the answer, and
 *  writes the answer as the next user message. */
export interface PcAskOrchestratorInput {
  question: string;
  context?: string;
}

export interface PcAskOrchestratorResult {
  ok: true;
  pendingAskId: ULID;
  status: 'waiting';
}

// pc_ask_user ─────────────────────────────────────────────────────────────

/** `pc_ask_user` — pause-and-ask routed through orchestrator-as-proxy.
 *  Same pause semantics as `pc_ask_orchestrator`; the orchestrator renders
 *  the question via the existing chat surfaces. */
export interface PcAskUserInput {
  question: string;
  context?: string;
  options?: PendingAskOption[];
}

export interface PcAskUserResult {
  ok: true;
  pendingAskId: ULID;
  status: 'waiting';
}

// pc_request_approval ─────────────────────────────────────────────────────

/** `pc_request_approval` — explicit human-in-the-loop gate. Same pause
 *  semantics; rendered via the existing `ApprovalBubble` surface.
 *  Subsumes today's workflow approval node for non-workflow invocations. */
export interface PcRequestApprovalInput {
  decision: string;
  options: PendingAskOption[];
  context?: string;
}

export interface PcRequestApprovalResult {
  ok: true;
  pendingAskId: ULID;
  status: 'waiting';
}

// pc_answer_pending ───────────────────────────────────────────────────────

/** `pc_answer_pending` — orchestrator's tool to resume a paused agent.
 *  Re-spawns the agent with `--resume <sessionId>` and writes `answer` as
 *  the next user message. Idempotent against double-fire: status check on
 *  the row (`waiting` only) guards JSONL-replay re-delivery. */
export interface PcAnswerPendingInput {
  pendingAskId: ULID;
  answer: string;
  /** Who produced the answer. Drives the audit-trail row + the chat-side
   *  attribution ("orchestrator answered:" vs "user answered:"). */
  answeredBy: 'orchestrator' | 'user';
}

export type PcAnswerPendingResult =
  | PcAnswerPendingResultOk
  | PcAnswerPendingResultError;

export interface PcAnswerPendingResultOk {
  ok: true;
  sessionId: string;
  status: 'resuming';
}

export interface PcAnswerPendingResultError {
  ok: false;
  error: string;
  cause: 'unknown-pending-ask' | 'already-answered' | 'cancelled' | 'resume-failed' | 'error';
}
