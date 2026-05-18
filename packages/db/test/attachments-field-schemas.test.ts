// Round-trip tests for the attachments + field-schemas repos. Pins the
// Phase 2b prep contract — these are the storage primitives the
// WorkItemService + FieldSchemaService will call.
//
// Run via:  pnpm --filter @pc/db test
// Or:       pnpm test:unit  (from repo root)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-db-att-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  createWorkItem,
  createAttachment,
  listAttachmentsForWorkItem,
  getAttachment,
  deleteAttachment,
  listFieldSchemas,
  replaceFieldSchemas,
} = await import('../src/index.ts');
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

// --- attachments ------------------------------------------------------------

test('createAttachment + listAttachmentsForWorkItem round-trip', () => {
  const p = createProject({
    slug: 'att-rt',
    name: 'Att RT',
    stages,
    folderPath: tmpDir,
  });
  const wi = createWorkItem({ projectId: p.id as ULID, stageId: 'backlog', title: 'wi' });

  const a = createAttachment({
    workItemId: wi.id,
    kind: 'markdown',
    name: 'findings.md',
    content: '# Findings\n\nhello',
    contentType: 'text/markdown',
  });
  const b = createAttachment({
    workItemId: wi.id,
    kind: 'json',
    name: 'summary.json',
    content: JSON.stringify({ ok: true }),
  });

  const list = listAttachmentsForWorkItem(wi.id);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, a.id);
  assert.equal(list[1].id, b.id);
  assert.equal(list[0].kind, 'markdown');
  assert.equal(list[0].content, '# Findings\n\nhello');
  assert.equal(list[1].contentType, null);
  assert.equal(list[1].runId, null);
});

test('getAttachment returns single row', () => {
  const p = createProject({
    slug: 'att-get',
    name: 'Att Get',
    stages,
    folderPath: tmpDir,
  });
  const wi = createWorkItem({ projectId: p.id as ULID, stageId: 'backlog', title: 'wi' });
  const a = createAttachment({
    workItemId: wi.id,
    kind: 'text',
    name: 'note.txt',
    content: 'hi',
  });
  const fetched = getAttachment(a.id);
  assert.ok(fetched);
  assert.equal(fetched.id, a.id);
  assert.equal(fetched.content, 'hi');
});

test('deleteAttachment removes row + returns true; second delete returns false', () => {
  const p = createProject({
    slug: 'att-del',
    name: 'Att Del',
    stages,
    folderPath: tmpDir,
  });
  const wi = createWorkItem({ projectId: p.id as ULID, stageId: 'backlog', title: 'wi' });
  const a = createAttachment({
    workItemId: wi.id,
    kind: 'text',
    name: 'gone.txt',
    content: 'x',
  });
  assert.equal(deleteAttachment(a.id), true);
  assert.equal(getAttachment(a.id), null);
  assert.equal(deleteAttachment(a.id), false);
});

// --- field schemas ----------------------------------------------------------

test('replaceFieldSchemas inserts then listFieldSchemas returns in order', () => {
  const p = createProject({
    slug: 'fs-insert',
    name: 'FS Insert',
    stages,
    folderPath: tmpDir,
  });
  replaceFieldSchemas({
    projectId: p.id as ULID,
    items: [
      { key: 'sev', label: 'Severity', type: 'enum', options: ['low', 'high'], required: true, order: 0 },
      { key: 'count', label: 'Count', type: 'number', required: false, order: 1 },
    ],
  });
  const list = listFieldSchemas(p.id as ULID);
  assert.equal(list.length, 2);
  assert.equal(list[0].key, 'sev');
  assert.deepEqual(list[0].options, ['low', 'high']);
  assert.equal(list[0].required, true);
  assert.equal(list[1].key, 'count');
  assert.equal(list[1].type, 'number');
});

test('replaceFieldSchemas wipes old rows + inserts new ones (bulk replace semantics)', () => {
  const p = createProject({
    slug: 'fs-replace',
    name: 'FS Replace',
    stages,
    folderPath: tmpDir,
  });
  replaceFieldSchemas({
    projectId: p.id as ULID,
    items: [{ key: 'old', label: 'Old', type: 'text', required: false, order: 0 }],
  });
  replaceFieldSchemas({
    projectId: p.id as ULID,
    items: [{ key: 'new', label: 'New', type: 'text', required: false, order: 0 }],
  });
  const list = listFieldSchemas(p.id as ULID);
  assert.equal(list.length, 1);
  assert.equal(list[0].key, 'new');
});

test('replaceFieldSchemas preserves explicit ids across edits', () => {
  const p = createProject({
    slug: 'fs-ids',
    name: 'FS Ids',
    stages,
    folderPath: tmpDir,
  });
  const initial = replaceFieldSchemas({
    projectId: p.id as ULID,
    items: [{ key: 'a', label: 'A', type: 'text', required: false, order: 0 }],
  });
  const firstId = initial[0].id;
  const next = replaceFieldSchemas({
    projectId: p.id as ULID,
    items: [
      { id: firstId, key: 'a', label: 'A (renamed)', type: 'text', required: true, order: 0 },
    ],
  });
  assert.equal(next[0].id, firstId);
  assert.equal(next[0].label, 'A (renamed)');
  assert.equal(next[0].required, true);
});

test('replaceFieldSchemas with empty items wipes all', () => {
  const p = createProject({
    slug: 'fs-empty',
    name: 'FS Empty',
    stages,
    folderPath: tmpDir,
  });
  replaceFieldSchemas({
    projectId: p.id as ULID,
    items: [{ key: 'k', label: 'K', type: 'text', required: false, order: 0 }],
  });
  replaceFieldSchemas({ projectId: p.id as ULID, items: [] });
  assert.equal(listFieldSchemas(p.id as ULID).length, 0);
});

test('field-schemas are project-scoped (cross-project isolation)', () => {
  const p1 = createProject({
    slug: 'fs-iso-1',
    name: 'P1',
    stages,
    folderPath: tmpDir,
  });
  const p2 = createProject({
    slug: 'fs-iso-2',
    name: 'P2',
    stages,
    folderPath: tmpDir,
  });
  replaceFieldSchemas({
    projectId: p1.id as ULID,
    items: [{ key: 'only-in-p1', label: 'X', type: 'text', required: false, order: 0 }],
  });
  assert.equal(listFieldSchemas(p1.id as ULID).length, 1);
  assert.equal(listFieldSchemas(p2.id as ULID).length, 0);
});
