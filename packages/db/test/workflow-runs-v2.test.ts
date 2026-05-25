// Section 19.4b — v2 workflow run sidecar + event-log repo round-trip.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-db-wfv2-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, runMigrations, createProject, workflowRunsV2Repo } = await import('../src/index.ts');
import type { Stage, ULID, WorkflowV2 } from '@pc/domain';

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

before(() => {
  runMigrations();
});
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function mkProject(slug: string): ULID {
  return createProject({ slug, name: slug, stages, folderPath: tmpDir }).id as ULID;
}

test('createRun + getRun round-trips, defaults applied', () => {
  const projectId = mkProject('wfv2-create');
  const run = workflowRunsV2Repo.createRun({
    workflowId: 'build-and-test',
    workflowName: 'Build and test',
    projectId,
    workflowYamlSnapshot: 'name: Build and test\nnodes: []',
    trigger: 'manual',
  });
  assert.equal(run.status, 'pending');
  assert.deepEqual(run.dagState, { nodes: {} });
  assert.equal(run.startedAt, null);

  const got = workflowRunsV2Repo.getRun(run.id);
  assert.ok(got);
  assert.equal(got.workflowId, 'build-and-test');
  assert.equal(got.trigger, 'manual');
  assert.deepEqual(got.dagState, { nodes: {} });
});

test('setDagState persists per-node records + reject iterations', () => {
  const projectId = mkProject('wfv2-dag');
  const run = workflowRunsV2Repo.createRun({
    workflowId: 'wf',
    workflowName: 'wf',
    projectId,
    workflowYamlSnapshot: 'x',
    trigger: 'manual',
  });
  const state: WorkflowV2.WorkflowDagState = {
    nodes: {
      code: { state: 'completed', workItemId: 'wi-1' as ULID, iteration: 2 },
      review: { state: 'awaiting-review' },
    },
    rejectIterations: { review: 1 },
  };
  workflowRunsV2Repo.setDagState(run.id, state);
  const got = workflowRunsV2Repo.getRun(run.id);
  assert.deepEqual(got!.dagState, state);
});

test('markStarted + setStatus terminal stamps endedAt', () => {
  const projectId = mkProject('wfv2-status');
  const run = workflowRunsV2Repo.createRun({
    workflowId: 'wf',
    workflowName: 'wf',
    projectId,
    workflowYamlSnapshot: 'x',
    trigger: 'manual',
  });
  workflowRunsV2Repo.markStarted(run.id);
  let got = workflowRunsV2Repo.getRun(run.id)!;
  assert.equal(got.status, 'running');
  assert.ok(got.startedAt && got.startedAt > 0);
  assert.equal(got.endedAt, null);

  workflowRunsV2Repo.setStatus(run.id, 'failed', { lastReason: 'node x failed' });
  got = workflowRunsV2Repo.getRun(run.id)!;
  assert.equal(got.status, 'failed');
  assert.equal(got.lastReason, 'node x failed');
  assert.ok(got.endedAt && got.endedAt > 0);
});

test('getRunForProject scopes by project (null on mismatch)', () => {
  const a = mkProject('wfv2-scope-a');
  const b = mkProject('wfv2-scope-b');
  const run = workflowRunsV2Repo.createRun({
    workflowId: 'wf',
    workflowName: 'wf',
    projectId: a,
    workflowYamlSnapshot: 'x',
    trigger: 'manual',
  });
  assert.ok(workflowRunsV2Repo.getRunForProject(run.id, a));
  assert.equal(workflowRunsV2Repo.getRunForProject(run.id, b), null);
});

test('getRunByWorkItem + listRunsByProject', () => {
  const projectId = mkProject('wfv2-byitem');
  const wiId = 'wi-root-1' as ULID;
  workflowRunsV2Repo.createRun({
    workflowId: 'wf',
    workflowName: 'wf',
    projectId,
    workflowYamlSnapshot: 'x',
    trigger: 'stage-on-entry',
    stageId: 'build',
    workItemId: wiId,
  });
  const byItem = workflowRunsV2Repo.getRunByWorkItem(wiId);
  assert.ok(byItem);
  assert.equal(byItem.stageId, 'build');
  assert.equal(workflowRunsV2Repo.listRunsByProject(projectId).length, 1);
});

test('appendEvent + listEvents in chronological order', () => {
  const projectId = mkProject('wfv2-events');
  const run = workflowRunsV2Repo.createRun({
    workflowId: 'wf',
    workflowName: 'wf',
    projectId,
    workflowYamlSnapshot: 'x',
    trigger: 'manual',
  });
  workflowRunsV2Repo.appendEvent({ runId: run.id, type: 'workflow_started' });
  workflowRunsV2Repo.appendEvent({ runId: run.id, type: 'node_started', nodeId: 'code' });
  workflowRunsV2Repo.appendEvent({
    runId: run.id,
    type: 'node_completed',
    nodeId: 'code',
    data: { durationMs: 1200 },
  });
  const events = workflowRunsV2Repo.listEvents(run.id);
  assert.deepEqual(
    events.map((e) => e.type),
    ['workflow_started', 'node_started', 'node_completed']
  );
  assert.equal(events[1].nodeId, 'code');
  assert.deepEqual(events[2].data, { durationMs: 1200 });
});
