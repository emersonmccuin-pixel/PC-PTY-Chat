// Unit tests for the workflow-event header helper + the workflow-runtime body
// builders that consume it (4c / D38).
//
// Run via:  pnpm --filter @pc/server test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildWorkflowEventHeader } from '../src/services/workflow-event-header.ts';
import {
  buildSubagentChannelBody,
  buildTerminatedChannelBody,
} from '../src/services/workflow-runtime.ts';

test('buildWorkflowEventHeader: subagent-dispatch with default version', () => {
  assert.equal(
    buildWorkflowEventHeader('subagent-dispatch'),
    '[pc:workflow-event kind=subagent-dispatch version=1]',
  );
});

test('buildWorkflowEventHeader: terminated', () => {
  assert.equal(
    buildWorkflowEventHeader('terminated'),
    '[pc:workflow-event kind=terminated version=1]',
  );
});

test('buildWorkflowEventHeader: orchestrator-review', () => {
  assert.equal(
    buildWorkflowEventHeader('orchestrator-review'),
    '[pc:workflow-event kind=orchestrator-review version=1]',
  );
});

test('buildWorkflowEventHeader: explicit version override', () => {
  assert.equal(
    buildWorkflowEventHeader('subagent-dispatch', 2),
    '[pc:workflow-event kind=subagent-dispatch version=2]',
  );
});

test('buildSubagentChannelBody: starts with the subagent-dispatch header line', () => {
  const body = buildSubagentChannelBody({
    runId: 'run-1',
    nodeId: 'explore',
    subagent: 'researcher',
    workflowId: 'review-research',
    worktreePath: '/wt/x',
    prompt: 'Do the thing.',
  });
  const firstLine = body.split('\n', 1)[0];
  assert.equal(firstLine, '[pc:workflow-event kind=subagent-dispatch version=1]');
  // Verify rest of the body kept its existing shape.
  assert.match(body, /Workflow event: workflow="review-research"/);
  assert.match(body, /\[workflowRunId: run-1\] \[nodeId: explore\] \[worktree: \/wt\/x\]/);
  assert.match(body, /pc_complete_node/);
  assert.match(body, /pc_node_failed/);
});

test('buildSubagentChannelBody: omits [worktree:] token when worktreePath is null', () => {
  const body = buildSubagentChannelBody({
    runId: 'run-1',
    nodeId: 'n',
    subagent: 'researcher',
    workflowId: 'wf',
    worktreePath: null,
    prompt: 'x',
  });
  assert.doesNotMatch(body, /\[worktree:/);
});

test('buildTerminatedChannelBody: starts with the terminated header line', () => {
  const body = buildTerminatedChannelBody({
    runId: 'run-1',
    workflowId: 'review-research',
    status: 'failed',
    lastReason: 'subagent timed out',
  });
  const firstLine = body.split('\n', 1)[0];
  assert.equal(firstLine, '[pc:workflow-event kind=terminated version=1]');
  assert.match(body, /Workflow run terminated: workflow="review-research" status="failed"\./);
  assert.match(body, /Reason: subagent timed out/);
  assert.match(body, /\[workflowRunId: run-1\]/);
});

test('buildTerminatedChannelBody: omits Reason line when lastReason is null', () => {
  const body = buildTerminatedChannelBody({
    runId: 'run-1',
    workflowId: 'wf',
    status: 'cancelled',
    lastReason: null,
  });
  assert.doesNotMatch(body, /Reason:/);
});
