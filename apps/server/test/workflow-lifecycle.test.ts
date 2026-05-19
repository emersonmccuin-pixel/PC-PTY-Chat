// Unit tests for Section 4f.1 — workflow lifecycle + Work Contract.
// Covers:
//   - WorkflowRuntime.inFlightRunsForWorkflow + cancelRunExternal (D60)
//   - Fire-paths honor `disabled: true` (D62) — drag-fire silent skip;
//     pc_run_workflow throws; nested call-workflow STILL fires (exception)
//   - The four new HTTP routes mirrored into a focused Hono app and exercised
//     via app.fetch(new Request(...)): PUT (edit), DELETE (with + without
//     in-flight runs), cancel-runs-and-delete, duplicate.
//
// Run via:  pnpm --filter @pc/server test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-server-lifecycle-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  createWorkItem,
  getWorkItem,
} = await import('@pc/db');
const { WorkflowRuntime } = await import('../src/services/workflow-runtime.ts');
const { WorkItemService } = await import('../src/services/work-item.ts');
const {
  WorkflowRegistry,
  parseWorkflowText,
  serializeWorkflow,
  validateWorkflow,
} = await import('@pc/workflows');
import type { Project, Stage, ULID } from '@pc/domain';
import type { WorktreeService } from '../src/services/worktree.ts';

const stages: Stage[] = [
  { id: 'backlog', name: 'Backlog', order: 0 },
  { id: 'review', name: 'Review', order: 1 },
];

const REVIEW_WORKFLOW_YAML = `id: review-research
triggers:
  on_enter:
    stage_id: review
nodes:
  - id: explore
    subagent: researcher
    prompt: Look at things.
`;

const CALLABLE_WORKFLOW_YAML = `id: callable-noop
triggers:
  callable: true
worktree: none
nodes:
  - id: stop
    cancel: noop
`;

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

interface Fixture {
  runtime: InstanceType<typeof WorkflowRuntime>;
  project: Project;
  workItemId: ULID;
  broadcasts: unknown[];
  registry: InstanceType<typeof WorkflowRegistry>;
  workflowsDir: string;
  folder: string;
}

let fixtureSeq = 0;

function mkFixture(workflows: Array<{ name: string; yaml: string }>): Fixture {
  const seq = ++fixtureSeq;
  const folder = resolve(tmpDir, `proj-${seq}`);
  mkdirSync(folder, { recursive: true });
  // Match the layout the real route handlers expect:
  // <project>/.project-companion/workflows/<id>.yaml
  const workflowsDir = resolve(folder, '.project-companion', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  for (const w of workflows) {
    writeFileSync(resolve(workflowsDir, `${w.name}.yaml`), w.yaml, 'utf-8');
  }
  const project = createProject({
    slug: `lc-${seq}`,
    name: `Lifecycle ${seq}`,
    stages,
    folderPath: folder,
  });
  const workItem = createWorkItem({
    projectId: project.id as ULID,
    stageId: 'backlog',
    title: 'WI for lifecycle',
  });
  const registry = new WorkflowRegistry(workflowsDir);
  registry.reload();
  const broadcasts: unknown[] = [];
  const broadcast = (event: unknown) => broadcasts.push(event);
  const worktreeSvc = {
    async ensureWorktree(name: string) {
      return { path: resolve(folder, 'worktrees', name) };
    },
    ensureScratchDir() {},
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
    workflowsDir,
    folder,
  };
}

// ── D62 fire-path skips ────────────────────────────────────────────────────

test('4f / D62: drag-fire on disabled workflow is a silent pure move (no run created)', async () => {
  const disabledYaml = REVIEW_WORKFLOW_YAML + '\ndisabled: true\n';
  const f = mkFixture([{ name: 'review-research', yaml: disabledYaml }]);
  const moved = await f.runtime.moveAndFire({
    id: f.workItemId,
    toStage: 'review',
    expectedVersion: 1,
  });
  assert.equal(moved.stageId, 'review');
  // Disabled → no lock, no run.
  assert.equal(moved.status, 'pending');
  const runs = f.runtime.readRunsForProject();
  assert.equal(runs.length, 0, 'disabled workflow must not create a run');
});

test('4f / D62: runWorkflow on disabled workflow throws', async () => {
  const disabledYaml = CALLABLE_WORKFLOW_YAML + '\ndisabled: true\n';
  const f = mkFixture([{ name: 'callable-noop', yaml: disabledYaml }]);
  await assert.rejects(
    () => f.runtime.runWorkflow('callable-noop'),
    /disabled/,
  );
});

// ── D60 in-flight + cancel ─────────────────────────────────────────────────

test('4f / D60: inFlightRunsForWorkflow returns active rows, ignores other workflowIds', async () => {
  const f = mkFixture([{ name: 'callable-noop', yaml: CALLABLE_WORKFLOW_YAML }]);
  const entry = f.registry.snapshot().valid[0]!;
  // Seed two runs for callable-noop and one for a synthetic workflowId.
  const r1 = f.runtime.createRun({
    workflow: entry.workflow,
    yamlText: entry.yamlText,
    trigger: 'callable',
    worktreePath: null,
  });
  const r2 = f.runtime.createRun({
    workflow: { ...entry.workflow, id: 'other-workflow' },
    yamlText: entry.yamlText,
    trigger: 'callable',
    worktreePath: null,
  });

  const inFlight = f.runtime.inFlightRunsForWorkflow('callable-noop');
  const ids = inFlight.map((r) => r.id);
  assert.ok(ids.includes(r1.id), 'matching workflowId row should be returned');
  assert.ok(!ids.includes(r2.id), 'other workflowId row must be excluded');
});

test('4f / D60: cancelRunExternal flips status to cancelled + sets lastReason', async () => {
  const f = mkFixture([{ name: 'callable-noop', yaml: CALLABLE_WORKFLOW_YAML }]);
  const entry = f.registry.snapshot().valid[0]!;
  const run = f.runtime.createRun({
    workflow: entry.workflow,
    yamlText: entry.yamlText,
    trigger: 'callable',
    worktreePath: null,
  });

  const result = await f.runtime.cancelRunExternal(run.id, 'workflow deleted');
  assert.equal(result.ok, true);
  const fresh = f.runtime.readRunForProject(run.id)!;
  assert.equal(fresh.status, 'cancelled');
  assert.equal(fresh.lastReason, 'workflow deleted');
  assert.ok(fresh.completedAt, 'completedAt should be set');
});

test('4f / D60: cancelRunExternal rejects a terminal run', async () => {
  const f = mkFixture([{ name: 'callable-noop', yaml: CALLABLE_WORKFLOW_YAML }]);
  const entry = f.registry.snapshot().valid[0]!;
  const run = f.runtime.createRun({
    workflow: entry.workflow,
    yamlText: entry.yamlText,
    trigger: 'callable',
    worktreePath: null,
  });
  await f.runtime.cancelRunExternal(run.id, 'first');
  const second = await f.runtime.cancelRunExternal(run.id, 'second');
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.match(second.error, /already cancelled/);
  }
});

// ── HTTP route tests via mirror app ─────────────────────────────────────────

async function mirrorApp(f: Fixture) {
  const { Hono } = await import('hono');
  const app = new Hono();

  const broadcastTo = (event: unknown) => f.broadcasts.push(event);

  app.put('/api/projects/:projectId/workflows/:wfId', async (c) => {
    const wfId = c.req.param('wfId');
    const payload = await c.req.json<{ def?: unknown }>();
    if (!payload.def || typeof payload.def !== 'object') {
      return c.json({ ok: false, error: 'def required' }, 400);
    }
    const rawDef = payload.def as Record<string, unknown>;
    if (typeof rawDef.id !== 'string' || rawDef.id !== wfId) {
      return c.json({ ok: false, error: 'id mismatch' }, 400);
    }
    const filePath = resolve(f.workflowsDir, `${wfId}.yaml`);
    if (!existsSync(filePath)) {
      return c.json({ ok: false, error: `unknown workflow: ${wfId}` }, 404);
    }
    const validation = validateWorkflow(rawDef, { expectedId: wfId });
    if (!validation.ok || !validation.workflow) {
      return c.json({ ok: false, errors: validation.errors }, 400);
    }
    writeFileSync(filePath, serializeWorkflow(validation.workflow), 'utf-8');
    const change = validation.workflow.disabled === true ? 'disabled' : 'updated';
    broadcastTo({ type: 'project-workflows-changed', change, id: wfId });
    return c.json({ ok: true });
  });

  app.delete('/api/projects/:projectId/workflows/:wfId', (c) => {
    const wfId = c.req.param('wfId');
    const filePath = resolve(f.workflowsDir, `${wfId}.yaml`);
    if (!existsSync(filePath)) {
      return c.json({ ok: false, error: `unknown workflow: ${wfId}` }, 404);
    }
    const inFlight = f.runtime.inFlightRunsForWorkflow(wfId);
    if (inFlight.length > 0) {
      return c.json(
        {
          ok: false,
          error: 'in-flight runs',
          inFlightRunIds: inFlight.map((r) => r.id),
        },
        409,
      );
    }
    rmSync(filePath);
    broadcastTo({ type: 'project-workflows-changed', change: 'deleted', id: wfId });
    return c.json({ ok: true });
  });

  app.post('/api/projects/:projectId/workflows/:wfId/cancel-runs-and-delete', async (c) => {
    const wfId = c.req.param('wfId');
    const body = await c.req
      .json<{ reason?: string }>()
      .catch(() => ({}) as { reason?: string });
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'workflow deleted';
    const filePath = resolve(f.workflowsDir, `${wfId}.yaml`);
    if (!existsSync(filePath)) {
      return c.json({ ok: false, error: `unknown workflow: ${wfId}` }, 404);
    }
    const inFlight = f.runtime.inFlightRunsForWorkflow(wfId);
    for (const run of inFlight) {
      await f.runtime.cancelRunExternal(run.id, reason);
    }
    rmSync(filePath);
    broadcastTo({ type: 'project-workflows-changed', change: 'deleted', id: wfId });
    return c.json({ ok: true, cancelledRunIds: inFlight.map((r) => r.id) });
  });

  app.post('/api/projects/:projectId/workflows/:wfId/duplicate', async (c) => {
    const wfId = c.req.param('wfId');
    const body = await c.req
      .json<{ newId?: string }>()
      .catch(() => ({}) as { newId?: string });
    const srcPath = resolve(f.workflowsDir, `${wfId}.yaml`);
    if (!existsSync(srcPath)) {
      return c.json({ ok: false, error: `unknown workflow: ${wfId}` }, 404);
    }
    let newId = typeof body.newId === 'string' && body.newId.trim() ? body.newId.trim() : '';
    if (!newId) {
      newId = `${wfId}-copy`;
      let n = 2;
      while (existsSync(resolve(f.workflowsDir, `${newId}.yaml`))) {
        newId = `${wfId}-copy-${n++}`;
      }
    }
    const newPath = resolve(f.workflowsDir, `${newId}.yaml`);
    if (existsSync(newPath)) {
      return c.json({ ok: false, error: `workflow already exists: ${newId}` }, 409);
    }
    const srcText = readFileSync(srcPath, 'utf-8');
    const parsed = parseWorkflowText(srcText, { expectedId: wfId });
    if (!parsed.ok || !parsed.workflow) {
      return c.json({ ok: false, errors: parsed.errors }, 400);
    }
    const cloned = { ...parsed.workflow, id: newId, disabled: true };
    const reVal = validateWorkflow(cloned, { expectedId: newId });
    if (!reVal.ok || !reVal.workflow) {
      return c.json({ ok: false, errors: reVal.errors }, 400);
    }
    writeFileSync(newPath, serializeWorkflow(reVal.workflow), 'utf-8');
    broadcastTo({ type: 'project-workflows-changed', change: 'duplicated', id: newId });
    return c.json({ ok: true, workflow: { id: newId } }, 201);
  });

  return app;
}

test('4f.1 route: PUT edit happy path persists + broadcasts change=updated', async () => {
  const f = mkFixture([{ name: 'callable-noop', yaml: CALLABLE_WORKFLOW_YAML }]);
  const app = await mirrorApp(f);
  const def = {
    id: 'callable-noop',
    triggers: { callable: true },
    description: 'edited via PUT',
    nodes: [{ id: 'stop', cancel: 'noop' }],
  };
  const res = await app.fetch(
    new Request(`http://test.local/api/projects/${f.project.id}/workflows/callable-noop`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def }),
    }),
  );
  assert.equal(res.status, 200);
  const fileText = readFileSync(resolve(f.workflowsDir, 'callable-noop.yaml'), 'utf-8');
  assert.match(fileText, /edited via PUT/);
  const envs = f.broadcasts.filter(
    (e) =>
      typeof e === 'object' &&
      e !== null &&
      (e as { type?: string }).type === 'project-workflows-changed',
  );
  assert.ok(
    envs.some((e) => (e as { change?: string }).change === 'updated'),
    'expected change=updated envelope',
  );
});

test('4f.1 route: PUT flipping disabled:true broadcasts change=disabled', async () => {
  const f = mkFixture([{ name: 'callable-noop', yaml: CALLABLE_WORKFLOW_YAML }]);
  const app = await mirrorApp(f);
  const def = {
    id: 'callable-noop',
    triggers: { callable: true },
    disabled: true,
    nodes: [{ id: 'stop', cancel: 'noop' }],
  };
  const res = await app.fetch(
    new Request(`http://test.local/api/projects/${f.project.id}/workflows/callable-noop`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def }),
    }),
  );
  assert.equal(res.status, 200);
  const envs = f.broadcasts.filter(
    (e) =>
      typeof e === 'object' &&
      e !== null &&
      (e as { type?: string }).type === 'project-workflows-changed',
  );
  assert.ok(
    envs.some((e) => (e as { change?: string }).change === 'disabled'),
    'expected change=disabled envelope',
  );
});

test('4f.1 route: PUT rejects id rename with 400', async () => {
  const f = mkFixture([{ name: 'callable-noop', yaml: CALLABLE_WORKFLOW_YAML }]);
  const app = await mirrorApp(f);
  const def = {
    id: 'different-name',
    triggers: { callable: true },
    nodes: [{ id: 'stop', cancel: 'noop' }],
  };
  const res = await app.fetch(
    new Request(`http://test.local/api/projects/${f.project.id}/workflows/callable-noop`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def }),
    }),
  );
  assert.equal(res.status, 400);
});

test('4f.1 route: DELETE removes the file when no runs are in flight', async () => {
  const f = mkFixture([{ name: 'callable-noop', yaml: CALLABLE_WORKFLOW_YAML }]);
  const app = await mirrorApp(f);
  const res = await app.fetch(
    new Request(`http://test.local/api/projects/${f.project.id}/workflows/callable-noop`, {
      method: 'DELETE',
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(existsSync(resolve(f.workflowsDir, 'callable-noop.yaml')), false);
});

test('4f.1 route: DELETE returns 409 with inFlightRunIds when runs are active', async () => {
  const f = mkFixture([{ name: 'callable-noop', yaml: CALLABLE_WORKFLOW_YAML }]);
  const entry = f.registry.snapshot().valid[0]!;
  const seeded = f.runtime.createRun({
    workflow: entry.workflow,
    yamlText: entry.yamlText,
    trigger: 'callable',
    worktreePath: null,
  });
  const app = await mirrorApp(f);
  const res = await app.fetch(
    new Request(`http://test.local/api/projects/${f.project.id}/workflows/callable-noop`, {
      method: 'DELETE',
    }),
  );
  assert.equal(res.status, 409);
  const json = (await res.json()) as { inFlightRunIds?: string[] };
  assert.deepEqual(json.inFlightRunIds, [seeded.id]);
  // File still on disk; nothing was deleted.
  assert.equal(existsSync(resolve(f.workflowsDir, 'callable-noop.yaml')), true);
});

test('4f.1 route: cancel-runs-and-delete cancels in-flight then removes the file', async () => {
  const f = mkFixture([{ name: 'callable-noop', yaml: CALLABLE_WORKFLOW_YAML }]);
  const entry = f.registry.snapshot().valid[0]!;
  const seeded = f.runtime.createRun({
    workflow: entry.workflow,
    yamlText: entry.yamlText,
    trigger: 'callable',
    worktreePath: null,
  });
  const app = await mirrorApp(f);
  const res = await app.fetch(
    new Request(
      `http://test.local/api/projects/${f.project.id}/workflows/callable-noop/cancel-runs-and-delete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'cleanup' }),
      },
    ),
  );
  assert.equal(res.status, 200);
  const json = (await res.json()) as { cancelledRunIds: string[] };
  assert.deepEqual(json.cancelledRunIds, [seeded.id]);
  // The seeded run is now cancelled.
  const fresh = f.runtime.readRunForProject(seeded.id)!;
  assert.equal(fresh.status, 'cancelled');
  assert.equal(fresh.lastReason, 'cleanup');
  // File gone.
  assert.equal(existsSync(resolve(f.workflowsDir, 'callable-noop.yaml')), false);
});

test('4f.1 route: duplicate writes a force-disabled clone and increments newId on collision', async () => {
  const f = mkFixture([{ name: 'callable-noop', yaml: CALLABLE_WORKFLOW_YAML }]);
  const app = await mirrorApp(f);

  // First duplicate — default `<src>-copy`.
  const r1 = await app.fetch(
    new Request(
      `http://test.local/api/projects/${f.project.id}/workflows/callable-noop/duplicate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    ),
  );
  assert.equal(r1.status, 201);
  const j1 = (await r1.json()) as { workflow: { id: string } };
  assert.equal(j1.workflow.id, 'callable-noop-copy');
  const clonedYaml1 = readFileSync(resolve(f.workflowsDir, 'callable-noop-copy.yaml'), 'utf-8');
  assert.match(clonedYaml1, /^id: callable-noop-copy$/m);
  assert.match(clonedYaml1, /^disabled: true$/m);

  // Second duplicate — should auto-name to `callable-noop-copy-2`.
  const r2 = await app.fetch(
    new Request(
      `http://test.local/api/projects/${f.project.id}/workflows/callable-noop/duplicate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    ),
  );
  assert.equal(r2.status, 201);
  const j2 = (await r2.json()) as { workflow: { id: string } };
  assert.equal(j2.workflow.id, 'callable-noop-copy-2');
});

test('4f.1 route: duplicate with explicit newId that already exists → 409', async () => {
  const f = mkFixture([
    { name: 'callable-noop', yaml: CALLABLE_WORKFLOW_YAML },
    { name: 'already-here', yaml: CALLABLE_WORKFLOW_YAML.replace('callable-noop', 'already-here') },
  ]);
  const app = await mirrorApp(f);
  const res = await app.fetch(
    new Request(
      `http://test.local/api/projects/${f.project.id}/workflows/callable-noop/duplicate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newId: 'already-here' }),
      },
    ),
  );
  assert.equal(res.status, 409);
});

// ── 4f.3 / D64 fireManually + manual-fire HTTP route ────────────────────────

// Reusable yaml templates parameterized by Work Contract. The cancel node
// resolves synchronously on the first tick, but the run row is returned by
// fireManually before that tick fires (via setImmediate), so assertions on
// row creation + trigger='manual' are race-free.
const MANUAL_OPTIONAL_YAML = `id: manual-opt
triggers:
  callable: true
worktree: none
nodes:
  - id: stop
    cancel: noop
`;
const MANUAL_REQUIRED_YAML = `id: manual-req
attached_to_work_item: required
triggers:
  callable: true
worktree: none
nodes:
  - id: stop
    cancel: noop
`;
const MANUAL_FORBIDDEN_YAML = `id: manual-forb
attached_to_work_item: forbidden
triggers:
  callable: true
worktree: none
nodes:
  - id: stop
    cancel: noop
`;
const MANUAL_OPT_WITH_INPUTS_YAML = `id: manual-with-inputs
attached_to_work_item: optional
triggers:
  callable: true
worktree: none
inputs:
  workItemId: ULID
  stageId: string
  customerName: string
nodes:
  - id: stop
    cancel: noop
`;

test('4f.3 / D64 runtime: fireManually happy path (optional contract, no workItemId) creates a manual-trigger run', async () => {
  const f = mkFixture([{ name: 'manual-opt', yaml: MANUAL_OPTIONAL_YAML }]);
  const run = await f.runtime.fireManually({ workflowId: 'manual-opt' });
  assert.equal(run.trigger, 'manual');
  assert.equal(run.workItemId, undefined);
  assert.equal(run.workflowId, 'manual-opt');
});

test('4f.3 / D64 runtime: fireManually with workItemId fills natural-context inputs + locks the card', async () => {
  const f = mkFixture([{ name: 'manual-with-inputs', yaml: MANUAL_OPT_WITH_INPUTS_YAML }]);
  const run = await f.runtime.fireManually({
    workflowId: 'manual-with-inputs',
    workItemId: f.workItemId,
    inputs: { customerName: 'Acme Co' },
  });
  assert.equal(run.trigger, 'manual');
  assert.equal(run.workItemId, f.workItemId);
  assert.equal(run.stageId, 'backlog'); // natural context from card's current stage
  // Natural-context fill for declared inputs + user override layered on top.
  assert.deepEqual(run.inputs, {
    workItemId: f.workItemId,
    stageId: 'backlog',
    customerName: 'Acme Co',
  });
  // Card lock — symmetric with drag-fire's moveAndFire path.
  const wi = getWorkItem(f.workItemId);
  assert.equal(wi?.status, 'in-progress');
});

test('4f.3 / D64 runtime: required contract without workItemId throws "requires a work item"', async () => {
  const f = mkFixture([{ name: 'manual-req', yaml: MANUAL_REQUIRED_YAML }]);
  await assert.rejects(
    () => f.runtime.fireManually({ workflowId: 'manual-req' }),
    /requires a work item to run/,
  );
});

test('4f.3 / D64 runtime: forbidden contract with workItemId throws "cannot be attached"', async () => {
  const f = mkFixture([{ name: 'manual-forb', yaml: MANUAL_FORBIDDEN_YAML }]);
  await assert.rejects(
    () => f.runtime.fireManually({ workflowId: 'manual-forb', workItemId: f.workItemId }),
    /cannot be attached to a work item/,
  );
});

test('4f.3 / D62 runtime: fireManually on disabled workflow throws "is disabled"', async () => {
  const disabledYaml = MANUAL_OPTIONAL_YAML + '\ndisabled: true\n';
  const f = mkFixture([{ name: 'manual-opt', yaml: disabledYaml }]);
  await assert.rejects(
    () => f.runtime.fireManually({ workflowId: 'manual-opt' }),
    /is disabled/,
  );
});

test('4f.3 runtime: unknown workflow id throws "unknown workflow"', async () => {
  const f = mkFixture([{ name: 'manual-opt', yaml: MANUAL_OPTIONAL_YAML }]);
  await assert.rejects(
    () => f.runtime.fireManually({ workflowId: 'does-not-exist' }),
    /unknown workflow/,
  );
});

test('4f.3 runtime: fireManually on a locked work item rejects', async () => {
  const f = mkFixture([{ name: 'manual-with-inputs', yaml: MANUAL_OPT_WITH_INPUTS_YAML }]);
  // First fire locks the card.
  await f.runtime.fireManually({
    workflowId: 'manual-with-inputs',
    workItemId: f.workItemId,
  });
  // Second fire while the lock is still in place must reject.
  await assert.rejects(
    () =>
      f.runtime.fireManually({
        workflowId: 'manual-with-inputs',
        workItemId: f.workItemId,
      }),
    /is locked: workflow in progress/,
  );
});

test('4f.3 HTTP route: POST /workflows/:wfId/fire — required without workItemId → 400; with workItemId → 200 + manual trigger persisted', async () => {
  const { Hono } = await import('hono');
  const f = mkFixture([{ name: 'manual-req', yaml: MANUAL_REQUIRED_YAML }]);
  const app = new Hono();
  // Mirror the production route shape (apps/server/src/index.ts).
  app.post('/api/projects/:projectId/workflows/:wfId/fire', async (c) => {
    const wfId = c.req.param('wfId');
    const body = await c.req
      .json<{ workItemId?: string; inputs?: Record<string, unknown> }>()
      .catch(() => ({}) as { workItemId?: string; inputs?: Record<string, unknown> });
    try {
      const run = await f.runtime.fireManually({
        workflowId: wfId,
        ...(body.workItemId ? { workItemId: body.workItemId } : {}),
        ...(body.inputs ? { inputs: body.inputs } : {}),
      });
      return c.json({ ok: true, runId: run.id });
    } catch (err) {
      const msg = (err as Error).message;
      if (/^unknown workflow:|^no valid workflow|^ambiguous workflow id/.test(msg)) {
        return c.json({ ok: false, error: msg }, 404);
      }
      if (/ is disabled$| is locked: workflow in progress$/.test(msg)) {
        return c.json({ ok: false, error: msg }, 409);
      }
      if (
        / requires a work item to run$| cannot be attached to a work item$|^unknown work item:/.test(
          msg,
        )
      ) {
        return c.json({ ok: false, error: msg }, 400);
      }
      return c.json({ ok: false, error: msg }, 500);
    }
  });

  // Missing workItemId for `required` → 400.
  const missing = await app.fetch(
    new Request(`http://test.local/api/projects/${f.project.id}/workflows/manual-req/fire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
  );
  assert.equal(missing.status, 400);
  const missingJson = (await missing.json()) as { error: string };
  assert.match(missingJson.error, /requires a work item/);

  // With workItemId → 200, runId returned, run persisted with trigger='manual'.
  const ok = await app.fetch(
    new Request(`http://test.local/api/projects/${f.project.id}/workflows/manual-req/fire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workItemId: f.workItemId }),
    }),
  );
  assert.equal(ok.status, 200);
  const okJson = (await ok.json()) as { ok: boolean; runId: string };
  assert.equal(okJson.ok, true);
  assert.ok(okJson.runId);
  const persisted = f.runtime.readRunForProject(okJson.runId)!;
  assert.equal(persisted.trigger, 'manual');
  assert.equal(persisted.workItemId, f.workItemId);
});

test('4f.3 HTTP route: forbidden contract with workItemId → 400', async () => {
  const { Hono } = await import('hono');
  const f = mkFixture([{ name: 'manual-forb', yaml: MANUAL_FORBIDDEN_YAML }]);
  const app = new Hono();
  app.post('/api/projects/:projectId/workflows/:wfId/fire', async (c) => {
    const wfId = c.req.param('wfId');
    const body = await c.req
      .json<{ workItemId?: string }>()
      .catch(() => ({}) as { workItemId?: string });
    try {
      const run = await f.runtime.fireManually({
        workflowId: wfId,
        ...(body.workItemId ? { workItemId: body.workItemId } : {}),
      });
      return c.json({ ok: true, runId: run.id });
    } catch (err) {
      const msg = (err as Error).message;
      if (/ cannot be attached to a work item$/.test(msg)) {
        return c.json({ ok: false, error: msg }, 400);
      }
      return c.json({ ok: false, error: msg }, 500);
    }
  });

  const res = await app.fetch(
    new Request(`http://test.local/api/projects/${f.project.id}/workflows/manual-forb/fire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workItemId: f.workItemId }),
    }),
  );
  assert.equal(res.status, 400);
  const json = (await res.json()) as { error: string };
  assert.match(json.error, /cannot be attached to a work item/);
});

test('4f.3 HTTP route: disabled workflow → 409', async () => {
  const { Hono } = await import('hono');
  const disabledYaml = MANUAL_OPTIONAL_YAML + '\ndisabled: true\n';
  const f = mkFixture([{ name: 'manual-opt', yaml: disabledYaml }]);
  const app = new Hono();
  app.post('/api/projects/:projectId/workflows/:wfId/fire', async (c) => {
    const wfId = c.req.param('wfId');
    try {
      const run = await f.runtime.fireManually({ workflowId: wfId });
      return c.json({ ok: true, runId: run.id });
    } catch (err) {
      const msg = (err as Error).message;
      if (/ is disabled$/.test(msg)) return c.json({ ok: false, error: msg }, 409);
      return c.json({ ok: false, error: msg }, 500);
    }
  });
  const res = await app.fetch(
    new Request(`http://test.local/api/projects/${f.project.id}/workflows/manual-opt/fire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
  );
  assert.equal(res.status, 409);
  const json = (await res.json()) as { error: string };
  assert.match(json.error, /is disabled/);
});
