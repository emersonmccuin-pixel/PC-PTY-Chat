// Section 16b.3.1 + 16b.4.3 unit tests — agent-event header + body builders.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAgentApprovalRequestBody,
  buildAgentAsksOrchestratorBody,
  buildAgentAsksUserBody,
  buildAgentCompletedBody,
  buildAgentEventHeader,
  buildAgentFailedBody,
} from '../src/services/agent-event-header.ts';

test('buildAgentEventHeader formats kind + version', () => {
  assert.equal(
    buildAgentEventHeader('agent-asks-orchestrator'),
    '[pc:agent-event kind=agent-asks-orchestrator version=1]',
  );
  assert.equal(
    buildAgentEventHeader('agent-completed', 2),
    '[pc:agent-event kind=agent-completed version=2]',
  );
});

test('buildAgentAsksOrchestratorBody includes header + tags + question', () => {
  const out = buildAgentAsksOrchestratorBody({
    pendingAskId: '01ABC',
    sessionId: 'sess-x',
    agentName: 'researcher',
    runId: null,
    parentWorkItemId: null,
    question: 'which lib?',
    context: 'considered three options',
  });

  assert.match(out, /^\[pc:agent-event kind=agent-asks-orchestrator version=1\]/);
  assert.match(out, /\[pendingAskId: 01ABC\]/);
  assert.match(out, /\[sessionId: sess-x\]/);
  assert.match(out, /\[agentName: researcher\]/);
  assert.match(out, /Question:\nwhich lib\?/);
  assert.match(out, /Context:\nconsidered three options/);
  assert.match(out, /Answer via pc_answer_pending/);
});

test('buildAgentAsksOrchestratorBody omits optional context + drops null runId / parentWorkItemId tags', () => {
  const out = buildAgentAsksOrchestratorBody({
    pendingAskId: '01XYZ',
    sessionId: 'sess-y',
    agentName: 'planner',
    runId: null,
    parentWorkItemId: null,
    question: 'q',
    context: null,
  });

  assert.doesNotMatch(out, /\[runId:/);
  assert.doesNotMatch(out, /\[parentWorkItemId:/);
  assert.doesNotMatch(out, /Context:/);
});

test('buildAgentAsksOrchestratorBody includes runId + parentWorkItemId when supplied', () => {
  const out = buildAgentAsksOrchestratorBody({
    pendingAskId: '01PQR',
    sessionId: 'sess-z',
    agentName: 'reviewer',
    runId: '01RUN',
    parentWorkItemId: '01WI',
    question: 'go ahead?',
    context: null,
  });

  assert.match(out, /\[runId: 01RUN\]/);
  assert.match(out, /\[parentWorkItemId: 01WI\]/);
});

// ── 16b.4.3 terminal-event body formatters ────────────────────────────────

test('buildAgentCompletedBody includes header + runId/session/agentName + result', () => {
  const out = buildAgentCompletedBody({
    runId: '01RUN1',
    sessionId: 'sess-c',
    agentName: 'researcher',
    parentWorkItemId: null,
    result: 'use date-fns',
  });
  assert.match(out, /^\[pc:agent-event kind=agent-completed version=1\]/);
  assert.match(out, /\[runId: 01RUN1\]/);
  assert.match(out, /\[sessionId: sess-c\]/);
  assert.match(out, /\[agentName: researcher\]/);
  assert.match(out, /Result:\nuse date-fns/);
  assert.match(
    out,
    /The researcher agent you dispatched earlier finished\. Start a new turn surfacing this result/,
  );
  assert.doesNotMatch(out, /\[parentWorkItemId:/);
});

test('buildAgentCompletedBody includes parentWorkItemId when supplied; falls back when result empty', () => {
  const out = buildAgentCompletedBody({
    runId: '01RUN2',
    sessionId: 'sess-c2',
    agentName: 'writer',
    parentWorkItemId: '01WI2',
    result: '',
  });
  assert.match(out, /\[parentWorkItemId: 01WI2\]/);
  assert.match(out, /Result:\n\(no output\)/);
});

test('buildAgentFailedBody includes cause tag + reason + suggestion line', () => {
  const out = buildAgentFailedBody({
    runId: '01RUN3',
    sessionId: 'sess-f',
    agentName: 'reviewer',
    parentWorkItemId: null,
    reason: 'agent exceeded wall-clock cap of 7200s',
    cause: 'timeout',
  });
  assert.match(out, /^\[pc:agent-event kind=agent-failed version=1\]/);
  assert.match(out, /\[runId: 01RUN3\]/);
  assert.match(out, /\[cause: timeout\]/);
  assert.match(out, /Failure:\nagent exceeded wall-clock cap of 7200s/);
  assert.match(out, /Surface this to the user with a one-line summary/);
});

test('buildAgentFailedBody falls back to "error" when cause is null + "(no reason recorded)" when reason empty', () => {
  const out = buildAgentFailedBody({
    runId: '01RUN4',
    sessionId: 'sess-f2',
    agentName: 'planner',
    parentWorkItemId: null,
    reason: '',
    cause: null,
  });
  assert.match(out, /\[cause: error\]/);
  assert.match(out, /Failure:\n\(no reason recorded\)/);
});

// ── 16b.5 agent-asks-user body formatter ──────────────────────────────────

test('buildAgentAsksUserBody renders header + tags + question + render-to-user nudge', () => {
  const out = buildAgentAsksUserBody({
    pendingAskId: '01ASKU',
    sessionId: 'sess-u',
    agentName: 'researcher',
    runId: null,
    parentWorkItemId: null,
    question: 'react-query vs swr?',
    context: 'project already uses tanstack/router',
    options: null,
  });
  assert.match(out, /^\[pc:agent-event kind=agent-asks-user version=1\]/);
  assert.match(out, /\[pendingAskId: 01ASKU\]/);
  assert.match(out, /Question for the user:\nreact-query vs swr\?/);
  assert.match(out, /Context:\nproject already uses tanstack\/router/);
  assert.match(out, /Render this question to the user via chat/);
  assert.doesNotMatch(out, /Options:/);
});

test('buildAgentAsksUserBody renders Options block when supplied + drops null context', () => {
  const out = buildAgentAsksUserBody({
    pendingAskId: '01ASKU2',
    sessionId: 'sess-u2',
    agentName: 'planner',
    runId: '01RUNU',
    parentWorkItemId: '01WIU',
    question: 'which lib?',
    context: null,
    options: [
      { value: 'react-query', label: 'TanStack Query' },
      { value: 'swr', label: 'SWR' },
    ],
  });
  assert.match(out, /\[runId: 01RUNU\]/);
  assert.match(out, /\[parentWorkItemId: 01WIU\]/);
  assert.doesNotMatch(out, /Context:/);
  assert.match(out, /Options:\n1\. TanStack Query \(value: react-query\)\n2\. SWR \(value: swr\)/);
});

// ── 16b.6 agent-approval-request body formatter ───────────────────────────

test('buildAgentApprovalRequestBody renders decision + options + explicit-approval nudge', () => {
  const out = buildAgentApprovalRequestBody({
    pendingAskId: '01APR',
    sessionId: 'sess-a',
    agentName: 'reviewer',
    runId: null,
    parentWorkItemId: null,
    decision: 'drop the old users table',
    context: 'no references in code; 60-day backup retained',
    options: [
      { value: 'approve', label: 'Approve' },
      { value: 'reject', label: 'Reject' },
    ],
  });
  assert.match(out, /^\[pc:agent-event kind=agent-approval-request version=1\]/);
  assert.match(out, /\[pendingAskId: 01APR\]/);
  assert.match(out, /Approval requested:\ndrop the old users table/);
  assert.match(out, /Context:\nno references in code; 60-day backup retained/);
  assert.match(out, /Options:\n1\. Approve \(value: approve\)\n2\. Reject \(value: reject\)/);
  assert.match(out, /Render this through the approval surface/);
});

test('buildAgentApprovalRequestBody drops optional tags + context when absent', () => {
  const out = buildAgentApprovalRequestBody({
    pendingAskId: '01APR2',
    sessionId: 'sess-a2',
    agentName: 'reviewer',
    runId: null,
    parentWorkItemId: null,
    decision: 'commit and push',
    context: null,
    options: [{ value: 'approve', label: 'Approve' }],
  });
  assert.doesNotMatch(out, /\[runId:/);
  assert.doesNotMatch(out, /\[parentWorkItemId:/);
  assert.doesNotMatch(out, /Context:/);
  assert.match(out, /Options:\n1\. Approve \(value: approve\)/);
});
