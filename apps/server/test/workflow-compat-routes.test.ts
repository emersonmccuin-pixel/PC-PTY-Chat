import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Hono } from 'hono';
import type { ULID, WorkflowV2 } from '@pc/domain';

import {
  registerWorkflowCompatRoutes,
  type WorkflowCompatRuntime,
} from '../src/features/workflow-compat/routes.ts';

async function json<T>(res: Response): Promise<T> {
  return await res.json() as T;
}

const workflow: WorkflowV2.Workflow = {
  id: 'workflow-a',
  name: 'Workflow A',
  triggers: [],
  nodes: [],
};
const run = {
  id: 'run-1' as ULID,
  projectId: 'project-1' as ULID,
  workflowId: 'workflow-a',
  status: 'failed',
};
const events = [{ id: 'event-1', runId: 'run-1', type: 'node_failed' }];

function makeHarness(opts: {
  reviewStatus?: WorkflowV2.WorkflowRunStatus | null;
  reviewError?: Error;
} = {}) {
  const drafts = new Map<string, WorkflowV2.Workflow>();
  const broadcasts: Array<{ projectId: ULID; msg: unknown }> = [];
  const dismissals: Array<{ runId: ULID; dismissedAt: number }> = [];
  const dismissalLookups: ULID[] = [];
  const runLookups: Array<{ runId: string; projectId: ULID }> = [];
  const eventLookups: ULID[] = [];
  const runListLookups: ULID[] = [];
  const reviewCalls: Array<{
    runId: ULID;
    nodeId: string;
    decision: { kind: 'approve' } | { kind: 'reject'; notes?: string };
  }> = [];
  const runtime: WorkflowCompatRuntime = {
    project: { id: 'project-1' as ULID },
    setWorkflowBuilderDraft: (sessionId, def) => {
      drafts.set(sessionId, def);
    },
    getWorkflowBuilderDraft: (sessionId) => drafts.get(sessionId),
    listV2Workflows: () => ({
      valid: [{ workflow }],
      invalid: [{ slug: 'broken-flow', errors: ['bad node'] }],
    }),
    findV2WorkflowBySlug: (slug) =>
      slug === workflow.id ? { workflow, yamlText: 'id: workflow-a\n' } : null,
    applyV2Review: async (runId, nodeId, decision) => {
      reviewCalls.push({ runId, nodeId, decision });
      if (opts.reviewError) throw opts.reviewError;
      return 'reviewStatus' in opts ? (opts.reviewStatus ?? null) : 'running';
    },
  };
  const app = new Hono();
  registerWorkflowCompatRoutes(app, {
    resolveProject: (projectId) => (projectId === 'project-1' ? runtime : null),
    broadcastTo: (projectId, msg) => broadcasts.push({ projectId, msg }),
    now: () => 12345,
    listFailedRunDismissalsForProject: (projectId) => {
      dismissalLookups.push(projectId);
      return ['run-old' as ULID];
    },
    dismissFailedRun: (runId, dismissedAt) => {
      dismissals.push({ runId, dismissedAt });
      return dismissedAt;
    },
    workflowRunsV2Repo: {
      getRunForProject: (runId, projectId) => {
        runLookups.push({ runId: String(runId), projectId });
        return runId === 'run-1' && projectId === 'project-1' ? (run as never) : null;
      },
      listEvents: (runId) => {
        eventLookups.push(runId);
        return events as never;
      },
      listRunsByProject: (projectId) => {
        runListLookups.push(projectId);
        return [run] as never;
      },
    },
  });

  return {
    app,
    drafts,
    broadcasts,
    dismissals,
    dismissalLookups,
    runLookups,
    eventLookups,
    runListLookups,
    reviewCalls,
  };
}

test('workflow builder draft routes preserve validation, storage, broadcast, and read envelopes', async () => {
  const { app, drafts, broadcasts } = makeHarness();

  let res = await app.request('/api/projects/missing/workflow-builder/draft', {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'sess-1', def: workflow }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await json(res), { ok: false, error: 'unknown project: missing' });

  res = await app.request('/api/projects/project-1/workflow-builder/draft', {
    method: 'POST',
    body: JSON.stringify({ def: workflow }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), { ok: false, error: 'sessionId required' });

  res = await app.request('/api/projects/project-1/workflow-builder/draft', {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'sess-1', def: { name: 'missing id' } }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), { ok: false, error: 'def.id required' });

  res = await app.request('/api/projects/project-1/workflow-builder/draft', {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'sess-1', def: workflow }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true });
  assert.deepEqual(drafts.get('sess-1'), workflow);
  assert.deepEqual(broadcasts, [
    {
      projectId: 'project-1' as ULID,
      msg: { type: 'workflow-builder-draft', sessionId: 'sess-1', def: workflow },
    },
  ]);

  res = await app.request('/api/projects/project-1/workflow-builder/draft/sess-1');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, def: workflow });

  res = await app.request('/api/projects/project-1/workflow-builder/draft/missing');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, def: null });
});

test('failed-run dismissal routes preserve lookup, validation, and mutation envelopes', async () => {
  const { app, dismissalLookups, dismissals, runLookups } = makeHarness();

  let res = await app.request('/api/projects/missing/failed-run-dismissals');
  assert.equal(res.status, 404);
  assert.deepEqual(await json(res), { ok: false, error: 'unknown project: missing' });

  res = await app.request('/api/projects/project-1/failed-run-dismissals');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { runIds: ['run-old'] });
  assert.deepEqual(dismissalLookups, ['project-1']);

  res = await app.request('/api/projects/project-1/workflow-runs/missing-run/dismiss', {
    method: 'POST',
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await json(res), { ok: false, error: 'unknown run: missing-run' });

  res = await app.request('/api/projects/project-1/workflow-runs/run-1/dismiss', {
    method: 'POST',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, dismissedAt: 12345 });
  assert.deepEqual(runLookups, [
    { runId: 'missing-run', projectId: 'project-1' },
    { runId: 'run-1', projectId: 'project-1' },
  ]);
  assert.deepEqual(dismissals, [{ runId: 'run-1' as ULID, dismissedAt: 12345 }]);
});

test('workflow-v2 definition compatibility routes preserve list and get envelopes', async () => {
  const { app } = makeHarness();

  let res = await app.request('/api/projects/project-1/workflow-v2/definitions');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), {
    ok: true,
    valid: [{ id: 'workflow-a', name: 'Workflow A', workflow }],
    invalid: [{ fileName: 'broken-flow.yaml', errors: ['bad node'] }],
  });

  res = await app.request('/api/projects/project-1/workflow-v2/definitions/workflow-a');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), {
    ok: true,
    workflow,
    yamlText: 'id: workflow-a\n',
  });

  res = await app.request('/api/projects/project-1/workflow-v2/definitions/missing');
  assert.equal(res.status, 404);
  assert.deepEqual(await json(res), { ok: false, error: 'workflow not found' });
});

test('workflow-v2 run and review routes preserve envelopes and service delegation', async () => {
  const harness = makeHarness();

  let res = await harness.app.request('/api/projects/project-1/workflow-v2/runs');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, runs: [run] });
  assert.deepEqual(harness.runListLookups, ['project-1']);

  res = await harness.app.request('/api/projects/project-1/workflow-v2/runs/run-1');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, run, events });
  assert.deepEqual(harness.eventLookups, ['run-1']);

  res = await harness.app.request('/api/projects/project-1/workflow-v2/runs/missing');
  assert.equal(res.status, 404);
  assert.deepEqual(await json(res), { ok: false, error: 'run not found' });

  res = await harness.app.request('/api/projects/project-1/workflow-v2/review', {
    method: 'POST',
    body: JSON.stringify({ runId: 'run-1', nodeId: 'review-1', decision: 'maybe' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), {
    ok: false,
    error: 'require { runId, nodeId, decision: approve|reject }',
  });

  res = await harness.app.request('/api/projects/project-1/workflow-v2/review', {
    method: 'POST',
    body: JSON.stringify({ runId: 'run-1', nodeId: 'review-1', decision: 'reject', notes: 'fix it' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, status: 'running' });
  assert.deepEqual(harness.reviewCalls, [
    {
      runId: 'run-1' as ULID,
      nodeId: 'review-1',
      decision: { kind: 'reject', notes: 'fix it' },
    },
  ]);
});

test('workflow-v2 review maps null and thrown outcomes to legacy error envelopes', async () => {
  let harness = makeHarness({ reviewStatus: null });
  let res = await harness.app.request('/api/projects/project-1/workflow-v2/review', {
    method: 'POST',
    body: JSON.stringify({ runId: 'run-1', nodeId: 'review-1', decision: 'approve' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await json(res), { ok: false, error: 'run not found' });

  harness = makeHarness({ reviewError: new Error('not paused') });
  res = await harness.app.request('/api/projects/project-1/workflow-v2/review', {
    method: 'POST',
    body: JSON.stringify({ runId: 'run-1', nodeId: 'review-1', decision: 'approve' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), { ok: false, error: 'not paused' });
});
