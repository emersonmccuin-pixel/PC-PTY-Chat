// Section 16b — Header tag for agent→orchestrator channel messages.
// Mirrors `workflow-event-header.ts` (the 4c pattern). Prepended to every
// channel POST body originating from the agent runtime so the orchestrator
// can recognise the message kind via a stable token instead of matching
// prose phrasing.
//
// Shape: `[pc:agent-event kind=<kind> version=<n>]`
//
// Kinds enumerated in `@pc/domain` as `AgentChannelEventKind`.

import type { AgentChannelEventKind, AgentFailedPayload } from '@pc/domain';

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
