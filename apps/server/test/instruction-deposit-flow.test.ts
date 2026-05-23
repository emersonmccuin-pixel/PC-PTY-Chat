// Section 24.2 — Long-poll service for the agent ready-ping protocol.
//
// Covers the deposit-then-fetch wakeup pattern at the service layer.
// Pairs `awaitInstruction` (the long-poll) with `notifyDeposit` (the
// wakeup primitive) and the repo-layer `depositInstruction` /
// `consumeInstructionForRun` to validate the full path the
// `pc_check_in` HTTP handler exercises.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-server-id-flow-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  newId,
  runMigrations,
  createProject,
  insertAgentRunRow,
  depositInstruction,
  findWaitingForRun,
} = await import('@pc/db');
const {
  awaitInstruction,
  notifyDeposit,
  _resetInstructionEmitterForTests,
} = await import('../src/services/instruction-deposit-service.ts');
import type { Stage, ULID } from '@pc/domain';

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetInstructionEmitterForTests();
});

function seedRun(projectId: ULID, dispatcherSessionId: string = 'orch-1'): ULID {
  const id = newId() as ULID;
  insertAgentRunRow({
    id,
    projectId,
    agentName: 'researcher',
    dispatcherSessionId,
    sessionId: `sess-${id}`,
    input: 'do the thing',
    parentWorkItemId: null,
    parentInvokeDepth: 1,
    continues: null,
    dispatchedAt: 1_700_000_000_000,
  });
  return id;
}

test('awaitInstruction: deposit-before-fetch returns immediately via fast path', async () => {
  const p = createProject({
    slug: 'idf-fast',
    name: 'ID Flow Fast',
    stages,
    folderPath: tmpDir,
  });
  const runId = seedRun(p.id as ULID);
  depositInstruction({
    id: newId() as ULID,
    runId,
    projectId: p.id as ULID,
    dispatcherSessionId: 'orch-1',
    instruction: 'follow up please',
    now: 100,
  });

  const t0 = Date.now();
  const row = await awaitInstruction(runId, { timeoutMs: 5_000 });
  const elapsed = Date.now() - t0;

  assert.ok(row, 'fast-path row returned');
  assert.equal(row.instruction, 'follow up please');
  assert.equal(row.status, 'consumed');
  assert.ok(elapsed < 200, `fast-path returns immediately (took ${elapsed}ms)`);

  // Row is gone — second fetch times out (with a tight window).
  const second = await awaitInstruction(runId, { timeoutMs: 50 });
  assert.equal(second, null, 'no waiting row after first consume');
});

test('awaitInstruction: fetch-before-deposit blocks then resolves on notify', async () => {
  const p = createProject({
    slug: 'idf-block',
    name: 'ID Flow Block',
    stages,
    folderPath: tmpDir,
  });
  const runId = seedRun(p.id as ULID);

  // Kick off the long-poll first; deposit + notify after a small delay.
  const fetched = awaitInstruction(runId, { timeoutMs: 2_000 });

  setTimeout(() => {
    depositInstruction({
      id: newId() as ULID,
      runId,
      projectId: p.id as ULID,
      dispatcherSessionId: 'orch-1',
      instruction: 'arrived later',
      now: 200,
    });
    notifyDeposit(runId);
  }, 30);

  const row = await fetched;
  assert.ok(row, 'long-poll resolved');
  assert.equal(row.instruction, 'arrived later');
  assert.equal(row.status, 'consumed');
});

test('awaitInstruction: returns null on timeout when no deposit lands', async () => {
  const p = createProject({
    slug: 'idf-timeout',
    name: 'ID Flow Timeout',
    stages,
    folderPath: tmpDir,
  });
  const runId = seedRun(p.id as ULID);

  const t0 = Date.now();
  const row = await awaitInstruction(runId, { timeoutMs: 60 });
  const elapsed = Date.now() - t0;

  assert.equal(row, null);
  assert.ok(elapsed >= 60 && elapsed < 1000, `timed out near the window (${elapsed}ms)`);
});

test('awaitInstruction: two concurrent fetchers, one deposit — first wins, second times out', async () => {
  const p = createProject({
    slug: 'idf-race',
    name: 'ID Flow Race',
    stages,
    folderPath: tmpDir,
  });
  const runId = seedRun(p.id as ULID);

  const fetcherA = awaitInstruction(runId, { timeoutMs: 250 });
  const fetcherB = awaitInstruction(runId, { timeoutMs: 250 });

  setTimeout(() => {
    depositInstruction({
      id: newId() as ULID,
      runId,
      projectId: p.id as ULID,
      dispatcherSessionId: 'orch-1',
      instruction: 'race-winner-payload',
      now: 300,
    });
    notifyDeposit(runId);
  }, 20);

  const [resA, resB] = await Promise.all([fetcherA, fetcherB]);

  // Exactly one fetcher gets the row; the other observes null on consume +
  // eventually times out.
  const wins = [resA, resB].filter((r) => r !== null);
  const misses = [resA, resB].filter((r) => r === null);
  assert.equal(wins.length, 1, 'exactly one fetcher consumed the deposit');
  assert.equal(misses.length, 1, 'the other fetcher saw null after timeout');
  assert.equal(wins[0]!.instruction, 'race-winner-payload');

  // Repo state: no waiting row left.
  assert.equal(findWaitingForRun(runId), null);
});

test('notifyDeposit with no listeners is a no-op (does not throw)', () => {
  const p = createProject({
    slug: 'idf-noop',
    name: 'ID Flow Noop',
    stages,
    folderPath: tmpDir,
  });
  const runId = seedRun(p.id as ULID);
  assert.doesNotThrow(() => notifyDeposit(runId));
});
