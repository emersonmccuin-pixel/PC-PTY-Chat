// Section 16b — Header tag for agent→orchestrator channel messages.
// Mirrors `workflow-event-header.ts` (the 4c pattern). Prepended to every
// channel POST body originating from the agent runtime so the orchestrator
// can recognise the message kind via a stable token instead of matching
// prose phrasing.
//
// Shape: `[pc:agent-event kind=<kind> version=<n>]`
//
// Kinds enumerated in `@pc/domain` as `AgentChannelEventKind`.

import type { AgentChannelEventKind, AgentFailedPayload, PendingAskOption } from '@pc/domain';

export function buildAgentEventHeader(kind: AgentChannelEventKind, version = 1): string {
  return `[pc:agent-event kind=${kind} version=${version}]`;
}

/** Compose the channel-event body the orchestrator's pod prompt parses for
 *  `agent-asks-orchestrator`. Header line, then a small block of structured
 *  tags (`[pendingAskId: ...]`, `[sessionId: ...]`, `[agentName: ...]`),
 *  then the question + optional context. The tag block keeps PC's parse
 *  contract stable independent of the prose the agent wrote. */
export function buildAgentAsksOrchestratorBody(args: {
  pendingAskId: string;
  sessionId: string;
  agentName: string;
  runId: string | null;
  parentWorkItemId: string | null;
  question: string;
  context: string | null;
}): string {
  const lines: string[] = [
    buildAgentEventHeader('agent-asks-orchestrator'),
    `[pendingAskId: ${args.pendingAskId}]`,
    `[sessionId: ${args.sessionId}]`,
    `[agentName: ${args.agentName}]`,
  ];
  if (args.runId) lines.push(`[runId: ${args.runId}]`);
  if (args.parentWorkItemId) lines.push(`[parentWorkItemId: ${args.parentWorkItemId}]`);
  lines.push('');
  lines.push(`Question:`);
  lines.push(args.question);
  if (args.context) {
    lines.push('');
    lines.push(`Context:`);
    lines.push(args.context);
  }
  lines.push('');
  lines.push(
    `Answer via pc_answer_pending with the pendingAskId above. Check the pending-ask status first — replay can re-fire this event for an already-answered question.`,
  );
  return lines.join('\n');
}

/** Compose the channel-event body for `agent-asks-user` (handler protocol
 *  entry #2). Same tag shape as `agent-asks-orchestrator`; if the agent
 *  surfaced multi-choice options, they render as a numbered list under an
 *  `Options:` block. Orchestrator's job is to render the question to the
 *  user via existing chat surfaces, then forward the user's reply via
 *  `pc_answer_pending` with `answeredBy: "user"`. */
export function buildAgentAsksUserBody(args: {
  pendingAskId: string;
  sessionId: string;
  agentName: string;
  runId: string | null;
  parentWorkItemId: string | null;
  question: string;
  context: string | null;
  options: PendingAskOption[] | null;
}): string {
  const lines: string[] = [
    buildAgentEventHeader('agent-asks-user'),
    `[pendingAskId: ${args.pendingAskId}]`,
    `[sessionId: ${args.sessionId}]`,
    `[agentName: ${args.agentName}]`,
  ];
  if (args.runId) lines.push(`[runId: ${args.runId}]`);
  if (args.parentWorkItemId) lines.push(`[parentWorkItemId: ${args.parentWorkItemId}]`);
  lines.push('');
  lines.push('Question for the user:');
  lines.push(args.question);
  if (args.context) {
    lines.push('');
    lines.push('Context:');
    lines.push(args.context);
  }
  if (args.options && args.options.length > 0) {
    lines.push('');
    lines.push('Options:');
    args.options.forEach((opt, idx) => {
      lines.push(`${idx + 1}. ${opt.label} (value: ${opt.value})`);
    });
  }
  lines.push('');
  lines.push(
    `Render this question to the user via chat. When they reply, call pc_answer_pending with the pendingAskId above and answeredBy: "user". Check the pending-ask status first — replay can re-fire this event.`,
  );
  return lines.join('\n');
}

/** Compose the channel-event body for `agent-approval-request` (handler
 *  protocol entry #3). Same tag shape as the asks-* events; carries the
 *  decision statement + a non-empty `Options:` list of approve / reject
 *  / revise (or whatever the agent supplied). Orchestrator surfaces it
 *  through the existing approval-bubble UI, then forwards the user's
 *  decision via `pc_answer_pending` with `answeredBy: "user"`. */
export function buildAgentApprovalRequestBody(args: {
  pendingAskId: string;
  sessionId: string;
  agentName: string;
  runId: string | null;
  parentWorkItemId: string | null;
  decision: string;
  context: string | null;
  options: PendingAskOption[];
}): string {
  const lines: string[] = [
    buildAgentEventHeader('agent-approval-request'),
    `[pendingAskId: ${args.pendingAskId}]`,
    `[sessionId: ${args.sessionId}]`,
    `[agentName: ${args.agentName}]`,
  ];
  if (args.runId) lines.push(`[runId: ${args.runId}]`);
  if (args.parentWorkItemId) lines.push(`[parentWorkItemId: ${args.parentWorkItemId}]`);
  lines.push('');
  lines.push('Approval requested:');
  lines.push(args.decision);
  if (args.context) {
    lines.push('');
    lines.push('Context:');
    lines.push(args.context);
  }
  lines.push('');
  lines.push('Options:');
  args.options.forEach((opt, idx) => {
    lines.push(`${idx + 1}. ${opt.label} (value: ${opt.value})`);
  });
  lines.push('');
  lines.push(
    `Render this through the approval surface. On the user's decision, call pc_answer_pending with the pendingAskId above, the chosen option's value as the answer, and answeredBy: "user".`,
  );
  return lines.join('\n');
}

/** Compose the channel-event body the orchestrator's pod prompt parses for
 *  `agent-completed` (handler protocol entry #4). Surfaces a background-
 *  dispatched agent's terminal result back to the caller as a `<channel>`
 *  block so the orchestrator can start a new turn surfacing it to the user
 *  with the right context. */
export function buildAgentCompletedBody(args: {
  runId: string;
  sessionId: string;
  agentName: string;
  parentWorkItemId: string | null;
  result: string;
}): string {
  const lines: string[] = [
    buildAgentEventHeader('agent-completed'),
    `[runId: ${args.runId}]`,
    `[sessionId: ${args.sessionId}]`,
    `[agentName: ${args.agentName}]`,
  ];
  if (args.parentWorkItemId) lines.push(`[parentWorkItemId: ${args.parentWorkItemId}]`);
  lines.push('');
  lines.push('Result:');
  lines.push(args.result || '(no output)');
  lines.push('');
  lines.push(
    `The ${args.agentName} agent you dispatched earlier finished. Start a new turn surfacing this result to the user with enough context for them to remember what they asked.`,
  );
  return lines.join('\n');
}

/** Section 18.7 — compose the channel-event body for `agent-queued-started`.
 *  Fires when a dispatch that was previously queued (because the global
 *  concurrent cap was full) actually starts. Lets the orchestrator update
 *  its mental model — "the agent you queued earlier is now running" — so
 *  the user doesn't think the dispatch was lost. The terminal event (
 *  `agent-completed` / `agent-failed`) still lands separately when the
 *  spawned run finishes. */
export function buildAgentQueuedStartedBody(args: {
  runId: string;
  sessionId: string;
  agentName: string;
  parentWorkItemId: string | null;
  queuedAt: number;
  startedAt: number;
}): string {
  const waitedMs = Math.max(0, args.startedAt - args.queuedAt);
  const waitedSec = Math.round(waitedMs / 1000);
  const lines: string[] = [
    buildAgentEventHeader('agent-queued-started'),
    `[runId: ${args.runId}]`,
    `[sessionId: ${args.sessionId}]`,
    `[agentName: ${args.agentName}]`,
    `[queuedAt: ${args.queuedAt}]`,
    `[startedAt: ${args.startedAt}]`,
    `[waitedMs: ${waitedMs}]`,
  ];
  if (args.parentWorkItemId) lines.push(`[parentWorkItemId: ${args.parentWorkItemId}]`);
  lines.push('');
  lines.push(
    `The ${args.agentName} agent you queued earlier just started (waited ~${waitedSec}s in the dispatch queue). You'll see its terminal event when it finishes.`,
  );
  return lines.join('\n');
}

/** Compose the channel-event body for `agent-failed` (handler protocol
 *  entry #5). Same shape as `agent-completed` but with a failure summary
 *  + structured cause so the orchestrator can suggest a next step (retry
 *  / drop / hand-write). */
export function buildAgentFailedBody(args: {
  runId: string;
  sessionId: string;
  agentName: string;
  parentWorkItemId: string | null;
  reason: string;
  cause: AgentFailedPayload['cause'];
}): string {
  const lines: string[] = [
    buildAgentEventHeader('agent-failed'),
    `[runId: ${args.runId}]`,
    `[sessionId: ${args.sessionId}]`,
    `[agentName: ${args.agentName}]`,
    `[cause: ${args.cause ?? 'error'}]`,
  ];
  if (args.parentWorkItemId) lines.push(`[parentWorkItemId: ${args.parentWorkItemId}]`);
  lines.push('');
  lines.push('Failure:');
  lines.push(args.reason || '(no reason recorded)');
  lines.push('');
  lines.push(
    `The ${args.agentName} agent you dispatched earlier failed. Surface this to the user with a one-line summary + a suggested next step (retry / drop / hand-write).`,
  );
  return lines.join('\n');
}
