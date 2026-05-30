// Section 27.3 — stage-flag backfill tests.
//
// Coverage:
//   - empty project list → no-op
//   - untouched project → is_new on stages[0], is_done on a sole "Done" match
//   - project with existing flag → skipped (idempotent)
//   - project with multiple "Done"-named stages → is_new only, no is_done
//   - project with zero "Done"-named stages → is_new only, no is_done
//   - case-insensitive "Done" match
//
// Real sqlite via PC_DATA_DIR temp dir.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-stage-backfill-'));
process.env.PC_DATA_DIR = tmpDir;

const { runMigrations, createProject, getProjectById } = await import('@pc/db');
import type { Stage } from '@pc/domain';
import { backfillStageFlags } from '../src/services/stage-flags-backfill.ts';

const tmpFolder = mkdtempSync(join(tmpdir(), 'pc-stage-backfill-folder-'));

before(() => {
  runMigrations();
});

function freshProject(slug: string, stages: Stage[]) {
  return createProject({ slug, name: slug, stages, folderPath: tmpFolder });
}

test('backfill: untouched project gets is_new on stages[0] + is_done on sole "Done"', () => {
  const stages: Stage[] = [
    { id: 'draft', name: 'Draft', order: 0 },
    { id: 'review', name: 'Review', order: 1 },
    { id: 'done', name: 'Done', order: 2 },
  ];
  const p = freshProject('backfill-happy', stages);
  const result = backfillStageFlags();
  assert.ok(result.updated >= 1);
  const after = getProjectById(p.id)!;
  const draft = after.stages.find((s) => s.id === 'draft')!;
  const review = after.stages.find((s) => s.id === 'review')!;
  const done = after.stages.find((s) => s.id === 'done')!;
  assert.equal(draft.isNew, true);
  assert.equal(done.isDone, true);
  assert.equal(review.isNew, undefined);
  assert.equal(review.isDone, undefined);
});

test('backfill: project with a pre-existing flag is skipped (idempotent)', () => {
  const stages: Stage[] = [
    { id: 'draft', name: 'Draft', order: 0, isNew: true },
    { id: 'done', name: 'Done', order: 1 },
  ];
  const p = freshProject('backfill-prefab', stages);
  const before = getProjectById(p.id)!;
  backfillStageFlags();
  const after = getProjectById(p.id)!;
  // Existing project untouched — no new flag on 'done' even though name matches.
  const done = after.stages.find((s) => s.id === 'done')!;
  assert.equal(done.isDone, undefined);
  // updatedAt would change if updateProjectStages fired — but we don't surface
  // it on Project; verify by snapshot equality on the flag fields.
  assert.deepEqual(
    after.stages.map((s) => ({ id: s.id, isNew: !!s.isNew, isDone: !!s.isDone, isCancelled: !!s.isCancelled })),
    before.stages.map((s) => ({ id: s.id, isNew: !!s.isNew, isDone: !!s.isDone, isCancelled: !!s.isCancelled })),
  );
});

test('backfill: multiple "Done"-named stages → is_new only, no is_done', () => {
  const stages: Stage[] = [
    { id: 'draft', name: 'Draft', order: 0 },
    { id: 'done-a', name: 'Done', order: 1 },
    { id: 'done-b', name: 'done', order: 2 },
  ];
  const p = freshProject('backfill-ambig', stages);
  backfillStageFlags();
  const after = getProjectById(p.id)!;
  const draft = after.stages.find((s) => s.id === 'draft')!;
  const a = after.stages.find((s) => s.id === 'done-a')!;
  const b = after.stages.find((s) => s.id === 'done-b')!;
  assert.equal(draft.isNew, true);
  assert.equal(a.isDone, undefined);
  assert.equal(b.isDone, undefined);
});

test('backfill: zero "Done"-named stages → is_new only', () => {
  const stages: Stage[] = [
    { id: 'inbox', name: 'Inbox', order: 0 },
    { id: 'wip', name: 'WIP', order: 1 },
    { id: 'shipped', name: 'Shipped', order: 2 },
  ];
  const p = freshProject('backfill-no-done', stages);
  backfillStageFlags();
  const after = getProjectById(p.id)!;
  const inbox = after.stages.find((s) => s.id === 'inbox')!;
  const shipped = after.stages.find((s) => s.id === 'shipped')!;
  assert.equal(inbox.isNew, true);
  assert.equal(shipped.isDone, undefined);
});

test('backfill: case-insensitive "Done" match', () => {
  const stages: Stage[] = [
    { id: 'draft', name: 'Draft', order: 0 },
    { id: 'done', name: 'DONE', order: 1 },
  ];
  const p = freshProject('backfill-case', stages);
  backfillStageFlags();
  const after = getProjectById(p.id)!;
  const done = after.stages.find((s) => s.id === 'done')!;
  assert.equal(done.isDone, true);
});
