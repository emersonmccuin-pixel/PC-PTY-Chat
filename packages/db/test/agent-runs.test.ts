// Section 21 — agent_runs repo round-trip. Pins the shape pc_continue_agent
// (21.3) + pc_list_my_runs (21.4) consume.
//
// Run via:  pnpm --filter @pc/db test
// Or:       pnpm test:unit  (from repo root)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-db-ar-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  newId,
  runMigrations,
  createProject,
  insertAgentRunRow,
  markAgentRunTerminal,
  getAgentRunRow,
  listAgentRunsForSession,
  findActiveContinuation,
  reconcileOrphanedRunningRuns,
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

function insertRow(opts: {
  projectId: ULID;
  dispatcherSessionId: string;
  agentName?: string;
  input?: string;
  continues?: ULID | null;
  dispatchedAt: number;
}): ULID {
  const id = newId() as ULID;
  insertAgentRunRow({
    id,
    projectId: opts.projectId,
    agentName: opts.agentName ?? 'researcher',
    dispatcherSessionId: opts.dispatcherSessionId,
    sessionId: `sess-${id}`,
    input: opts.input ?? 'do the thing',
    parentWorkItemId: null,
    parentInvokeDepth: 1,
    continues: opts.continues ?? null,
    dispatchedAt: opts.dispatchedAt,
  });
  return id;
}

test('listAgentRunsForSession: filters by projectId + dispatcherSessionId, newest first', () => {
  const a = createProject({ slug: 'ar-list-a', name: 'AR List A', stages, folderPath: tmpDir });
  const b = createProject({ slug: 'ar-list-b', name: 'AR List B', stages, folderPath: tmpDir });
  const idA1 = insertRow({
    projectId: a.id as ULID,
    dispatcherSessionId: 'orch-1',
    dispatchedAt: 1_700_000_000_000,
    input: 'first',
  });
  const idA2 = insertRow({
    projectId: a.id as ULID,
    dispatcherSessionId: 'orch-1',
    dispatchedAt: 1_700_000_005_000,
    input: 'second',
  });
  // Same dispatcherSessionId but different project — must NOT leak.
  insertRow({
    projectId: b.id as ULID,
    dispatcherSessionId: 'orch-1',
    dispatchedAt: 1_700_000_010_000,
    input: 'leaked from B',
  });
  // Same project but different dispatcher — must NOT leak.
  insertRow({
    projectId: a.id as ULID,
    dispatcherSessionId: 'orch-2',
    dispatchedAt: 1_700_000_015_000,
    input: 'other orchestrator',
  });

  const rows = listAgentRunsForSession(a.id as ULID, 'orch-1', { limit: 20 });
  assert.equal(rows.length, 2, 'project + dispatcher scope returns only A/orch-1 rows');
  assert.equal(rows[0]!.id, idA2, 'newest first');
  assert.equal(rows[1]!.id, idA1);
  assert.equal(rows[0]!.input, 'second');
});

test('listAgentRunsForSession: optional agentName + status + limit filters', () => {
  const p = createProject({ slug: 'ar-list-filt', name: 'AR Filt', stages, folderPath: tmpDir });
  insertRow({
    projectId: p.id as ULID,
    dispatcherSessionId: 'orch-x',
    agentName: 'researcher',
    dispatchedAt: 1,
  });
  const writerRunning = insertRow({
    projectId: p.id as ULID,
    dispatcherSessionId: 'orch-x',
    agentName: 'writer',
    dispatchedAt: 2,
  });
  const writerCompleted = insertRow({
    projectId: p.id as ULID,
    dispatcherSessionId: 'orch-x',
    agentName: 'writer',
    dispatchedAt: 3,
  });
  markAgentRunTerminal({
    id: writerCompleted,
    status: 'completed',
    result: 'ok',
    failureReason: null,
    failureCause: null,
    completedAt: 4,
  });

  const writers = listAgentRunsForSession(p.id as ULID, 'orch-x', {
    agentName: 'writer',
    limit: 20,
  });
  assert.equal(writers.length, 2);
  assert.ok(writers.every((r) => r.agentName === 'writer'));

  const writersDone = listAgentRunsForSession(p.id as ULID, 'orch-x', {
    agentName: 'writer',
    status: 'completed',
    limit: 20,
  });
  assert.equal(writersDone.length, 1);
  assert.equal(writersDone[0]!.id, writerCompleted);

  const writersRunning = listAgentRunsForSession(p.id as ULID, 'orch-x', {
    agentName: 'writer',
    status: 'running',
    limit: 20,
  });
  assert.equal(writersRunning.length, 1);
  assert.equal(writersRunning[0]!.id, writerRunning);

  const capped = listAgentRunsForSession(p.id as ULID, 'orch-x', { limit: 1 });
  assert.equal(capped.length, 1, 'limit cap respected');
});

test('findActiveContinuation: returns running continuation; null after terminal', () => {
  const p = createProject({ slug: 'ar-cont', name: 'AR Cont', stages, folderPath: tmpDir });
  const parent = insertRow({
    projectId: p.id as ULID,
    dispatcherSessionId: 'orch-c',
    dispatchedAt: 100,
  });
  markAgentRunTerminal({
    id: parent,
    status: 'completed',
    result: 'parent done',
    failureReason: null,
    failureCause: null,
    completedAt: 200,
  });
  const cont = insertRow({
    projectId: p.id as ULID,
    dispatcherSessionId: 'orch-c',
    continues: parent,
    dispatchedAt: 300,
  });
  const active = findActiveContinuation(parent);
  assert.equal(active?.id, cont, 'in-flight continuation found');

  markAgentRunTerminal({
    id: cont,
    status: 'completed',
    result: 'cont done',
    failureReason: null,
    failureCause: null,
    completedAt: 400,
  });
  assert.equal(
    findActiveContinuation(parent),
    null,
    'no active continuation after terminal flip',
  );
});

test('getAgentRunRow: round-trips continues + sessionId + input verbatim', () => {
  const p = createProject({ slug: 'ar-rt', name: 'AR RT', stages, folderPath: tmpDir });
  const longInput = 'a'.repeat(500); // verify input is stored in full, not summary-trimmed
  const parent = insertRow({
    projectId: p.id as ULID,
    dispatcherSessionId: 'orch-rt',
    dispatchedAt: 1,
    input: longInput,
  });
  const cont = insertRow({
    projectId: p.id as ULID,
    dispatcherSessionId: 'orch-rt',
    dispatchedAt: 2,
    continues: parent,
  });
  const row = getAgentRunRow(cont)!;
  assert.equal(row.continues, parent, 'continues link round-trips');
  assert.equal(row.sessionId, `sess-${cont}`, 'sessionId round-trips');
  const parentRow = getAgentRunRow(parent)!;
  assert.equal(parentRow.input.length, 500, 'long input stored in full (not summary-trimmed)');
});

test('reconcileOrphanedRunningRuns: flips stuck running rows to failed/server-restart', () => {
  const p = createProject({ slug: 'ar-orph', name: 'AR Orphan', stages, folderPath: tmpDir });
  const stuck = insertRow({
    projectId: p.id as ULID,
    dispatcherSessionId: 'orch-orph',
    dispatchedAt: 1,
  });
  const completed = insertRow({
    projectId: p.id as ULID,
    dispatcherSessionId: 'orch-orph',
    dispatchedAt: 2,
  });
  markAgentRunTerminal({
    id: completed,
    status: 'completed',
    result: 'done',
    failureReason: null,
    failureCause: null,
    completedAt: 3,
  });

  const before = getAgentRunRow(stuck)!;
  assert.equal(before.status, 'running');

  const changed = reconcileOrphanedRunningRuns(99_999);
  assert.ok(changed >= 1, 'at least the stuck row reconciled');
  const after = getAgentRunRow(stuck)!;
  assert.equal(after.status, 'failed');
  assert.equal(after.failureCause, 'server-restart');
  assert.equal(after.completedAt, 99_999);

  // Already-terminal row must be untouched.
  const completedAfter = getAgentRunRow(completed)!;
  assert.equal(completedAfter.status, 'completed');
});
