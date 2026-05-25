// Section 31.11 — statusline snapshot repo tests.
//
// Exercises the persistence + the latest-per-session window-function
// aggregation that powers the Usage tab. The in-memory broadcast path is
// tested at the server route layer; this file focuses on the SQL contract.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ULID } from '@pc/domain';

const tmpDataDir = mkdtempSync(join(tmpdir(), 'pc-statusline-snap-'));
process.env.PC_DATA_DIR = tmpDataDir;

const {
  closeDb,
  createProject,
  getLatestSnapshotForProject,
  insertStatuslineSnapshot,
  listLatestSnapshotPerSession,
  listSnapshotsForProjectSince,
  listSnapshotsForSession,
  newId,
  runMigrations,
} = await import('../src/index.ts');

runMigrations();

const projectA = newId();
const projectB = newId();

before(() => {
  createProject({
    id: projectA,
    slug: 'proj-a',
    name: 'Project A',
    folderPath: '/tmp/proj-a',
    stages: [{ id: 's1', name: 'Stage 1', order: 0 }],
  });
  createProject({
    id: projectB,
    slug: 'proj-b',
    name: 'Project B',
    folderPath: '/tmp/proj-b',
    stages: [{ id: 's1', name: 'Stage 1', order: 0 }],
  });
});

after(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

function makeSnapshot(
  projectId: ULID,
  pcSessionId: string,
  receivedAt: number,
  costUsd: number | null,
  fiveHourPct: number | null = null,
) {
  return {
    id: newId(),
    projectId,
    pcSessionId,
    ccSessionId: `cc-${pcSessionId}`,
    receivedAt,
    modelId: 'claude-opus-4-7',
    modelDisplayName: 'Opus 4.7',
    fiveHourPct,
    fiveHourResetsAt: fiveHourPct != null ? '2026-05-26T00:00:00Z' : null,
    sevenDayPct: null,
    sevenDayResetsAt: null,
    totalCostUsd: costUsd,
    totalDurationMs: 60_000,
    totalApiDurationMs: 5_000,
    contextCurrentUsage: 12_000,
    contextWindowSize: 200_000,
    contextUsedPercentage: 6.0,
  };
}

test('insertStatuslineSnapshot + getLatestSnapshotForProject roundtrip', () => {
  const snap = makeSnapshot(projectA, 'sess-1', 1_000, 0.05, 25);
  insertStatuslineSnapshot(snap);
  const got = getLatestSnapshotForProject(projectA);
  assert.ok(got, 'latest snapshot should exist');
  assert.equal(got!.pcSessionId, 'sess-1');
  assert.equal(got!.totalCostUsd, 0.05);
  assert.equal(got!.fiveHourPct, 25);
  assert.equal(got!.modelDisplayName, 'Opus 4.7');
});

test('getLatestSnapshotForProject picks the newest by received_at', () => {
  insertStatuslineSnapshot(makeSnapshot(projectA, 'sess-1', 2_000, 0.07));
  insertStatuslineSnapshot(makeSnapshot(projectA, 'sess-1', 1_500, 0.06));
  const got = getLatestSnapshotForProject(projectA);
  assert.equal(got!.totalCostUsd, 0.07);
});

test('listLatestSnapshotPerSession returns one row per session (the latest)', () => {
  insertStatuslineSnapshot(makeSnapshot(projectA, 'sess-2', 3_000, 0.10));
  insertStatuslineSnapshot(makeSnapshot(projectA, 'sess-2', 3_500, 0.12));
  insertStatuslineSnapshot(makeSnapshot(projectA, 'sess-3', 4_000, 0.20));
  const rows = listLatestSnapshotPerSession(0);
  const bySession = new Map(rows.map((r) => [r.pcSessionId, r]));
  assert.equal(bySession.get('sess-1')!.totalCostUsd, 0.07);
  assert.equal(bySession.get('sess-2')!.totalCostUsd, 0.12, 'latest sess-2 snapshot wins');
  assert.equal(bySession.get('sess-3')!.totalCostUsd, 0.20);
});

test('listLatestSnapshotPerSession honors the sinceMs window', () => {
  // sess-1, sess-2 have receivedAt <= 3_500; cutoff at 4_000 should drop both.
  const rows = listLatestSnapshotPerSession(4_000);
  const sessions = new Set(rows.map((r) => r.pcSessionId));
  assert.ok(sessions.has('sess-3'));
  assert.ok(!sessions.has('sess-1'));
  assert.ok(!sessions.has('sess-2'));
});

test('listSnapshotsForSession returns every snapshot newest-first', () => {
  const rows = listSnapshotsForSession('sess-2');
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.receivedAt, 3_500);
  assert.equal(rows[1]!.receivedAt, 3_000);
});

test('listSnapshotsForProjectSince filters by project + time', () => {
  insertStatuslineSnapshot(makeSnapshot(projectB, 'sess-B1', 5_000, 0.01));
  const aRows = listSnapshotsForProjectSince(projectA, 0);
  const bRows = listSnapshotsForProjectSince(projectB, 0);
  assert.ok(aRows.every((r) => r.projectId === projectA));
  assert.ok(bRows.every((r) => r.projectId === projectB));
  assert.equal(bRows.length, 1);
});

test('cost-tracking nullable columns roundtrip null', () => {
  const s = makeSnapshot(projectA, 'sess-no-cost', 6_000, 0);
  // Override null fields directly:
  const sNoCost = { ...s, totalCostUsd: null as number | null };
  insertStatuslineSnapshot(sNoCost as never);
  const got = listSnapshotsForSession('sess-no-cost');
  assert.equal(got[0]!.totalCostUsd, null);
});
