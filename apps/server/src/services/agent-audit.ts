// Section 16b.7 — Agent-comms audit trail writer.
//
// One function per agent-comms event kind. Each builds a
// `WorkItemHistoryEntry` and appends it to the parent work item via the
// repo's `appendWorkItemHistory` writer.
//
// Audit rows are informational, not load-bearing for the primary tool
// effect (the pending-ask is already minted, the run is already spawned).
// Every writer below is best-effort: NOOPs when `workItemId` is null,
// swallows DB errors so a write failure can't break an MCP tool call.
// The work-item Activity tab consumes these via the public WorkItem shape
// (see packages/db/src/repos/work-items.ts → toDomain).

import { appendWorkItemHistory } from '@pc/db';
import type { ULID, WorkItemHistoryEntry } from '@pc/domain';

const SUMMARY_MAX = 200;

function clip(text: string, max: number = SUMMARY_MAX): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1).trimEnd() + '…';
}

function safeAppend(workItemId: ULID, entry: WorkItemHistoryEntry): void {
  try {
    appendWorkItemHistory(workItemId, entry);
  } catch (err) {
    // Audit failures must not break the primary tool effect. Log + swallow.
    console.warn(
      `[agent-audit] append failed for work item ${workItemId} (${entry.kind}):`,
      (err as Error).message,
    );
  }
}

function ts(now: number): string {
  return new Date(now).toISOString();
}

export interface RecordInvokeInput {
  workItemId: ULID | null;
  agentName: string;
  sessionId: string;
  runId: ULID;
  mode: 'sync' | 'async';
  input: string;
  now: number;
}

export function recordAgentInvoke(input: RecordInvokeInput): void {
  if (!input.workItemId) return;
  const note =
    input.mode === 'sync'
      ? `Invoked ${input.agentName} (sync) — ${clip(input.input)}`
      : `Dispatched ${input.agentName} (async) — ${clip(input.input)}`;
  safeAppend(input.workItemId, {
    ts: ts(input.now),
    kind: 'agent-invoke',
    agentName: input.agentName,
    sessionId: input.sessionId,
    runId: input.runId,
    invokeMode: input.mode,
    note,
  });
}

export interface RecordPauseInput {
  workItemId: ULID | null;
  agentName: string;
  sessionId: string;
  runId: ULID | null;
  pendingAskId: ULID;
  kind: 'ask-orchestrator' | 'ask-user' | 'approval';
  /** For ask-* this is the question; for approval this is the decision text. */
  prompt: string;
  now: number;
}

export function recordAgentPause(input: RecordPauseInput): void {
  if (!input.workItemId) return;
  const entryKind: WorkItemHistoryEntry['kind'] =
    input.kind === 'ask-orchestrator'
      ? 'agent-ask-orchestrator'
      : input.kind === 'ask-user'
        ? 'agent-ask-user'
        : 'agent-approval-request';
  const verb =
    input.kind === 'ask-orchestrator'
      ? 'asked orchestrator'
      : input.kind === 'ask-user'
        ? 'asked user'
        : 'requested approval';
  const note = `${input.agentName} ${verb}: ${clip(input.prompt)}`;
  safeAppend(input.workItemId, {
    ts: ts(input.now),
    kind: entryKind,
    agentName: input.agentName,
    sessionId: input.sessionId,
    runId: input.runId ?? undefined,
    pendingAskId: input.pendingAskId,
    note,
  });
}

export interface RecordAnswerInput {
  workItemId: ULID | null;
  agentName: string;
  sessionId: string;
  runId: ULID | null;
  pendingAskId: ULID;
  answeredBy: 'orchestrator' | 'user';
  answer: string;
  now: number;
}

export function recordAgentAnswer(input: RecordAnswerInput): void {
  if (!input.workItemId) return;
  const note = `${input.answeredBy === 'orchestrator' ? 'Orchestrator' : 'User'} answered: ${clip(
    input.answer,
  )}`;
  safeAppend(input.workItemId, {
    ts: ts(input.now),
    kind: 'agent-answer',
    agentName: input.agentName,
    sessionId: input.sessionId,
    runId: input.runId ?? undefined,
    pendingAskId: input.pendingAskId,
    answeredBy: input.answeredBy,
    note,
  });
}

export interface RecordCompletedInput {
  workItemId: ULID | null;
  agentName: string;
  sessionId: string;
  runId: ULID;
  result: string;
  now: number;
}

export function recordAgentCompleted(input: RecordCompletedInput): void {
  if (!input.workItemId) return;
  const note = `${input.agentName} completed — ${clip(input.result)}`;
  safeAppend(input.workItemId, {
    ts: ts(input.now),
    kind: 'agent-completed',
    agentName: input.agentName,
    sessionId: input.sessionId,
    runId: input.runId,
    note,
  });
}

export interface RecordFailedInput {
  workItemId: ULID | null;
  agentName: string;
  sessionId: string;
  runId: ULID;
  reason: string;
  cause: string;
  now: number;
}

export function recordAgentFailed(input: RecordFailedInput): void {
  if (!input.workItemId) return;
  const note = `${input.agentName} failed (${input.cause}): ${clip(input.reason)}`;
  safeAppend(input.workItemId, {
    ts: ts(input.now),
    kind: 'agent-failed',
    agentName: input.agentName,
    sessionId: input.sessionId,
    runId: input.runId,
    cause: input.cause,
    note,
  });
}
