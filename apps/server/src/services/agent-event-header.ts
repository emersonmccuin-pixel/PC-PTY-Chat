// Section 16b — Header tag for agent→orchestrator channel messages.
// Mirrors `workflow-event-header.ts` (the 4c pattern). Prepended to every
// channel POST body originating from the agent runtime so the orchestrator
// can recognise the message kind via a stable token instead of matching
// prose phrasing.
//
// Shape: `[pc:agent-event kind=<kind> version=<n>]`
//
// Kinds enumerated in `@pc/domain` as `AgentChannelEventKind`.

import type { AgentChannelEventKind } from '@pc/domain';

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
