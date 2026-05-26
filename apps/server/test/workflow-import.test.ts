// Section 19.13 — focused tests for the v2 YAML → DB importer that the
// 19.16 schema bundle landed on. Asserts:
//   - valid + invalid + non-v2 YAMLs all sort correctly into DB rows / skip.
//   - re-running is idempotent (no double-insert).
//   - cleanupHealthy deletes YAML files whose DB row is canonical (boot N+1).
//   - cleanupHealthy=false keeps the fixture intact for the second pass.
//
// Run via: pnpm --filter @pc/server test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Stage, ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-wf-import-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, runMigrations, createProject, workflowsRepo } = await import(
  '@pc/db'
);
const { importV2WorkflowsFromDisk } = await import(
  '../src/services/workflow-import.ts'
);

const stages: Stage[] = [
  { id: 'backlog', name: 'Backlog', order: 0 },
  { id: 'done', name: 'Done', order: 1 },
];

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

let seq = 0;
function newProjectAndDir(): { projectId: ULID; dir: string } {
  seq += 1;
  const folder = resolve(tmpDir, `proj-${String(seq)}`);
  const dir = join(folder, '.project-companion', 'workflows');
  mkdirSync(dir, { recursive: true });
  const project = createProject({
    slug: `imp-${String(seq)}`,
    name: `imp ${String(seq)}`,
    stages,
    folderPath: folder,
  });
  return { projectId: project.id as ULID, dir };
}

const VALID_YAML = (id: string, name = id) => `version: 2
id: ${id}
name: ${name}
triggers:
  - kind: manual
nodes:
  - id: a
    kind: bash
    bash: echo hello
`;

const VALID_YAML_2 = (id: string) => `version: 2
id: ${id}
name: ${id} two
description: a two-node chain
triggers:
  - kind: manual
nodes:
  - id: a
    kind: bash
    bash: echo first
    next:
      - b
  - id: b
    kind: bash
    bash: echo second
`;

const INVALID_YAML = (id: string) => `version: 2
id: ${id}
nodes:
  - id: 1bad-id
    kind: bash
    bash: echo
`;

const V1_LEFTOVER_YAML = `name: Some v1 workflow
on:
  stage_enter: review
steps:
  - kind: bash
    bash: echo legacy
`;

test('19.13: valid v2 YAMLs land as active DB rows; invalid as status=invalid', () => {
  const { projectId, dir } = newProjectAndDir();
  writeFileSync(join(dir, 'triage.yaml'), VALID_YAML('triage', 'Triage'));
  writeFileSync(join(dir, 'review-loop.yaml'), VALID_YAML_2('review-loop'));
  writeFileSync(join(dir, 'broken.yaml'), INVALID_YAML('broken'));
  writeFileSync(join(dir, 'legacy.yaml'), V1_LEFTOVER_YAML);

  const out = importV2WorkflowsFromDisk({
    projectId,
    workflowsDir: dir,
    cleanupHealthy: false,
  });
  assert.equal(out.scanned, 4);
  assert.equal(out.imported, 2);
  assert.equal(out.importedInvalid, 1);
  assert.equal(out.skippedNonV2, 1);
  assert.equal(out.alreadyPresent, 0);
  assert.equal(out.yamlFilesDeleted, 0);

  const rows = workflowsRepo.listWorkflows({ projectId });
  const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r]));
  assert.ok(bySlug['triage']);
  assert.equal(bySlug['triage'].status, 'active');
  assert.equal(bySlug['triage'].description, null);
  assert.equal(bySlug['review-loop'].description, 'a two-node chain');
  assert.equal(bySlug['broken'].status, 'invalid');
  assert.ok(bySlug['broken'].parseError);
  assert.equal(bySlug['legacy'], undefined);
});

test('19.13: re-running is idempotent — no double-insert', () => {
  const { projectId, dir } = newProjectAndDir();
  writeFileSync(join(dir, 'triage.yaml'), VALID_YAML('triage'));
  importV2WorkflowsFromDisk({ projectId, workflowsDir: dir, cleanupHealthy: false });
  const first = workflowsRepo.listWorkflows({ projectId });
  assert.equal(first.length, 1);

  const out2 = importV2WorkflowsFromDisk({
    projectId,
    workflowsDir: dir,
    cleanupHealthy: false,
  });
  assert.equal(out2.alreadyPresent, 1);
  assert.equal(out2.imported, 0);
  const second = workflowsRepo.listWorkflows({ projectId });
  assert.equal(second.length, 1);
  assert.equal(second[0].slug, 'triage');
});

test('19.13: cleanupHealthy deletes YAMLs whose DB row is active (boot N+1)', () => {
  const { projectId, dir } = newProjectAndDir();
  const triageFile = join(dir, 'triage.yaml');
  const brokenFile = join(dir, 'broken.yaml');
  writeFileSync(triageFile, VALID_YAML('triage'));
  writeFileSync(brokenFile, INVALID_YAML('broken'));

  // Boot N — leave files in place.
  const bootN = importV2WorkflowsFromDisk({
    projectId,
    workflowsDir: dir,
    cleanupHealthy: false,
  });
  assert.equal(bootN.yamlFilesDeleted, 0);
  assert.ok(existsSync(triageFile));
  assert.ok(existsSync(brokenFile));

  // Boot N+1 — DB rows are canonical; healthy file goes, invalid stays.
  const bootN1 = importV2WorkflowsFromDisk({
    projectId,
    workflowsDir: dir,
    cleanupHealthy: true,
  });
  assert.equal(bootN1.alreadyPresent, 2);
  assert.equal(bootN1.yamlFilesDeleted, 1);
  assert.equal(existsSync(triageFile), false);
  assert.equal(existsSync(brokenFile), true, 'invalid row YAML must survive');
});

test('19.13: missing workflows dir is a clean no-op', () => {
  const { projectId } = newProjectAndDir();
  const out = importV2WorkflowsFromDisk({
    projectId,
    workflowsDir: resolve(tmpDir, 'nope', 'never', 'workflows'),
  });
  assert.equal(out.scanned, 0);
  assert.equal(out.imported, 0);
});
