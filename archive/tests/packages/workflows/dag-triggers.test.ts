// Section 19.7 — stage-on-entry trigger matching. Pure unit tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowV2 } from '@pc/domain';
import { isForwardStageMove, firesOnStageEntry, selectStageEntryWorkflows } from '../src/dag/triggers.ts';

const stages = [
  { id: 'draft', order: 0 },
  { id: 'build', order: 1 },
  { id: 'review', order: 2 },
  { id: 'done', order: 3 },
];

function wf(
  id: string,
  triggers: WorkflowV2.WorkflowTrigger[],
  extra: Partial<WorkflowV2.Workflow> = {}
): WorkflowV2.Workflow {
  return { id, name: id, triggers, nodes: [{ kind: 'agent', id: 'a', agent: 'p', task: 't' } as never], ...extra };
}

// --- direction ---

test('forward move (draft → build) is forward', () => {
  assert.equal(isForwardStageMove(stages, { fromStageId: 'draft', toStageId: 'build' }), true);
});

test('backward move (review → build) is not forward', () => {
  assert.equal(isForwardStageMove(stages, { fromStageId: 'review', toStageId: 'build' }), false);
});

test('create-in-place (no from) is forward', () => {
  assert.equal(isForwardStageMove(stages, { fromStageId: null, toStageId: 'build' }), true);
});

test('unknown stage ids fail open (forward)', () => {
  assert.equal(isForwardStageMove(stages, { fromStageId: 'ghost', toStageId: 'build' }), true);
});

// --- firesOnStageEntry ---

const buildOnEntry = wf('w', [{ kind: 'stage-on-entry', stage: 'build' }]);

test('fires on a forward move into its stage', () => {
  assert.equal(firesOnStageEntry(buildOnEntry, { fromStageId: 'draft', toStageId: 'build' }, true), true);
});

test('does NOT fire on a backward move by default', () => {
  assert.equal(firesOnStageEntry(buildOnEntry, { fromStageId: 'review', toStageId: 'build' }, false), false);
});

test('fires on a backward move when also_fire_on_regression', () => {
  const w = wf('w', [{ kind: 'stage-on-entry', stage: 'build', also_fire_on_regression: true }]);
  assert.equal(firesOnStageEntry(w, { fromStageId: 'review', toStageId: 'build' }, false), true);
});

test('does not fire for a different stage', () => {
  assert.equal(firesOnStageEntry(buildOnEntry, { fromStageId: 'build', toStageId: 'review' }, true), false);
});

test('disabled workflow never fires', () => {
  const w = wf('w', [{ kind: 'stage-on-entry', stage: 'build' }], { disabled: true });
  assert.equal(firesOnStageEntry(w, { fromStageId: 'draft', toStageId: 'build' }, true), false);
});

test('manual-only workflow does not fire on stage entry', () => {
  const w = wf('w', [{ kind: 'manual' }]);
  assert.equal(firesOnStageEntry(w, { fromStageId: 'draft', toStageId: 'build' }, true), false);
});

// --- selectStageEntryWorkflows ---

test('selects all enabled matching workflows on a forward move', () => {
  const a = wf('a', [{ kind: 'stage-on-entry', stage: 'build' }]);
  const b = wf('b', [{ kind: 'manual' }, { kind: 'stage-on-entry', stage: 'build' }]);
  const c = wf('c', [{ kind: 'stage-on-entry', stage: 'review' }]); // different stage
  const d = wf('d', [{ kind: 'stage-on-entry', stage: 'build' }], { disabled: true });
  const matched = selectStageEntryWorkflows([a, b, c, d], stages, { fromStageId: 'draft', toStageId: 'build' });
  assert.deepEqual(matched.map((w) => w.id).sort(), ['a', 'b']);
});

test('backward move selects only the also_fire_on_regression workflows', () => {
  const a = wf('a', [{ kind: 'stage-on-entry', stage: 'build' }]);
  const b = wf('b', [{ kind: 'stage-on-entry', stage: 'build', also_fire_on_regression: true }]);
  const matched = selectStageEntryWorkflows([a, b], stages, { fromStageId: 'done', toStageId: 'build' });
  assert.deepEqual(matched.map((w) => w.id), ['b']);
});
