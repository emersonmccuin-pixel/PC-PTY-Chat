// Section 26.8 — boot-time ephemeral work-item sweep tests.
//
// Coverage:
//   - empty DB → no-op
//   - ephemeral + complete + past cutoff → archived (soft-deleted)
//   - non-ephemeral, even if complete + past cutoff → untouched
//   - ephemeral but not yet complete (pending / in-progress / failed /
//     blocked / awaiting-verification) → untouched
//   - ephemeral + complete but still fresh (updatedAt >= cutoff) → untouched
//   - cross-project: candidates from two projects swept in one pass
//   - custom retentionMs honoured
//
// Backdating: tests pass `now: Date.now() + 2 * DAY_MS` so the cutoff
// lands in the future relative to freshly-created rows — qualifying them
// as past-cutoff without having to monkey with the row's updatedAt.
//
// Real sqlite via PC_DATA_DIR temp dir. No HTTP, no spawn.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-ephemeral-sweep-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  createWorkItem,
  getWorkItem,
  getWorkItemIncludingArchived,
  updateWorkItemStatus,
} = await import('@pc/db');

import type { Stage, ULID, WorkItemStatus } from '@pc/domain';
import { sweepEphemeralWorkItems } from '../src/services/ephemeral-work-item-sweep.ts';

const stages: Stage[] = [
  { id: 'backlog', name: 'Backlog', order: 0 },
  { id: 'doing', name: 'Doing', order: 1 },
];

const DAY_MS = 24 * 60 * 60 * 1000;

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

let projectCounter = 0;
function mkProject() {
  projectCounter += 1;
  const slug = `sweep-${projectCounter}-${Date.now()}`;
  return createProject({ slug, name: slug, stages, folderPath: tmpDir });
}

/** Anchor time pushed into the future so freshly-created rows land
 *  "before the cutoff" without DB monkey-patching. */
function futureNow() {
  return Date.now() + 2 * DAY_MS;
}

// ── Tests ──────────────────────────────────────────────────────────────────

test('empty DB → no-op', () => {
  const result = sweepEphemeralWorkItems({ now: Date.now() });
  assert.equal(result.scanned, 0);
  assert.equal(result.archived, 0);
});

test('ephemeral + complete + past cutoff → archived', () => {
  const p = mkProject();
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'throwaway',
    isAgentTask: true,
    ephemeral: true,
  });
  updateWorkItemStatus(wi.id, 'complete');

  const result = sweepEphemeralWorkItems({ now: futureNow() });
  assert.ok(result.scanned >= 1);
  assert.ok(result.archived >= 1);

  // Soft-deleted: listWorkItems / getWorkItem filter it out, but the row
  // exists with deletedAt set + status='archived'.
  assert.equal(getWorkItem(wi.id), null);
  const archived = getWorkItemIncludingArchived(wi.id);
  assert.ok(archived);
  assert.equal(archived!.status, 'archived');
  assert.notEqual(archived!.deletedAt, null);
});

test('non-ephemeral complete row → untouched', () => {
  const p = mkProject();
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'keeper',
    ephemeral: false,
  });
  updateWorkItemStatus(wi.id, 'complete');

  sweepEphemeralWorkItems({ now: futureNow() });
  const fresh = getWorkItem(wi.id);
  assert.ok(fresh);
  assert.equal(fresh!.status, 'complete');
  assert.equal(fresh!.deletedAt, null);
});

test('ephemeral but not yet complete → untouched', () => {
  const p = mkProject();
  const ids: ULID[] = [];
  const nonTerminalStates: WorkItemStatus[] = [
    'pending',
    'in-progress',
    'awaiting-verification',
    'failed',
    'blocked',
  ];
  for (const status of nonTerminalStates) {
    const wi = createWorkItem({
      projectId: p.id as ULID,
      stageId: 'backlog',
      title: `eph-${status}`,
      isAgentTask: true,
      ephemeral: true,
    });
    if (status !== 'pending') updateWorkItemStatus(wi.id, status);
    ids.push(wi.id);
  }

  sweepEphemeralWorkItems({ now: futureNow() });
  for (const id of ids) {
    const row = getWorkItem(id);
    assert.ok(row, 'non-complete ephemeral row must survive the sweep');
    assert.equal(row!.deletedAt, null);
  }
});

test('ephemeral + complete but still fresh → untouched', () => {
  const p = mkProject();
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'fresh-eph',
    isAgentTask: true,
    ephemeral: true,
  });
  updateWorkItemStatus(wi.id, 'complete');

  // Real `now` → cutoff is 24h in the past. Row's updatedAt is just now,
  // so it's >= cutoff and shouldn't get archived.
  sweepEphemeralWorkItems({ now: Date.now() });
  const row = getWorkItem(wi.id);
  assert.ok(row);
  assert.equal(row!.deletedAt, null);
});

test('cross-project sweep: candidates from two projects archived in one pass', () => {
  const pA = mkProject();
  const pB = mkProject();
  const wiA = createWorkItem({
    projectId: pA.id as ULID,
    stageId: 'backlog',
    title: 'eph-A',
    isAgentTask: true,
    ephemeral: true,
  });
  const wiB = createWorkItem({
    projectId: pB.id as ULID,
    stageId: 'backlog',
    title: 'eph-B',
    isAgentTask: true,
    ephemeral: true,
  });
  updateWorkItemStatus(wiA.id, 'complete');
  updateWorkItemStatus(wiB.id, 'complete');

  const result = sweepEphemeralWorkItems({ now: futureNow() });
  assert.ok(result.scanned >= 2);
  assert.ok(result.archived >= 2);
  assert.equal(getWorkItem(wiA.id), null);
  assert.equal(getWorkItem(wiB.id), null);
});

test('custom retentionMs is honoured', () => {
  const p = mkProject();
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'eph-custom-retention',
    isAgentTask: true,
    ephemeral: true,
  });
  updateWorkItemStatus(wi.id, 'complete');

  // Real `now` + huge retention → cutoff way in the past, row is fresh.
  sweepEphemeralWorkItems({ now: Date.now(), retentionMs: 365 * DAY_MS });
  assert.ok(getWorkItem(wi.id), '365d retention must keep fresh rows');

  // Real `now` + zero retention → cutoff == now, anything strictly older
  // qualifies. Bumping status one more time then sweeping with a tiny
  // forward jump ensures the row's updatedAt < cutoff.
  updateWorkItemStatus(wi.id, 'complete');
  sweepEphemeralWorkItems({ now: Date.now() + 1000, retentionMs: 0 });
  assert.equal(getWorkItem(wi.id), null, 'zero retention archives it');
});
