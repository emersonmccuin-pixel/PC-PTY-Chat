// Section 19.7-live — integration test for ProjectRuntime.moveAndFireV2.
//
// Verifies the wiring contract: a forward stage move invokes the v2
// stage-on-entry matcher and fires every matching workflow with the correct
// trigger payload. `fireV2Workflow` is mocked via method override so the test
// stays focused on the matcher → fire chain (the executor itself is covered by
// dag-run-service.test.ts; the pure matcher by dag-triggers.test.ts).
//
// Run via: pnpm --filter @pc/server test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Project, Stage, ULID, WorkflowV2 } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-prv2-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, runMigrations, createProject, createWorkItem } = await import('@pc/db');
const { ProjectRuntime } = await import('../src/services/project-runtime.ts');

const stages: Stage[] = [
  { id: 'backlog', name: 'Backlog', order: 0 },
  { id: 'review', name: 'Review', order: 1 },
  { id: 'done', name: 'Done', order: 2 },
];

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

interface Fixture {
  runtime: InstanceType<typeof ProjectRuntime>;
  project: Project;
  workItemId: ULID;
  fired: { workflowId: string; trigger: WorkflowV2.WorkflowTrigger }[];
}

let seq = 0;

function writeYaml(folder: string, id: string, body: string): void {
  const dir = resolve(folder, '.project-companion', 'workflows');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${id}.yaml`), body, 'utf-8');
}

function mkFixture(opts: { yamls?: { id: string; body: string }[] } = {}): Fixture {
  seq += 1;
  const folder = resolve(tmpDir, `proj-${String(seq)}`);
  mkdirSync(folder, { recursive: true });
  for (const y of opts.yamls ?? []) writeYaml(folder, y.id, y.body);

  const project = createProject({
    slug: `prv2-${String(seq)}`,
    name: `prv2 ${String(seq)}`,
    stages,
    folderPath: folder,
  }) as unknown as Project;
  const workItem = createWorkItem({
    projectId: project.id as ULID,
    stageId: 'backlog',
    title: 'WI for v2 move',
  });

  const runtime = new ProjectRuntime(project, {
    dataDir: tmpDir,
    channelPort: 0,
    broadcast: () => {},
    templatesDir: resolve(tmpDir, 'templates'),
    trunkPath: tmpDir,
  });
  // Section 19.17 — workflows live in the DB now; the v2 stage-on-entry
  // matcher reads from there, not from the on-disk registry. Bootstrap
  // imports any YAMLs the fixture wrote to disk into DB rows.
  runtime.bootstrap();

  const fired: { workflowId: string; trigger: WorkflowV2.WorkflowTrigger }[] = [];
  runtime.fireV2Workflow = (async (
    workflow: WorkflowV2.Workflow,
    trigger: WorkflowV2.WorkflowTrigger = { kind: 'manual' },
  ) => {
    fired.push({ workflowId: workflow.id, trigger });
    return { runId: 'fake-run' as ULID, rootWorkItemId: 'fake-root' as ULID };
  }) as InstanceType<typeof ProjectRuntime>['fireV2Workflow'];

  return { runtime, project, workItemId: workItem.id as ULID, fired };
}

const REVIEW_V2_YAML = `version: 2
id: review-v2
name: Review V2
worktree: none
triggers:
  - kind: stage-on-entry
    stage: review
nodes:
  - kind: bash
    id: n1
    bash: 'echo ok'
`;

const REVIEW_V2_REGRESS_YAML = `version: 2
id: review-v2-regress
name: Review V2 Regression
worktree: none
triggers:
  - kind: stage-on-entry
    stage: review
    also_fire_on_regression: true
nodes:
  - kind: bash
    id: n1
    bash: 'echo regress'
`;

const REVIEW_V2_DISABLED_YAML = `version: 2
id: review-v2-disabled
name: Review V2 (Disabled)
worktree: none
disabled: true
triggers:
  - kind: stage-on-entry
    stage: review
nodes:
  - kind: bash
    id: n1
    bash: 'echo no'
`;

test('moveAndFireV2: forward move fires the matching v2 stage-on-entry workflow', async () => {
  const f = mkFixture({ yamls: [{ id: 'review-v2', body: REVIEW_V2_YAML }] });

  await f.runtime.moveAndFireV2({ id: f.workItemId, toStage: 'review', expectedVersion: 1 });

  assert.equal(f.fired.length, 1);
  assert.equal(f.fired[0]!.workflowId, 'review-v2');
  assert.deepEqual(f.fired[0]!.trigger, { kind: 'stage-on-entry', stage: 'review' });
});

test('moveAndFireV2: fires every match (no v1-style ambiguity error)', async () => {
  const f = mkFixture({
    yamls: [
      { id: 'review-v2', body: REVIEW_V2_YAML },
      { id: 'review-v2-regress', body: REVIEW_V2_REGRESS_YAML },
    ],
  });

  await f.runtime.moveAndFireV2({ id: f.workItemId, toStage: 'review', expectedVersion: 1 });

  const ids = f.fired.map((x) => x.workflowId).sort();
  assert.deepEqual(ids, ['review-v2', 'review-v2-regress']);
});

test('moveAndFireV2: same-stage move (no-op stage change) fires nothing', async () => {
  const f = mkFixture({ yamls: [{ id: 'review-v2', body: REVIEW_V2_YAML }] });
  // Force the WI into 'review' first via a direct move.
  await f.runtime.moveAndFireV2({ id: f.workItemId, toStage: 'review', expectedVersion: 1 });
  f.fired.length = 0;

  // Move to the same stage. Should be a no-op for v2 firing.
  await f.runtime.moveAndFireV2({
    id: f.workItemId,
    toStage: 'review',
    expectedVersion: 2,
  });
  assert.equal(f.fired.length, 0);
});

test('moveAndFireV2: backward move with no `also_fire_on_regression` fires nothing', async () => {
  const f = mkFixture({ yamls: [{ id: 'review-v2', body: REVIEW_V2_YAML }] });

  // First move: backlog → done (forward; no match on 'done'). Fires nothing.
  await f.runtime.moveAndFireV2({ id: f.workItemId, toStage: 'done', expectedVersion: 1 });
  assert.equal(f.fired.length, 0);

  // Backward: done → review. Default stage-on-entry trigger does NOT fire backward.
  await f.runtime.moveAndFireV2({ id: f.workItemId, toStage: 'review', expectedVersion: 2 });
  assert.equal(f.fired.length, 0);
});

test('moveAndFireV2: backward move fires only the `also_fire_on_regression: true` workflow', async () => {
  const f = mkFixture({
    yamls: [
      { id: 'review-v2', body: REVIEW_V2_YAML }, // forward-only
      { id: 'review-v2-regress', body: REVIEW_V2_REGRESS_YAML }, // both
    ],
  });

  // backlog → done (forward; no match)
  await f.runtime.moveAndFireV2({ id: f.workItemId, toStage: 'done', expectedVersion: 1 });
  assert.equal(f.fired.length, 0);

  // done → review (backward; only the regression-flagged one should fire)
  await f.runtime.moveAndFireV2({ id: f.workItemId, toStage: 'review', expectedVersion: 2 });
  assert.equal(f.fired.length, 1);
  assert.equal(f.fired[0]!.workflowId, 'review-v2-regress');
});

test('moveAndFireV2: disabled workflows never fire', async () => {
  const f = mkFixture({
    yamls: [{ id: 'review-v2-disabled', body: REVIEW_V2_DISABLED_YAML }],
  });

  await f.runtime.moveAndFireV2({ id: f.workItemId, toStage: 'review', expectedVersion: 1 });
  assert.equal(f.fired.length, 0);
});

test('moveAndFireV2: a single fire failure does not block the move or the remaining matches', async () => {
  const f = mkFixture({
    yamls: [
      { id: 'review-v2', body: REVIEW_V2_YAML },
      { id: 'review-v2-regress', body: REVIEW_V2_REGRESS_YAML },
    ],
  });

  let calls = 0;
  // First fire throws; second fire succeeds (and is recorded).
  f.runtime.fireV2Workflow = (async (
    workflow: WorkflowV2.Workflow,
    trigger: WorkflowV2.WorkflowTrigger = { kind: 'manual' },
  ) => {
    calls += 1;
    if (calls === 1) throw new Error('fake fire failure');
    f.fired.push({ workflowId: workflow.id, trigger });
    return { runId: 'fake-run' as ULID, rootWorkItemId: 'fake-root' as ULID };
  }) as InstanceType<typeof ProjectRuntime>['fireV2Workflow'];

  // Should NOT throw — moveAndFireV2 catches per-fire errors.
  const moved = await f.runtime.moveAndFireV2({
    id: f.workItemId,
    toStage: 'review',
    expectedVersion: 1,
  });
  assert.equal(moved.stageId, 'review');
  // One of two fires threw; the other was recorded.
  assert.equal(f.fired.length, 1);
});
