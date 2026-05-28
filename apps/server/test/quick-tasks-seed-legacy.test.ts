// Quick Tasks legacy-row adoption regression test.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDataDir = mkdtempSync(join(tmpdir(), 'pc-quick-tasks-legacy-db-'));
process.env.PC_DATA_DIR = tmpDataDir;

const { closeDb, createProject, findQuickTasksProject, runMigrations } = await import('@pc/db');
const { ensureQuickTasksProject } = await import('../src/services/quick-tasks-seed.ts');
const { ProjectScaffold } = await import('../src/services/project-scaffold.ts');

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

test('Quick Tasks seed adopts the legacy standard project row', async () => {
  const folderPath = join(tmpDataDir, 'quick-tasks-workspace');
  mkdirSync(folderPath, { recursive: true });
  const legacy = createProject({
    slug: 'quick-tasks',
    name: 'Old Quick Tasks',
    stages: [{ id: 'todo', name: 'Todo', order: 0 }],
    folderPath,
  });

  const scaffold = {
    writeAll() {
      throw new Error('legacy Quick Tasks adoption should not rewrite scaffold');
    },
  } as unknown as InstanceType<typeof ProjectScaffold>;

  const result = await ensureQuickTasksProject({
    dataDir: tmpDataDir,
    scaffold,
  });

  assert.equal(result.action, 'adopted');
  assert.equal(result.projectId, legacy.id);
  const project = findQuickTasksProject();
  assert.equal(project?.id, legacy.id);
  assert.equal(project?.kind, 'quick-tasks');
  assert.equal(project?.name, 'Quick Tasks');
  assert.deepEqual(project?.stages, [
    { id: 'inbox', name: 'Inbox', order: 0, isNew: true },
    { id: 'done', name: 'Done', order: 1, isDone: true },
  ]);
});
