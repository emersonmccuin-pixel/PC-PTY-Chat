import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AgentRunRow, AgentRunStatus, ULID } from '@pc/domain';

import { sweepAgentRunLiveness } from '../src/services/agent-run-liveness-sweep.ts';

const NOW = 1_800_000_000_000;
const IDLE = 10 * 60_000;

function row(patch: Partial<AgentRunRow> = {}): AgentRunRow {
  return {
    id: 'run-1' as ULID,
    projectId: 'proj-1' as ULID,
    dispatcherSessionId: 'disp-1',
    ccSessionId: 'cc-1',
    podName: 'planner',
    podRevisionAtDispatch: null,
    podRevisionAtResume: null,
    status: 'running' as AgentRunStatus,
    continues: null,
    parentInvokeDepth: 0,
    parentWorkItemId: null,
    input: 'go',
    result: null,
    failureCause: null,
    failureReason: null,
    queuedAt: NOW - 60_000,
    spawnedAt: NOW - 55_000,
    readyAt: NOW - 50_000,
    pid: 4242,
    lastActivityAt: NOW - 1_000,
    completedAt: null,
    rev: 0,
    ...patch,
  };
}

interface Harness {
  rows: AgentRunRow[];
  alivePids: Set<number>;
  finalized: Array<{ id: string; cause: string | null | undefined }>;
  killed: number[];
  deps: Parameters<typeof sweepAgentRunLiveness>[0];
}

function harness(rows: AgentRunRow[], alivePids: number[]): Harness {
  const h: Harness = {
    rows,
    alivePids: new Set(alivePids),
    finalized: [],
    killed: [],
    deps: {},
  };
  h.deps = {
    now: () => NOW,
    idleTimeoutMs: IDLE,
    listNonTerminalRuns: () => h.rows,
    hasOpenPendingAskForRun: () => false,
    resolveJsonlPath: () => null,
    jsonlMtime: () => null,
    isProcessAlive: (pid) => h.alivePids.has(pid),
    killProcess: (pid) => h.killed.push(pid),
    applyTerminalEffects: (input) => {
      h.finalized.push({ id: input.runId, cause: input.failureCause });
      return { applied: 1 };
    },
  };
  return h;
}

test('alive + recently active run is left running', () => {
  const h = harness([row({ lastActivityAt: NOW - 5_000 })], [4242]);
  const res = sweepAgentRunLiveness(h.deps);
  assert.equal(res.failedDead + res.failedIdle, 0);
  assert.equal(h.finalized.length, 0);
  assert.equal(h.killed.length, 0);
});

test('pid persisted but process gone → failed unexpected-exit, no kill', () => {
  const h = harness([row({ pid: 9999 })], [] /* nothing alive */);
  const res = sweepAgentRunLiveness(h.deps);
  assert.equal(res.failedDead, 1);
  assert.equal(res.failedIdle, 0);
  assert.equal(h.killed.length, 0, 'dead process needs no kill');
  assert.deepEqual(h.finalized, [{ id: 'run-1', cause: 'unexpected-exit' }]);
});

test('alive but idle past window → kill pid + failed idle-timeout', () => {
  const stale = NOW - (IDLE + 120_000);
  const h = harness(
    [row({ queuedAt: stale, spawnedAt: stale, readyAt: stale, lastActivityAt: stale })],
    [4242],
  );
  const res = sweepAgentRunLiveness(h.deps);
  assert.equal(res.failedIdle, 1);
  assert.equal(res.killed, 1);
  assert.deepEqual(h.killed, [4242]);
  assert.deepEqual(h.finalized, [{ id: 'run-1', cause: 'idle-timeout' }]);
});

test('idle with unknown pid → failed idle-timeout, no kill attempted', () => {
  const stale = NOW - (IDLE + 120_000);
  const h = harness(
    [row({ pid: null, queuedAt: stale, spawnedAt: stale, readyAt: stale, lastActivityAt: stale })],
    [],
  );
  const res = sweepAgentRunLiveness(h.deps);
  assert.equal(res.failedIdle, 1);
  assert.equal(h.killed.length, 0);
  assert.equal(h.finalized[0]?.cause, 'idle-timeout');
});

test('queued runs are skipped entirely', () => {
  const h = harness([row({ status: 'queued', pid: null, queuedAt: NOW - (IDLE * 2) })], []);
  const res = sweepAgentRunLiveness(h.deps);
  assert.equal(res.checked, 1);
  assert.equal(h.finalized.length, 0);
});

test('paused run with an open ask is preserved', () => {
  const h = harness([row({ status: 'paused', pid: null, readyAt: NOW - (IDLE * 2), lastActivityAt: NOW - (IDLE * 2) })], []);
  h.deps.hasOpenPendingAskForRun = () => true;
  const res = sweepAgentRunLiveness(h.deps);
  assert.equal(h.finalized.length, 0);
});

test('recent JSONL mtime keeps an otherwise-stale row alive', () => {
  const h = harness([row({ lastActivityAt: NOW - (IDLE + 60_000), readyAt: NOW - (IDLE + 60_000), pid: 4242 })], [4242]);
  h.deps.jsonlMtime = () => NOW - 1_000; // tailer lagged the DB stamp, but file is fresh
  h.deps.resolveJsonlPath = () => '/fake/session.jsonl';
  const res = sweepAgentRunLiveness(h.deps);
  assert.equal(res.failedIdle, 0, 'fresh jsonl mtime proves liveness');
  assert.equal(h.finalized.length, 0);
});
