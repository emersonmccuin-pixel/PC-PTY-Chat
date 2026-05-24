// Section 27.11 — D39-style smoke gate for the stage-flags surface.
//
// Drives the full flag-aware move + auto-advance loop against a real DB +
// real WorkItemService + real WorkflowRuntime — the same path the HTTP route
// + the MCP tool funnel through (the route layer is a thin parser around
// these services).
//
// Three scenarios covered, the three locks from the buildout:
//   (a) Manual close-to-done via toFlag → status flips to 'complete'.
//   (b) Manual close-to-cancelled via toFlag + notes → status flips to
//       'cancelled', notes land on the history entry.
//   (c) Agent verification PASS auto-advances the contract WI to the
//       is_done stage when one exists.
//
// Plus negative checks: project without flagged stage rejects toFlag cleanly.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-stage-flags-smoke-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  createWorkItem,
  getWorkItem,
  applyAgentVerification,
} = await import('@pc/db');

const { WorkflowRuntime } = await import('../src/services/workflow-runtime.ts');
const { WorkItemService } = await import('../src/services/work-item.ts');
const { WorkflowRegistry } = await import('@pc/workflows');
const { autoAdvanceToDoneStage } = await import('../src/services/auto-advance-done.ts');
import type { Project, Stage, ULID } from '@pc/domain';
import type { WorktreeService } from '../src/services/worktree.ts';

// Default-shaped stages — what new projects get after 27.3.
const defaultStages: Stage[] = [
  { id: 'draft', name: 'Draft', order: 0, isNew: true },
  { id: 'review', name: 'Review', order: 1 },
  { id: 'done', name: 'Done', order: 2, isDone: true },
  { id: 'cancelled', name: 'Cancelled', order: 3, isCancelled: true },
];

let fixtureSeq = 0;

interface Fixture {
  runtime: InstanceType<typeof WorkflowRuntime>;
  project: Project;
  workItemSvc: InstanceType<typeof WorkItemService>;
}

function mkFixture(opts: { stages?: Stage[] } = {}): Fixture {
  const seq = ++fixtureSeq;
  const folder = resolve(tmpDir, `proj-${seq}`);
  mkdirSync(folder, { recursive: true });
  const workflowsDir = resolve(folder, 'workflows');
  mkdirSync(workflowsDir, { recursive: true });

  const project = createProject({
    slug: `sf-${seq}`,
    name: `Stage Flags ${seq}`,
    stages: opts.stages ?? defaultStages,
    folderPath: folder,
  });

  const registry = new WorkflowRegistry(workflowsDir);
  registry.reload();

  const broadcasts: unknown[] = [];
  const broadcast = (event: unknown) => broadcasts.push(event);

  const worktreeSvc = {
    async ensureWorktree(name: string) {
      return { path: resolve(folder, 'worktrees', name) };
    },
    ensureScratchDir(_: string) {},
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

  return { runtime, project, workItemSvc };
}

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('27.11 (a) manual close-to-done via toFlag → status flips to complete', async () => {
  const f = mkFixture();
  const wi = createWorkItem({
    projectId: f.project.id as ULID,
    stageId: 'draft',
    title: 'manual close to done',
  });
  // Mirror the HTTP route: toFlag='done' resolves to the is_done stage.
  const doneStage = f.project.stages.find((s) => s.isDone)!;
  const moved = await f.runtime.moveWorkItem(wi.id, doneStage.id);
  assert.equal(moved.stageId, 'done');
  assert.equal(moved.status, 'complete');
  const persisted = getWorkItem(wi.id);
  assert.equal(persisted!.stageId, 'done');
  assert.equal(persisted!.status, 'complete');
});

test('27.11 (b) close-to-cancelled with notes → status cancelled + note on history', async () => {
  const f = mkFixture();
  const wi = createWorkItem({
    projectId: f.project.id as ULID,
    stageId: 'review',
    title: 'kill this card',
  });
  const cancelledStage = f.project.stages.find((s) => s.isCancelled)!;
  const moved = await f.runtime.moveWorkItem(
    wi.id,
    cancelledStage.id,
    'duplicate of #42',
  );
  assert.equal(moved.stageId, 'cancelled');
  assert.equal(moved.status, 'cancelled');
  const last = moved.history[moved.history.length - 1]!;
  assert.equal(last.kind, 'move');
  assert.equal(last.from, 'review');
  assert.equal(last.to, 'cancelled');
  assert.equal(last.note, 'duplicate of #42');
});

test('27.11 (c) agent verification PASS auto-advances card to is_done stage', async () => {
  const f = mkFixture();
  // Simulate a contract dispatch: WI starts in Review (the agent's working
  // column), agent reports done, verification flips status, auto-advance moves
  // the card to Done.
  const wi = createWorkItem({
    projectId: f.project.id as ULID,
    stageId: 'review',
    title: 'agent contract',
    isAgentTask: true,
    verificationTier: 'auto',
  });

  // Step 1: applyAgentVerification flips status (mirrors what agent-verification.ts
  // does for tier-1 PASS with no predicates).
  const flipped = applyAgentVerification(wi.id, {
    workItemStatus: 'complete',
    statusReason: null,
    verificationStatus: 'passed',
    verificationNotes: null,
    historyNote: 'verification passed (no predicates)',
  });
  assert.equal(flipped!.status, 'complete');
  // Stage hasn't moved yet — auto-advance is the second step.
  assert.equal(flipped!.stageId, 'review');

  // Step 2: autoAdvanceToDoneStage finds the is_done stage and moves.
  const advanced = autoAdvanceToDoneStage(wi.id, f.project);
  assert.ok(advanced, 'auto-advance should fire when project has is_done stage');
  assert.equal(advanced!.stageId, 'done');
  assert.equal(advanced!.status, 'complete');
});

test('27.11 (d) project without is_done stage → auto-advance no-ops cleanly', async () => {
  const f = mkFixture({
    stages: [
      { id: 'draft', name: 'Draft', order: 0, isNew: true },
      { id: 'doing', name: 'Doing', order: 1 },
    ],
  });
  const wi = createWorkItem({
    projectId: f.project.id as ULID,
    stageId: 'doing',
    title: 'no done stage',
    isAgentTask: true,
  });
  applyAgentVerification(wi.id, {
    workItemStatus: 'complete',
    statusReason: null,
    verificationStatus: 'passed',
    verificationNotes: null,
    historyNote: 'verification passed (no predicates)',
  });
  const result = autoAdvanceToDoneStage(wi.id, f.project);
  assert.equal(result, null, 'no auto-advance when project lacks is_done stage');
  const persisted = getWorkItem(wi.id);
  assert.equal(persisted!.stageId, 'doing'); // unchanged
  assert.equal(persisted!.status, 'complete'); // status still flipped
});

test('27.11 (e) cancelled-stage landing flips status to cancelled (not pending)', async () => {
  const f = mkFixture();
  const wi = createWorkItem({
    projectId: f.project.id as ULID,
    stageId: 'draft',
    title: 'check status flip',
  });
  // Drag-to-cancelled — version-checked path through WorkItemService.
  const moved = f.workItemSvc.move(wi.id, {
    expectedVersion: wi.version,
    stageId: 'cancelled',
  });
  assert.equal(moved.stageId, 'cancelled');
  assert.equal(moved.status, 'cancelled');
});
