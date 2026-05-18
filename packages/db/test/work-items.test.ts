// Round-trip tests for the work-items repo. Pins the shape contract that
// Phase 2a relies on: createWorkItem returns the full v2 domain shape,
// listWorkItems sorts by (position, createdAt), moves bump position +
// version, and the new fields (parentId, position, version, timestamps,
// deletedAt) all surface through toDomain.
//
// Run via:  pnpm --filter @pc/db test
// Or:       pnpm test:unit  (from repo root)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// PC_DATA_DIR is consulted lazily on first getDb() — set before importing.
const tmpDir = mkdtempSync(join(tmpdir(), 'pc-db-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, runMigrations, createProject, createWorkItem, listWorkItems, moveWorkItemStage } =
  await import('../src/index.ts');
import type { Stage, ULID } from '@pc/domain';

const stages: Stage[] = [
  { id: 'backlog', name: 'Backlog', order: 0 },
  { id: 'doing', name: 'Doing', order: 1 },
];

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('createWorkItem returns full v2 domain shape', () => {
  const p = createProject({
    slug: 'shape-test',
    name: 'Shape Test',
    stages,
    folderPath: tmpDir,
  });
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'first',
  });

  assert.equal(wi.title, 'first');
  assert.equal(wi.projectId, p.id);
  assert.equal(wi.parentId, null);
  assert.equal(wi.position, 0);
  assert.equal(wi.stageId, 'backlog');
  assert.equal(wi.status, 'pending');
  assert.equal(wi.statusReason, null);
  assert.deepEqual(wi.fields, {});
  assert.equal(wi.body, '');
  assert.equal(wi.version, 1);
  assert.equal(wi.deletedAt, null);
  assert.equal(typeof wi.createdAt, 'number');
  assert.equal(typeof wi.updatedAt, 'number');
});

test('listWorkItems orders by position then createdAt', () => {
  const p = createProject({
    slug: 'ordering',
    name: 'Ordering',
    stages,
    folderPath: tmpDir,
  });
  const projectId = p.id as ULID;

  const a = createWorkItem({ projectId, stageId: 'backlog', title: 'A' });
  const b = createWorkItem({ projectId, stageId: 'backlog', title: 'B' });
  const c = createWorkItem({ projectId, stageId: 'backlog', title: 'C' });

  assert.equal(a.position, 0);
  assert.equal(b.position, 1);
  assert.equal(c.position, 2);

  const list = listWorkItems(projectId);
  assert.deepEqual(
    list.map((x) => x.title),
    ['A', 'B', 'C'],
  );
});

test('moveWorkItemStage assigns next-position in target stage + bumps version', () => {
  const p = createProject({
    slug: 'move-test',
    name: 'Move Test',
    stages,
    folderPath: tmpDir,
  });
  const projectId = p.id as ULID;

  const a = createWorkItem({ projectId, stageId: 'backlog', title: 'A' });
  const b = createWorkItem({ projectId, stageId: 'doing', title: 'B' });

  const moved = moveWorkItemStage(a.id, 'doing');
  assert.ok(moved);
  assert.equal(moved.stageId, 'doing');
  assert.equal(moved.version, 2);
  assert.equal(moved.position, 1);
  assert.equal(moved.position > b.position, true);
});

test('createWorkItem honours explicit position', () => {
  const p = createProject({
    slug: 'explicit-pos',
    name: 'Explicit',
    stages,
    folderPath: tmpDir,
  });
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'pinned',
    position: 99,
  });
  assert.equal(wi.position, 99);
});

test('createWorkItem stores body + fields', () => {
  const p = createProject({
    slug: 'body-fields',
    name: 'Body Fields',
    stages,
    folderPath: tmpDir,
  });
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 't',
    body: 'hello world',
    fields: { severity: 'high', count: 3 },
  });
  assert.equal(wi.body, 'hello world');
  assert.deepEqual(wi.fields, { severity: 'high', count: 3 });
});
