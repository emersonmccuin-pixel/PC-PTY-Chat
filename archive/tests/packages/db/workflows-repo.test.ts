// Section 19.16 — workflows repo CRUD smoke + audit thread.
//
// Fresh sqlite DB per file, same shape as agent-pods-repo.test.ts. Asserts
// create/get/list/update/soft-delete/restore/duplicate/promote round-trips +
// the audit rows each mutation emits.
//
// Identity: ULID PK + author-readable `slug`. Two projects can both define
// a workflow with slug `triage` (partial UNIQUE scoped per-project).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-db-workflows-repo-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  newId,
  runMigrations,
  createProject,
  workflowsRepo,
  listWorkflowAudit,
} = await import('../src/index.ts');
import type { ULID } from '@pc/domain';
import type { WorkflowAuditInput } from '../src/index.ts';

const U: WorkflowAuditInput = { actor: 'user' };

function fakeProject(slug: string): ULID {
  const id = newId() as ULID;
  createProject({
    id,
    slug,
    name: slug,
    stages: [{ id: 'todo', name: 'Todo', order: 0 }],
    folderPath: '/tmp/' + slug,
  });
  return id;
}

function makeInput(
  slug: string,
  scope: 'global' | 'project',
  projectId: ULID | null = null,
  overrides: Partial<{ name: string; disabled: boolean }> = {},
) {
  return {
    slug,
    scope,
    projectId,
    name: overrides.name ?? slug,
    yaml: `version: 2\nid: ${slug}\nname: ${overrides.name ?? slug}\nnodes: []\n`,
    yamlHash: 'h-' + slug,
    parsedDefinition: { id: slug, version: 2, nodes: [] },
    disabled: overrides.disabled ?? false,
  } as const;
}

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// --- create ----------------------------------------------------------------

test('createWorkflow (global) round-trips defaults + emits created audit row', () => {
  const w = workflowsRepo.createWorkflow(
    makeInput('research-loop', 'global'),
    U,
  );
  assert.equal(w.slug, 'research-loop');
  assert.equal(w.scope, 'global');
  assert.equal(w.projectId, null);
  assert.equal(w.disabled, false);
  assert.equal(w.status, 'active');
  assert.equal(w.origin, 'user-created');
  assert.equal(w.deletedAt, null);
  // ULID PK distinct from slug.
  assert.notEqual(w.id, w.slug);

  const got = workflowsRepo.getWorkflowById(w.id);
  assert.ok(got);
  assert.equal(got.name, 'research-loop');

  const audit = listWorkflowAudit({ workflowId: w.id });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].field, 'created');
  assert.equal(audit[0].actor, 'user');
});

test('createWorkflow (project) rejects missing projectId', () => {
  assert.throws(
    () =>
      workflowsRepo.createWorkflow(
        { slug: 'bad', scope: 'project', name: 'bad', yaml: '', yamlHash: 'h' },
        U,
      ),
    /projectId is required/,
  );
});

test('two projects can share slug `triage` (per-scope partial UNIQUE)', () => {
  const projectA = fakeProject('proj-share-a');
  const projectB = fakeProject('proj-share-b');
  const a = workflowsRepo.createWorkflow(
    makeInput('triage', 'project', projectA, { name: 'A triage' }),
    U,
  );
  const b = workflowsRepo.createWorkflow(
    makeInput('triage', 'project', projectB, { name: 'B triage' }),
    U,
  );
  assert.notEqual(a.id, b.id);
  const lookupA = workflowsRepo.getWorkflowBySlug({
    slug: 'triage',
    scope: 'project',
    projectId: projectA,
  });
  const lookupB = workflowsRepo.getWorkflowBySlug({
    slug: 'triage',
    scope: 'project',
    projectId: projectB,
  });
  assert.equal(lookupA?.id, a.id);
  assert.equal(lookupB?.id, b.id);
});

// --- read / list -----------------------------------------------------------

test('listWorkflows union returns globals ∪ project rows', () => {
  const projectA = fakeProject('proj-list-a');
  const projectB = fakeProject('proj-list-b');
  workflowsRepo.createWorkflow(
    makeInput('a-only', 'project', projectA),
    U,
  );
  workflowsRepo.createWorkflow(
    makeInput('b-only', 'project', projectB),
    U,
  );
  // research-loop already exists as a global.

  const aRows = workflowsRepo.listWorkflows({
    projectId: projectA,
    includeGlobals: true,
  });
  const slugs = aRows.map((r) => r.slug).sort();
  assert.ok(slugs.includes('a-only'));
  assert.ok(slugs.includes('research-loop'));
  assert.ok(!slugs.includes('b-only'), 'project B rows must not leak into A');
});

test('listWorkflows without includeGlobals returns project-only', () => {
  const projectId = fakeProject('proj-narrow');
  workflowsRepo.createWorkflow(
    makeInput('narrow-only', 'project', projectId),
    U,
  );
  const rows = workflowsRepo.listWorkflows({ projectId });
  assert.deepEqual(
    rows.map((r) => r.slug),
    ['narrow-only'],
  );
});

test('getWorkflowByName scopes correctly', () => {
  const projectId = fakeProject('proj-name');
  const g = workflowsRepo.createWorkflow(
    makeInput('share-name-global', 'global', null, { name: 'share' }),
    U,
  );
  const p = workflowsRepo.createWorkflow(
    makeInput('share-name-project', 'project', projectId, { name: 'share' }),
    U,
  );
  const fg = workflowsRepo.getWorkflowByName({ name: 'share', scope: 'global' });
  const fp = workflowsRepo.getWorkflowByName({
    name: 'share',
    scope: 'project',
    projectId,
  });
  assert.equal(fg?.id, g.id);
  assert.equal(fp?.id, p.id);
});

// --- update ----------------------------------------------------------------

test('updateWorkflow emits one audit row per changed field', () => {
  const projectId = fakeProject('proj-update');
  const w = workflowsRepo.createWorkflow(
    makeInput('upd', 'project', projectId, { name: 'upd' }),
    U,
  );
  const before = listWorkflowAudit({ workflowId: w.id }).length;
  const result = workflowsRepo.updateWorkflow(
    w.id,
    { name: 'upd-renamed', disabled: true, description: 'now described' },
    U,
  );
  assert.ok(result);
  assert.equal(result.name, 'upd-renamed');
  assert.equal(result.disabled, true);
  assert.equal(result.description, 'now described');

  const audit = listWorkflowAudit({ workflowId: w.id });
  const newRows = audit.slice(0, audit.length - before);
  const fields = newRows.map((r) => r.field).sort();
  assert.deepEqual(fields, ['description', 'disabled', 'name']);
  const setIds = new Set(newRows.map((r) => r.changeSetId));
  assert.equal(setIds.size, 1);
  assert.ok([...setIds][0], 'changeSetId minted on multi-field edit');
});

test('updateWorkflow no-op returns existing without audit row', () => {
  const projectId = fakeProject('proj-noop');
  const w = workflowsRepo.createWorkflow(makeInput('noop', 'project', projectId), U);
  const before = listWorkflowAudit({ workflowId: w.id }).length;
  const result = workflowsRepo.updateWorkflow(w.id, { name: w.name }, U);
  assert.ok(result);
  const after = listWorkflowAudit({ workflowId: w.id }).length;
  assert.equal(after, before);
});

test('updateWorkflow shadow fields (yamlHash + status + parseError) ride with yaml', () => {
  const projectId = fakeProject('proj-shadow');
  const w = workflowsRepo.createWorkflow(makeInput('shadow', 'project', projectId), U);
  workflowsRepo.updateWorkflow(
    w.id,
    {
      yaml: 'version: 2\nid: shadow\nname: Shadow v2\nnodes: []\n',
      yamlHash: 'new-hash',
      status: 'invalid',
      parseError: 'oops',
    },
    U,
  );
  const got = workflowsRepo.getWorkflowById(w.id);
  assert.ok(got);
  assert.equal(got.yamlHash, 'new-hash');
  assert.equal(got.status, 'invalid');
  assert.equal(got.parseError, 'oops');
  const audit = listWorkflowAudit({ workflowId: w.id });
  const fields = audit.map((r) => r.field);
  assert.ok(fields.includes('yaml'));
});

// --- soft-delete + restore -------------------------------------------------

test('softDeleteWorkflow hides + audit row carries snapshot', () => {
  const projectId = fakeProject('proj-del');
  const w = workflowsRepo.createWorkflow(makeInput('del', 'project', projectId), U);
  const out = workflowsRepo.softDeleteWorkflow(w.id, U);
  assert.ok(out);
  assert.ok(out.deletedAt);
  assert.equal(workflowsRepo.getWorkflowById(w.id), null);

  const restored = workflowsRepo.restoreWorkflow(w.id);
  assert.ok(restored);
  assert.equal(restored.deletedAt, null);

  const audit = listWorkflowAudit({ workflowId: w.id });
  assert.ok(audit.some((r) => r.field === 'deleted'));
  // restore is intentionally NOT audited
  assert.ok(!audit.some((r) => r.field === 'restored'));
});

// --- duplicate -------------------------------------------------------------

test('duplicateWorkflow is force-disabled + audits duplicated_from', () => {
  const projectId = fakeProject('proj-dup');
  const w = workflowsRepo.createWorkflow(makeInput('dup', 'project', projectId), U);
  const clone = workflowsRepo.duplicateWorkflow({ sourceId: w.id }, U);
  assert.equal(clone.slug, 'dup-copy');
  assert.equal(clone.name, 'dup (copy)');
  assert.equal(clone.scope, 'project');
  assert.equal(clone.projectId, projectId);
  assert.equal(clone.disabled, true, 'duplicate must land disabled');
  // ULID PK is fresh — clone is a new row.
  assert.notEqual(clone.id, w.id);

  const audit = listWorkflowAudit({ workflowId: clone.id });
  const dup = audit.find((r) => r.field === 'duplicated_from');
  assert.ok(dup);
  assert.equal(dup.priorValue, w.id);
});

// --- promote-to-global -----------------------------------------------------

test('promoteWorkflowToGlobal flips scope + clears projectId', () => {
  const projectId = fakeProject('proj-promote');
  const w = workflowsRepo.createWorkflow(
    makeInput('promote-me', 'project', projectId),
    U,
  );
  const out = workflowsRepo.promoteWorkflowToGlobal(w.id, U);
  assert.ok(out);
  assert.equal(out.scope, 'global');
  assert.equal(out.projectId, null);

  const audit = listWorkflowAudit({ workflowId: w.id });
  assert.ok(audit.some((r) => r.field === 'scope'));
});

test('promoteWorkflowToGlobal collides on duplicate global slug (UNIQUE)', () => {
  const projectId = fakeProject('proj-collide');
  workflowsRepo.createWorkflow(makeInput('collide', 'global'), U);
  const p = workflowsRepo.createWorkflow(makeInput('collide', 'project', projectId), U);
  assert.throws(() => workflowsRepo.promoteWorkflowToGlobal(p.id, U));
});

test('promoteWorkflowToGlobal rejects already-global', () => {
  const w = workflowsRepo.createWorkflow(makeInput('already-g', 'global'), U);
  assert.throws(
    () => workflowsRepo.promoteWorkflowToGlobal(w.id, U),
    /already global/,
  );
});

// --- dispatch resolution ---------------------------------------------------

test('resolveWorkflowForDispatch prefers project over global', () => {
  const projectId = fakeProject('proj-resolve');
  const g = workflowsRepo.createWorkflow(
    makeInput('resolve', 'global'),
    U,
  );
  const p = workflowsRepo.createWorkflow(
    makeInput('resolve', 'project', projectId),
    U,
  );
  const hit = workflowsRepo.resolveWorkflowForDispatch('resolve', projectId);
  assert.equal(hit?.id, p.id);

  const globalHit = workflowsRepo.resolveWorkflowForDispatch('resolve', null);
  assert.equal(globalHit?.id, g.id);
});

test('countActiveWorkflowsForProject ignores deleted + global', () => {
  const projectId = fakeProject('proj-count');
  workflowsRepo.createWorkflow(makeInput('c1', 'project', projectId), U);
  const w2 = workflowsRepo.createWorkflow(makeInput('c2', 'project', projectId), U);
  workflowsRepo.softDeleteWorkflow(w2.id, U);
  workflowsRepo.createWorkflow(makeInput('c-global', 'global'), U);
  assert.equal(workflowsRepo.countActiveWorkflowsForProject(projectId), 1);
});
