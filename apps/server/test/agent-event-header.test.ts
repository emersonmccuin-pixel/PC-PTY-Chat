// Section 16b.3.1 unit tests — agent-event header + body builders.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAgentAsksOrchestratorBody,
  buildAgentEventHeader,
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
