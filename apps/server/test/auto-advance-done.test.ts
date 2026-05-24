// Section 27.7 — auto-advance helper tests.
//
// Helper-level coverage (the wider verification-pass-advances-stage behavior
// is exercised via the existing agent-verification tests + the 27.11 smoke
// gate at the route layer).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-auto-advance-'));
process.env.PC_DATA_DIR = tmpDir;

const { runMigrations, createProject, createWorkItem, getWorkItem } = await import('@pc/db');
import type { Stage, ULID } from '@pc/domain';
import { autoAdvanceToDoneStage } from '../src/services/auto-advance-done.ts';

const folder = mkdtempSync(join(tmpdir(), 'pc-auto-advance-folder-'));

before(() => {
  runMigrations();
});

const stagesWithDone: Stage[] = [
  { id: 'draft', name: 'Draft', order: 0, isNew: true },
  { id: 'doing', name: 'Doing', order: 1 },
  { id: 'done', name: 'Done', order: 2, isDone: true },
];

const stagesNoDone: Stage[] = [
  { id: 'draft', name: 'Draft', order: 0 },
  { id: 'doing', name: 'Doing', order: 1 },
];

test('auto-advance: project with is_done stage + WI elsewhere → moves card', () => {
  const p = createProject({ slug: 'aa-happy', name: 'AA Happy', stages: stagesWithDone, folderPath: folder });
  const wi = createWorkItem({ projectId: p.id as ULID, stageId: 'doing', title: 't' });
  const moved = autoAdvanceToDoneStage(wi.id, p);
  assert.ok(moved);
  assert.equal(moved!.stageId, 'done');
  assert.equal(moved!.status, 'complete');
  const persisted = getWorkItem(wi.id);
  assert.equal(persisted!.stageId, 'done');
});

test('auto-advance: project without is_done stage → no-op', () => {
  const p = createProject({ slug: 'aa-nodone', name: 'AA No Done', stages: stagesNoDone, folderPath: folder });
  const wi = createWorkItem({ projectId: p.id as ULID, stageId: 'doing', title: 't' });
  const moved = autoAdvanceToDoneStage(wi.id, p);
  assert.equal(moved, null);
  const persisted = getWorkItem(wi.id);
  assert.equal(persisted!.stageId, 'doing'); // unchanged
});

test('auto-advance: WI already in is_done stage → no-op', () => {
  const p = createProject({ slug: 'aa-already', name: 'AA Already', stages: stagesWithDone, folderPath: folder });
  const wi = createWorkItem({ projectId: p.id as ULID, stageId: 'done', title: 't' });
  const moved = autoAdvanceToDoneStage(wi.id, p);
  assert.equal(moved, null);
});

test('auto-advance: unknown work item id → no-op', () => {
  const p = createProject({ slug: 'aa-unknown', name: 'AA Unknown', stages: stagesWithDone, folderPath: folder });
  const moved = autoAdvanceToDoneStage('01XXXXXXXXXXXXXXXXXXXXXXXX' as ULID, p);
  assert.equal(moved, null);
});
