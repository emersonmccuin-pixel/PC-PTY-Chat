// Unit tests for WorkflowRuntime.moveAndFire (4c.3 / D36 / D37). Exercises
// the shared move + workflow-firing path that both the drag endpoint and the
// chat/MCP move endpoint route through.
//
// Uses a real SQLite DB at a per-test tmpdir + a real WorkflowRegistry pointed
// at a tmp workflows dir we seed with one YAML. WorktreeService is a tiny
// fake so we can simulate failure modes without touching git.
//
// Run via:  pnpm --filter @pc/server test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-server-mv-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  createWorkItem,
  getWorkItem,
} = await import('@pc/db');
const { WorkflowRuntime } = await import('../src/services/workflow-runtime.ts');
const { WorkItemService, WorkItemVersionConflictError } = await import('../src/services/work-item.ts');
const { WorkflowRegistry } = await import('@pc/workflows');
import type { Project, Stage, ULID } from '@pc/domain';
import type { WorktreeService } from '../src/services/worktree.ts';

const stages: Stage[] = [
  { id: 'backlog', name: 'Backlog', order: 0 },
  { id: 'review', name: 'Review', order: 1 },
  { id: 'done', name: 'Done', order: 2 },
];

const REVIEW_WORKFLOW_YAML = `id: review-research
triggers:
  on_enter:
    stage_id: review
nodes:
  - id: explore
    kind: subagent
    subagent: researcher
    prompt: Look at things.
`;

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

interface RuntimeFixture {
  runtime: InstanceType<typeof WorkflowRuntime>;
  project: Project;
  workItemId: ULID;
  broadcasts: unknown[];
  registry: InstanceType<typeof WorkflowRegistry>;
  worktreeCalls: string[];
  workflowsDir: string;
}

let fixtureSeq = 0;

function mkFixture(opts: { workflowOnReview: boolean; ensureWorktreeFails?: boolean } = {
  workflowOnReview: true,
}): RuntimeFixture {
  const seq = ++fixtureSeq;
  const folder = resolve(tmpDir, `proj-${seq}`);
  mkdirSync(folder, { recursive: true });
  const workflowsDir = resolve(folder, 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  if (opts.workflowOnReview) {
    writeFileSync(resolve(workflowsDir, 'review-research.yaml'), REVIEW_WORKFLOW_YAML, 'utf-8');
  }

  const project = createProject({
    slug: `mv-${seq}`,
    name: `Move test ${seq}`,
    stages,
    folderPath: folder,
  });
  const workItem = createWorkItem({
    projectId: project.id as ULID,
    stageId: 'backlog',
    title: 'WI for move',
  });

  const registry = new WorkflowRegistry(workflowsDir);
  registry.reload();

  const broadcasts: unknown[] = [];
  const broadcast = (event: unknown) => broadcasts.push(event);

  const worktreeCalls: string[] = [];
  const worktreeSvc = {
    async ensureWorktree(name: string) {
      worktreeCalls.push(name);
      if (opts.ensureWorktreeFails) {
        throw new Error(`mock ensureWorktree failure for ${name}`);
      }
      return { path: resolve(folder, 'worktrees', name) };
    },
    ensureScratchDir(_: string) {
      // no-op in test
    },
    sweepStaleScratch() {
      return { removed: [] as string[] };
    },
  } as unknown as WorktreeService;

  const workItemSvc = new WorkItemService({
    projectId: project.id as ULID,
    getProject: () => project,
    getFieldSchemas: () => [],
    broadcast,
  });

  const runtime = new WorkflowRuntime({
    workspaceDir: folder,
    projectId: project.id as ULID,
    broadcast,
    registry,
    worktrees: worktreeSvc,
    workItemService: workItemSvc,
    getProject: () => project,
  });

  return {
    runtime,
    project,
    workItemId: workItem.id as ULID,
    broadcasts,
    registry,
    worktreeCalls,
    workflowsDir,
  };
}

test('moveAndFire: drag (with version) + workflow firing → moves, locks, broadcasts, calls ensureWorktree', async () => {
  const f = mkFixture();
  const result = await f.runtime.moveAndFire({
    id: f.workItemId,
    toStage: 'review',
    expectedVersion: 1,
  });

  // WI was moved to review and locked.
  assert.equal(result.stageId, 'review');
  assert.equal(result.status, 'in-progress');

  // ensureWorktree was called with the WI id.
  assert.deepEqual(f.worktreeCalls, [f.workItemId]);

  // Persistence: the row in the DB matches.
  const persisted = getWorkItem(f.workItemId);
  assert.ok(persisted);
  assert.equal(persisted!.stageId, 'review');
  assert.equal(persisted!.status, 'in-progress');

  // A workflow run was created against this work item.
  const runs = f.runtime.readRunsForProject();
  const runForThisWi = runs.find((r) => r.workItemId === f.workItemId);
  assert.ok(runForThisWi, 'expected a workflow run created for the WI');
  assert.equal(runForThisWi!.workflowId, 'review-research');
  assert.equal(runForThisWi!.stageId, 'review');

  // Broadcast emitted at least the locked-state work-items-changed envelope.
  const lockedBroadcast = f.broadcasts.find(
    (e) =>
      typeof e === 'object' &&
      e !== null &&
      (e as { type?: string }).type === 'work-items-changed' &&
      (e as { workItem?: { status?: string } }).workItem?.status === 'in-progress',
  );
  assert.ok(lockedBroadcast, 'expected a work-items-changed broadcast carrying the locked WI');
});

test('moveAndFire: ambiguous-match → throws "ambiguous trigger" + card stays put', async () => {
  const f = mkFixture();
  // Drop a second YAML on the same stage to create ambiguity.
  const dup = REVIEW_WORKFLOW_YAML.replace('id: review-research', 'id: review-research-2');
  writeFileSync(resolve(f.workflowsDir, 'review-research-2.yaml'), dup, 'utf-8');
  f.registry.reload();

  await assert.rejects(
    () => f.runtime.moveAndFire({ id: f.workItemId, toStage: 'review', expectedVersion: 1 }),
    /ambiguous trigger:.*review/,
  );

  // Card stayed in backlog (status pending, no ensureWorktree call).
  const persisted = getWorkItem(f.workItemId);
  assert.equal(persisted!.stageId, 'backlog');
  assert.equal(persisted!.status, 'pending');
  assert.deepEqual(f.worktreeCalls, []);
});

test('moveAndFire: ensureWorktree throws → card stays put', async () => {
  const f = mkFixture({ workflowOnReview: true, ensureWorktreeFails: true });
  await assert.rejects(
    () => f.runtime.moveAndFire({ id: f.workItemId, toStage: 'review', expectedVersion: 1 }),
    /mock ensureWorktree failure/,
  );
  const persisted = getWorkItem(f.workItemId);
  assert.equal(persisted!.stageId, 'backlog');
  assert.equal(persisted!.status, 'pending');
  assert.deepEqual(f.worktreeCalls, [f.workItemId]);
});

test('moveAndFire: version conflict → throws WorkItemVersionConflictError + card stays put', async () => {
  const f = mkFixture({ workflowOnReview: false });
  await assert.rejects(
    () => f.runtime.moveAndFire({ id: f.workItemId, toStage: 'review', expectedVersion: 99 }),
    WorkItemVersionConflictError,
  );
  const persisted = getWorkItem(f.workItemId);
  assert.equal(persisted!.stageId, 'backlog');
  assert.equal(persisted!.status, 'pending');
});

test('moveAndFire: no workflow on stage (kind=none) + with version → pure move via WorkItemService', async () => {
  const f = mkFixture({ workflowOnReview: false });
  const result = await f.runtime.moveAndFire({
    id: f.workItemId,
    toStage: 'review',
    expectedVersion: 1,
  });
  assert.equal(result.stageId, 'review');
  assert.equal(result.status, 'pending');
  assert.deepEqual(f.worktreeCalls, [], 'no workflow → no ensureWorktree call');
});

test('moveWorkItem: thin wrapper preserves the no-version chat/MCP path', async () => {
  const f = mkFixture({ workflowOnReview: false });
  const result = await f.runtime.moveWorkItem(f.workItemId, 'review');
  assert.equal(result.stageId, 'review');
  assert.equal(result.status, 'pending');
});
