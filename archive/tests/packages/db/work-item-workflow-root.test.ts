// Section 19.4e — is_workflow_root round-trips through createWorkItem.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-db-wfroot-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, runMigrations, createProject, createWorkItem, getWorkItem } = await import(
  '../src/index.ts'
);
import type { Stage, ULID } from '@pc/domain';

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('is_workflow_root defaults false, persists true when set', () => {
  const p = createProject({ slug: 'wfroot', name: 'wfroot', stages, folderPath: tmpDir });

  const plain = createWorkItem({ projectId: p.id as ULID, stageId: 'backlog', title: 'plain' });
  assert.equal(getWorkItem(plain.id as ULID)!.isWorkflowRoot, false);

  const root = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'run root',
    isWorkflowRoot: true,
  });
  assert.equal(root.isWorkflowRoot, true);
  assert.equal(getWorkItem(root.id as ULID)!.isWorkflowRoot, true);
});
