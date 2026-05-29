import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AgentRunRow, AgentRunStatus, ULID } from '@pc/domain';
import type { AgentHostRunSnapshot } from '@pc/runtime';

import { reconcileAgentRunsOnBoot } from '../src/services/agent-run-boot-reconcile.ts';

function row(id: string, status: AgentRunStatus): AgentRunRow {
  return {
    id: id as ULID,
    projectId: '01KSRVPROJECT000000000001' as ULID,
    dispatcherSessionId: 'dispatcher-1',
    ccSessionId: `cc-${id}`,
    podName: 'researcher',
    podRevisionAtDispatch: null,
    podRevisionAtResume: null,
    status,
    continues: null,
    parentInvokeDepth: 0,
    parentWorkItemId: null,
    input: 'input',
    result: null,
    failureCause: null,
    failureReason: null,
    queuedAt: 1_700_000_000_000,
    spawnedAt: null,
    readyAt: null,
    completedAt: null,
  };
}

function hostRun(
  runId: string,
  state: AgentRunStatus,
  patch: Partial<AgentHostRunSnapshot> = {},
): AgentHostRunSnapshot {
  return {
    runId: runId as ULID,
    projectId: '01KSRVPROJECT000000000001' as ULID,
    dispatcherSessionId: 'dispatcher-1',
    ccSessionId: `cc-${runId}`,
    podName: 'researcher',
    worktreeDir: 'E:/worktree',
    state,
    jsonlPath: null,
    transcriptPath: null,
    queuedAt: 1_700_000_000_000,
    spawnedAt: null,
    readyAt: null,
    updatedAt: 1_700_000_000_100,
    terminalAt: null,
    ...patch,
  };
}

test('reconcileAgentRunsOnBoot uses legacy sweep when no host client exists', () => {
  const result = reconcileAgentRunsOnBoot({
    now: () => 123,
    legacyReconcile: (now) => {
      assert.equal(now, 123);
      return 3;
    },
  });

  assert.deepEqual(result, {
    mode: 'legacy',
    hostRuns: 0,
    checked: 0,
    kept: 0,
    failed: 3,
    updated: 0,
    reconciled: 3,
  });
});

test('reconcileAgentRunsOnBoot keeps host-matched rows and applies newer host status', () => {
  const updates: unknown[] = [];
  const failures: unknown[] = [];

  const result = reconcileAgentRunsOnBoot({
    now: () => 1_700_000_001_000,
    hostClient: {
      listRuns: () => [
        hostRun('run-1', 'running'),
        hostRun('run-2', 'spawning', { spawnedAt: 1_700_000_000_500 }),
      ],
    },
    listNonTerminalRuns: () => [row('run-1', 'running'), row('run-2', 'queued')],
    hasOpenPendingAskForRun: () => false,
    updateStatus: (input) => { updates.push(input); },
    markTerminal: (input) => { failures.push(input); },
  });

  assert.equal(result.mode, 'host');
  assert.equal(result.hostRuns, 2);
  assert.equal(result.checked, 2);
  assert.equal(result.kept, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.updated, 1);
  assert.equal(result.reconciled, 1);
  assert.deepEqual(updates, [
    {
      id: 'run-2',
      status: 'spawning',
      spawnedAt: 1_700_000_000_500,
    },
  ]);
  assert.deepEqual(failures, []);
});

test('reconcileAgentRunsOnBoot fails host-missing running rows with host-lost cause', () => {
  const failures: unknown[] = [];

  const result = reconcileAgentRunsOnBoot({
    now: () => 1_700_000_002_000,
    hostClient: { listRuns: () => [] },
    listNonTerminalRuns: () => [row('run-missing', 'running')],
    hasOpenPendingAskForRun: () => false,
    updateStatus: () => { throw new Error('unexpected update'); },
    markTerminal: (input) => { failures.push(input); },
  });

  assert.equal(result.failed, 1);
  assert.equal(result.reconciled, 1);
  assert.deepEqual(failures, [
    {
      id: 'run-missing',
      status: 'failed',
      result: null,
      failureCause: 'host-lost',
      failureReason: 'agent host no longer owns this non-terminal run',
      completedAt: 1_700_000_002_000,
    },
  ]);
});

test('reconcileAgentRunsOnBoot preserves host-missing paused rows only with open ask and JSONL', () => {
  const failures: unknown[] = [];

  const result = reconcileAgentRunsOnBoot({
    now: () => 1_700_000_003_000,
    hostClient: { listRuns: () => [] },
    listNonTerminalRuns: () => [
      row('paused-with-ask', 'paused'),
      row('paused-with-ask-no-jsonl', 'paused'),
      row('paused-without-ask', 'paused'),
    ],
    hasOpenPendingAskForRun: (runId) =>
      runId === 'paused-with-ask' || runId === 'paused-with-ask-no-jsonl',
    resolveJsonlPath: (r) => `jsonl:${r.id}`,
    jsonlExists: (path) => path === 'jsonl:paused-with-ask',
    updateStatus: () => { throw new Error('unexpected update'); },
    markTerminal: (input) => { failures.push(input); },
  });

  assert.equal(result.kept, 1);
  assert.equal(result.failed, 2);
  assert.equal(result.reconciled, 2);
  assert.deepEqual(failures, [
    {
      id: 'paused-with-ask-no-jsonl',
      status: 'failed',
      result: null,
      failureCause: 'host-lost',
      failureReason: 'agent host no longer owns this non-terminal run',
      completedAt: 1_700_000_003_000,
    },
    {
      id: 'paused-without-ask',
      status: 'failed',
      result: null,
      failureCause: 'host-lost',
      failureReason: 'agent host no longer owns this non-terminal run',
      completedAt: 1_700_000_003_000,
    },
  ]);
});

test('reconcileAgentRunsOnBoot applies terminal host snapshots to non-terminal DB rows', () => {
  const terminals: unknown[] = [];

  const result = reconcileAgentRunsOnBoot({
    now: () => 1_700_000_004_000,
    hostClient: {
      listRuns: () => [
        hostRun('run-terminal', 'completed', {
          terminalAt: 1_700_000_003_500,
          terminalResult: {
            status: 'completed',
            result: 'done',
            failureCause: null,
            failureReason: null,
          },
        }),
      ],
    },
    listNonTerminalRuns: () => [row('run-terminal', 'running')],
    hasOpenPendingAskForRun: () => false,
    updateStatus: () => { throw new Error('unexpected update'); },
    markTerminal: (input) => { terminals.push(input); },
  });

  assert.equal(result.updated, 1);
  assert.equal(result.reconciled, 1);
  assert.deepEqual(terminals, [
    {
      id: 'run-terminal',
      status: 'completed',
      result: 'done',
      failureCause: null,
      failureReason: null,
      completedAt: 1_700_000_003_500,
    },
  ]);
});
