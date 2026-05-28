// Quick Tasks boot seed regression tests.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDataDir = mkdtempSync(join(tmpdir(), 'pc-quick-tasks-seed-db-'));
process.env.PC_DATA_DIR = tmpDataDir;

const { closeDb, findQuickTasksProject, runMigrations } = await import('@pc/db');
const { ensureQuickTasksProject } = await import('../src/services/quick-tasks-seed.ts');
const { ProjectScaffold } = await import('../src/services/project-scaffold.ts');

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

test('Quick Tasks seed recreates DB row when scaffold repo already exists clean', async () => {
  const folderPath = join(tmpDataDir, 'quick-tasks-workspace');
  mkdirSync(folderPath, { recursive: true });
  git(['init', '-b', 'main'], folderPath);
  writeFileSync(join(folderPath, 'README.md'), 'Quick Tasks\n', 'utf-8');
  git(['add', '.'], folderPath);
  git(['commit', '-m', 'Quick Tasks scaffold'], folderPath);

  const scaffold = {
    writeAll(target: { folderPath: string }) {
      writeFileSync(join(target.folderPath, 'README.md'), 'Quick Tasks\n', 'utf-8');
    },
  } as unknown as InstanceType<typeof ProjectScaffold>;

  const result = await ensureQuickTasksProject({
    dataDir: tmpDataDir,
    scaffold,
  });

  assert.equal(result.action, 'created');
  assert.equal(result.folderPath, folderPath);
  assert.equal(findQuickTasksProject()?.id, result.projectId);
  assert.equal(git(['status', '--porcelain'], folderPath), '');
});
