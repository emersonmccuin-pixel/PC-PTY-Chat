// Section 22.5 — work-item pagination cursor.
//
// Pins the contract that pagination is stable under the repo's
// (position ASC, createdAt ASC) ordering. The 2026-05-25 codebase review
// found the previous cursor compared `id > cursor` against position-sorted
// rows, so any row whose id-order disagreed with its position-order would
// silently skip or duplicate across pages.
//
// Cursor today is opaque (base64-JSON tuple). Tests exercise:
//   1. Page 1 + Page 2 returns every row exactly once.
//   2. Ordering matches the repo's (position, createdAt, id) tuple — so
//      drag-reordered rows still paginate cleanly.
//   3. nextCursor is null on the last page.
//   4. An unparseable cursor is treated as "start over" (no crash).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDataDir = mkdtempSync(join(tmpdir(), 'pc-wi-pagination-'));
process.env.PC_DATA_DIR = tmpDataDir;

const db = await import('@pc/db');
const { closeDb, createProject, createWorkItem, getProjectById, runMigrations } = db;
const { WorkItemService } = await import('../src/services/work-item.ts');
import type { Project, ULID, WorkItem } from '@pc/domain';

runMigrations();

let projectCounter = 0;
function makeProjectFixture(): { projectId: ULID; stage: string; getProject: () => Project } {
  // Each test gets a fresh project so seeded rows don't leak across cases.
  projectCounter += 1;
  const stage = 'todo';
  const slug = `pagination-fixture-${projectCounter}`;
  const project = createProject({
    name: `pagination-fixture-${projectCounter}`,
    slug,
    folderPath: tmpDataDir,
    kind: 'standard',
    stages: [{ id: stage, name: 'Todo', order: 0 }],
    gitRemote: null,
  });
  return {
    projectId: project.id as ULID,
    stage,
    getProject: () => getProjectById(project.id as ULID)!,
  };
}

function makeService(projectId: ULID, getProject: () => Project): InstanceType<typeof WorkItemService> {
  return new WorkItemService({
    projectId,
    getProject,
    getFieldSchemas: () => [],
    broadcast: () => {
      /* no-op */
    },
  });
}

test('22.5: pagination returns every row exactly once across pages', () => {
  const { projectId, stage, getProject } = makeProjectFixture();
  const svc = makeService(projectId, getProject);

  // Insert 5 rows with strictly increasing position values; createdAt grows
  // monotonically with insertion order so the tuple sort is unambiguous.
  const rows: WorkItem[] = [];
  for (let i = 0; i < 5; i++) {
    rows.push(
      createWorkItem({
        projectId,
        title: `row-${i}`,
        stageId: stage,
        body: '',
        position: (i + 1) * 10,
      }),
    );
  }

  // Page of 2 at a time — page1 + page2 + page3 should yield every row, no
  // dupes, in position order.
  const page1 = svc.list({ limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.equal(page1.items[0]!.title, 'row-0');
  assert.equal(page1.items[1]!.title, 'row-1');
  assert.ok(page1.nextCursor);

  const page2 = svc.list({ limit: 2, cursor: page1.nextCursor! });
  assert.equal(page2.items.length, 2);
  assert.equal(page2.items[0]!.title, 'row-2');
  assert.equal(page2.items[1]!.title, 'row-3');
  assert.ok(page2.nextCursor);

  const page3 = svc.list({ limit: 2, cursor: page2.nextCursor! });
  assert.equal(page3.items.length, 1);
  assert.equal(page3.items[0]!.title, 'row-4');
  // Last page: no further rows → nextCursor null.
  assert.equal(page3.nextCursor, null);

  // Union of seen rows equals the seed set.
  const seenTitles = [
    ...page1.items.map((r) => r.title),
    ...page2.items.map((r) => r.title),
    ...page3.items.map((r) => r.title),
  ];
  assert.deepEqual(seenTitles, ['row-0', 'row-1', 'row-2', 'row-3', 'row-4']);
});

test('22.5: drag-reordered rows (id-order disagreeing with position) still paginate cleanly', () => {
  const { projectId, stage, getProject } = makeProjectFixture();
  const svc = makeService(projectId, getProject);

  // Insert in title order A → B → C, then re-position so the desired sort is
  // C, A, B. With the old `id > cursor` bug: cursor=A.id on page 2 would
  // skip C (whose id < A) and only return B → C silently dropped from the
  // result set across pages.
  const rowA = createWorkItem({ projectId, title: 'A', stageId: stage, body: '', position: 20 });
  const rowB = createWorkItem({ projectId, title: 'B', stageId: stage, body: '', position: 30 });
  const rowC = createWorkItem({ projectId, title: 'C', stageId: stage, body: '', position: 10 });

  // Sanity: ULID order is A < B < C, but position order is C < A < B.
  assert.ok(rowA.id < rowB.id);
  assert.ok(rowB.id < rowC.id);

  const page1 = svc.list({ limit: 1 });
  assert.equal(page1.items[0]!.title, 'C');
  const page2 = svc.list({ limit: 1, cursor: page1.nextCursor! });
  assert.equal(page2.items[0]!.title, 'A');
  const page3 = svc.list({ limit: 1, cursor: page2.nextCursor! });
  assert.equal(page3.items[0]!.title, 'B');
  assert.equal(page3.nextCursor, null);
});

test('22.5: unparseable cursor restarts from page 1 (no crash, no skip)', () => {
  const { projectId, stage, getProject } = makeProjectFixture();
  const svc = makeService(projectId, getProject);
  createWorkItem({ projectId, title: 'only', stageId: stage, body: '', position: 10 });

  const result = svc.list({ limit: 10, cursor: 'not-a-valid-cursor' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.title, 'only');
  assert.equal(result.nextCursor, null);
});

test('22.5: ordering matches (position, createdAt, id) tuple — ties on position fall back to createdAt then id', () => {
  const { projectId, stage, getProject } = makeProjectFixture();
  const svc = makeService(projectId, getProject);

  // Two rows with the same position; the older row (smaller createdAt) must
  // come first. Insertion order is deterministic: row1 < row2 in createdAt.
  const row1 = createWorkItem({ projectId, title: 'tie-1', stageId: stage, body: '', position: 5 });
  const row2 = createWorkItem({ projectId, title: 'tie-2', stageId: stage, body: '', position: 5 });
  // Same createdAt timestamp is possible if both inserts land within 1ms.
  // The id tiebreaker handles that case — assert it works.

  const page1 = svc.list({ limit: 1 });
  // Determine expected ordering based on actual seed timestamps.
  const expectedFirst =
    row1.createdAt < row2.createdAt
      ? 'tie-1'
      : row1.createdAt > row2.createdAt
        ? 'tie-2'
        : row1.id < row2.id
          ? 'tie-1'
          : 'tie-2';
  const expectedSecond = expectedFirst === 'tie-1' ? 'tie-2' : 'tie-1';

  assert.equal(page1.items[0]!.title, expectedFirst);
  const page2 = svc.list({ limit: 1, cursor: page1.nextCursor! });
  assert.equal(page2.items[0]!.title, expectedSecond);
});

// Cleanup once the suite ends so the tmpdir isn't kept open.
process.on('beforeExit', () => {
  closeDb();
  try {
    rmSync(tmpDataDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
