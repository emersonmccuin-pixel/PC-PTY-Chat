// Section 25 Session 8 — agent_runs_v2 repo round-trip. Pins the contract
// AgentRun's persistence plumbing + the orchestration layer call into.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-db-agent-runs-v2-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  findActiveContinuationV2,
  getAgentRunRowV2,
  insertAgentRunRowV2,
  listAgentRunsForSessionV2,
  markAgentRunTerminalV2,
  reconcileOrphanedRunningRunsV2,
  updateAgentRunStatusV2,
  newId,
} = await import('../src/index.ts');
import type { Stage, ULID } from '@pc/domain';

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('insertAgentRunRowV2 writes a queued row with required defaults', () => {
  const p = createProject({
    slug: 'ar-v2-insert',
    name: 'AR V2 Insert',
    stages,
    folderPath: tmpDir,
  });

  const id = newId();
  const row = insertAgentRunRowV2({
    id,
    projectId: p.id as ULID,
    podName: 'researcher',
    dispatcherSessionId: 'orch-sess-1',
    ccSessionId: 'cc-uuid-1',
    status: 'queued',
    input: 'do the thing',
    podRevisionAtDispatch: '1700000000000',
    queuedAt: 1_700_000_000_000,
  });

  assert.equal(row.id, id);
  assert.equal(row.status, 'queued');
  assert.equal(row.podRevisionAtDispatch, '1700000000000');
  assert.equal(row.podRevisionAtResume, null);
  assert.equal(row.continues, null);
  assert.equal(row.completedAt, null);
  assert.equal(row.failureCause, null);
  assert.equal(row.result, null);

  const fetched = getAgentRunRowV2(id);
  assert.ok(fetched);
  assert.equal(fetched!.podName, 'researcher');
});

test('updateAgentRunStatusV2 walks queued → spawning → running and records timestamps', () => {
  const p = createProject({
    slug: 'ar-v2-status',
    name: 'Status',
    stages,
    folderPath: tmpDir,
  });
  const id = newId();
  insertAgentRunRowV2({
    id,
    projectId: p.id as ULID,
    podName: 'planner',
    dispatcherSessionId: 'orch-sess-status',
    ccSessionId: 'cc-uuid-status',
    status: 'queued',
    input: null,
    queuedAt: 1_700_000_000_000,
  });

  updateAgentRunStatusV2({ id, status: 'spawning', spawnedAt: 1_700_000_001_000 });
  let row = getAgentRunRowV2(id)!;
  assert.equal(row.status, 'spawning');
  assert.equal(row.spawnedAt, 1_700_000_001_000);

  updateAgentRunStatusV2({ id, status: 'running', readyAt: 1_700_000_002_500 });
  row = getAgentRunRowV2(id)!;
  assert.equal(row.status, 'running');
  assert.equal(row.readyAt, 1_700_000_002_500);

  // Paused → spawning records podRevisionAtResume.
  updateAgentRunStatusV2({ id, status: 'paused' });
  updateAgentRunStatusV2({
    id,
    status: 'spawning',
    spawnedAt: 1_700_000_005_000,
    podRevisionAtResume: '1700000004999',
  });
  row = getAgentRunRowV2(id)!;
  assert.equal(row.status, 'spawning');
  assert.equal(row.podRevisionAtResume, '1700000004999');
  // Original spawnedAt overwritten on resume per design (re-arms the timer).
  assert.equal(row.spawnedAt, 1_700_000_005_000);
});

test('markAgentRunTerminalV2 captures result + failure detail', () => {
  const p = createProject({
    slug: 'ar-v2-terminal',
    name: 'Terminal',
    stages,
    folderPath: tmpDir,
  });

  const okId = newId();
  insertAgentRunRowV2({
    id: okId,
    projectId: p.id as ULID,
    podName: 'researcher',
    dispatcherSessionId: 'sess-t',
    ccSessionId: 'cc-t-ok',
    status: 'running',
    input: 'q',
    queuedAt: 1_700_000_000_000,
  });
  markAgentRunTerminalV2({
    id: okId,
    status: 'completed',
    result: 'final answer',
    failureCause: null,
    failureReason: null,
    completedAt: 1_700_000_010_000,
  });
  const ok = getAgentRunRowV2(okId)!;
  assert.equal(ok.status, 'completed');
  assert.equal(ok.result, 'final answer');
  assert.equal(ok.completedAt, 1_700_000_010_000);

  const failId = newId();
  insertAgentRunRowV2({
    id: failId,
    projectId: p.id as ULID,
    podName: 'writer',
    dispatcherSessionId: 'sess-t',
    ccSessionId: 'cc-t-fail',
    status: 'running',
    input: 'q',
    queuedAt: 1_700_000_000_000,
  });
  markAgentRunTerminalV2({
    id: failId,
    status: 'failed',
    result: null,
    failureCause: 'idle-timeout',
    failureReason: 'no activity for 5min',
    completedAt: 1_700_000_011_000,
  });
  const fail = getAgentRunRowV2(failId)!;
  assert.equal(fail.status, 'failed');
  assert.equal(fail.failureCause, 'idle-timeout');
  assert.equal(fail.failureReason, 'no activity for 5min');
});

test('findActiveContinuationV2 returns a non-terminal continuation; ignores terminal ones', () => {
  const p = createProject({
    slug: 'ar-v2-cont',
    name: 'Cont',
    stages,
    folderPath: tmpDir,
  });

  const parentId = newId();
  insertAgentRunRowV2({
    id: parentId,
    projectId: p.id as ULID,
    podName: 'researcher',
    dispatcherSessionId: 'sess-cont',
    ccSessionId: 'cc-cont-parent',
    status: 'completed',
    input: 'r1',
    queuedAt: 1_700_000_000_000,
  });
  markAgentRunTerminalV2({
    id: parentId,
    status: 'completed',
    result: 'r1-final',
    failureCause: null,
    failureReason: null,
    completedAt: 1_700_000_005_000,
  });

  // No continuation yet.
  assert.equal(findActiveContinuationV2(parentId), null);

  // Failed continuation does NOT block a fresh one.
  const failedContId = newId();
  insertAgentRunRowV2({
    id: failedContId,
    projectId: p.id as ULID,
    podName: 'researcher',
    dispatcherSessionId: 'sess-cont',
    ccSessionId: 'cc-cont-parent',
    status: 'failed',
    input: 'follow-up',
    continues: parentId,
    queuedAt: 1_700_000_006_000,
  });
  markAgentRunTerminalV2({
    id: failedContId,
    status: 'failed',
    result: null,
    failureCause: 'spawn-stuck',
    failureReason: 'never reached ready',
    completedAt: 1_700_000_007_000,
  });
  assert.equal(findActiveContinuationV2(parentId), null);

  // Live (running) continuation blocks.
  const liveId = newId();
  insertAgentRunRowV2({
    id: liveId,
    projectId: p.id as ULID,
    podName: 'researcher',
    dispatcherSessionId: 'sess-cont',
    ccSessionId: 'cc-cont-parent',
    status: 'running',
    input: 'follow-up-2',
    continues: parentId,
    queuedAt: 1_700_000_010_000,
  });
  const blocking = findActiveContinuationV2(parentId);
  assert.ok(blocking);
  assert.equal(blocking!.id, liveId);
});

test('listAgentRunsForSessionV2 filters by project + session, newest first, with podName + status filters', () => {
  const p = createProject({
    slug: 'ar-v2-list',
    name: 'List',
    stages,
    folderPath: tmpDir,
  });
  const otherP = createProject({
    slug: 'ar-v2-list-foreign',
    name: 'Foreign',
    stages,
    folderPath: tmpDir,
  });

  const a = newId();
  const b = newId();
  const c = newId();
  insertAgentRunRowV2({
    id: a,
    projectId: p.id as ULID,
    podName: 'researcher',
    dispatcherSessionId: 'sess-list',
    ccSessionId: 'cc-a',
    status: 'completed',
    input: 'a',
    queuedAt: 1_700_000_000_000,
  });
  insertAgentRunRowV2({
    id: b,
    projectId: p.id as ULID,
    podName: 'planner',
    dispatcherSessionId: 'sess-list',
    ccSessionId: 'cc-b',
    status: 'running',
    input: 'b',
    queuedAt: 1_700_000_001_000,
  });
  insertAgentRunRowV2({
    id: c,
    projectId: p.id as ULID,
    podName: 'researcher',
    dispatcherSessionId: 'sess-list',
    ccSessionId: 'cc-c',
    status: 'running',
    input: 'c',
    queuedAt: 1_700_000_002_000,
  });
  // Foreign session — must not leak.
  insertAgentRunRowV2({
    id: newId(),
    projectId: otherP.id as ULID,
    podName: 'researcher',
    dispatcherSessionId: 'sess-list',
    ccSessionId: 'cc-foreign',
    status: 'running',
    input: 'x',
    queuedAt: 1_700_000_003_000,
  });

  // All for the session, newest first.
  const all = listAgentRunsForSessionV2(p.id as ULID, 'sess-list', { limit: 10 });
  assert.deepEqual(
    all.map((r) => r.id),
    [c, b, a],
  );

  // By podName.
  const onlyResearcher = listAgentRunsForSessionV2(p.id as ULID, 'sess-list', {
    podName: 'researcher',
    limit: 10,
  });
  assert.deepEqual(
    onlyResearcher.map((r) => r.id),
    [c, a],
  );

  // By status.
  const onlyRunning = listAgentRunsForSessionV2(p.id as ULID, 'sess-list', {
    status: 'running',
    limit: 10,
  });
  assert.deepEqual(
    onlyRunning.map((r) => r.id),
    [c, b],
  );

  // Limit cap honored.
  const oneOnly = listAgentRunsForSessionV2(p.id as ULID, 'sess-list', { limit: 1 });
  assert.equal(oneOnly.length, 1);
  assert.equal(oneOnly[0].id, c);
});

test('reconcileOrphanedRunningRunsV2 flips non-terminal rows to failed/server-restart', () => {
  const p = createProject({
    slug: 'ar-v2-rec',
    name: 'Reconcile',
    stages,
    folderPath: tmpDir,
  });
  const queued = newId();
  const spawning = newId();
  const running = newId();
  const paused = newId();
  const completed = newId();
  const alreadyFailed = newId();

  insertAgentRunRowV2({
    id: queued,
    projectId: p.id as ULID,
    podName: 'researcher',
    dispatcherSessionId: 's',
    ccSessionId: 'cc-q',
    status: 'queued',
    input: 'q',
    queuedAt: 1_700_000_000_000,
  });
  insertAgentRunRowV2({
    id: spawning,
    projectId: p.id as ULID,
    podName: 'researcher',
    dispatcherSessionId: 's',
    ccSessionId: 'cc-s',
    status: 'spawning',
    input: 's',
    queuedAt: 1_700_000_000_000,
  });
  insertAgentRunRowV2({
    id: running,
    projectId: p.id as ULID,
    podName: 'researcher',
    dispatcherSessionId: 's',
    ccSessionId: 'cc-r',
    status: 'running',
    input: 'r',
    queuedAt: 1_700_000_000_000,
  });
  insertAgentRunRowV2({
    id: paused,
    projectId: p.id as ULID,
    podName: 'researcher',
    dispatcherSessionId: 's',
    ccSessionId: 'cc-p',
    status: 'paused',
    input: 'p',
    queuedAt: 1_700_000_000_000,
  });
  insertAgentRunRowV2({
    id: completed,
    projectId: p.id as ULID,
    podName: 'researcher',
    dispatcherSessionId: 's',
    ccSessionId: 'cc-c',
    status: 'running',
    input: 'c',
    queuedAt: 1_700_000_000_000,
  });
  markAgentRunTerminalV2({
    id: completed,
    status: 'completed',
    result: 'done',
    failureCause: null,
    failureReason: null,
    completedAt: 1_700_000_001_000,
  });
  insertAgentRunRowV2({
    id: alreadyFailed,
    projectId: p.id as ULID,
    podName: 'researcher',
    dispatcherSessionId: 's',
    ccSessionId: 'cc-f',
    status: 'running',
    input: 'f',
    queuedAt: 1_700_000_000_000,
  });
  markAgentRunTerminalV2({
    id: alreadyFailed,
    status: 'failed',
    result: null,
    failureCause: 'spawn-stuck',
    failureReason: 'crash',
    completedAt: 1_700_000_001_000,
  });

  const affected = reconcileOrphanedRunningRunsV2(1_700_000_900_000);
  // Shared DB across the test file may contain non-terminal rows from
  // earlier tests; assert "at least these four flipped" rather than an
  // exact count.
  assert.ok(affected >= 4, `expected ≥4 flipped, got ${affected}`);

  for (const id of [queued, spawning, running, paused]) {
    const row = getAgentRunRowV2(id)!;
    assert.equal(row.status, 'failed');
    assert.equal(row.failureCause, 'server-restart');
    assert.equal(row.failureReason, 'server restarted before this run completed');
    assert.equal(row.completedAt, 1_700_000_900_000);
  }
  // Terminal rows untouched.
  assert.equal(getAgentRunRowV2(completed)!.status, 'completed');
  assert.equal(getAgentRunRowV2(alreadyFailed)!.failureCause, 'spawn-stuck');
});
