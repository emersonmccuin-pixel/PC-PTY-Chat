// Focused unit tests for 4a.9 runtime-followups primitives. The pure
// decision logic (`isEmptyValue`, `populateRunOutputs` mapping rule) is
// inlined in workflow-runtime.ts; we exercise it via a thin replica so this
// test can run without the DB-bound full runtime.
//
// Full-pipeline coverage (when:false → skipped; done_when violation flips a
// complete to failed; terminated-workflow ping; run.outputs propagates) is
// integration-shaped and runs in the user-test recipe at the end of 4a.
//
// Run via:  pnpm --filter @pc/server test
// Or:       pnpm test:unit  (from repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Workflow, WorkflowRun } from '@pc/domain';

// ── populateRunOutputs replica (matches workflow-runtime.ts) ────────────────

function populateRunOutputs(workflow: Workflow, run: WorkflowRun): void {
  if (!workflow.outputs) return;
  const keys = Object.keys(workflow.outputs);
  if (keys.length === 0) return;
  const captured: Record<string, unknown> = {};
  for (const node of workflow.nodes) {
    const out = run.nodeOutputs[node.id]?.output;
    if (!out || typeof out !== 'object' || Array.isArray(out)) continue;
    const obj = out as Record<string, unknown>;
    for (const key of keys) {
      if (key in obj) captured[key] = obj[key];
    }
  }
  if (Object.keys(captured).length > 0) {
    run.outputs = captured;
  }
}

// ── isEmptyValue replica (matches workflow-runtime.ts) ──────────────────────

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function mkRun(nodeOutputs: WorkflowRun['nodeOutputs'] = {}): WorkflowRun {
  return {
    id: 'run',
    workflowId: 'wf',
    workflowYamlSnapshot: '',
    status: 'in-progress',
    startedAt: new Date().toISOString(),
    worktreePath: null,
    nodeOutputs,
  };
}

// ── populateRunOutputs ──────────────────────────────────────────────────────

test('populateRunOutputs: copies declared keys from node outputs (last-wins)', () => {
  const wf: Workflow = {
    id: 'wf',
    outputs: { result: 'string', count: 'number' },
    nodes: [
      { id: 'a', kind: 'bash', bash: 'x' },
      { id: 'b', kind: 'bash', bash: 'y' },
    ],
  };
  const run = mkRun({
    a: { status: 'complete', output: { result: 'first', count: 1 } },
    b: { status: 'complete', output: { result: 'second' } },
  });
  populateRunOutputs(wf, run);
  // 'result' is overridden by b; 'count' only present in a.
  assert.deepEqual(run.outputs, { result: 'second', count: 1 });
});

test('populateRunOutputs: undeclared keys not copied; declared-absent skipped', () => {
  const wf: Workflow = {
    id: 'wf',
    outputs: { result: 'string' },
    nodes: [{ id: 'a', kind: 'bash', bash: 'x' }],
  };
  const run = mkRun({
    a: { status: 'complete', output: { result: 'hi', extra: 'no' } },
  });
  populateRunOutputs(wf, run);
  assert.deepEqual(run.outputs, { result: 'hi' });
});

test('populateRunOutputs: no outputs declared → run.outputs untouched', () => {
  const wf: Workflow = {
    id: 'wf',
    nodes: [{ id: 'a', kind: 'bash', bash: 'x' }],
  };
  const run = mkRun({ a: { status: 'complete', output: { x: 1 } } });
  populateRunOutputs(wf, run);
  assert.equal(run.outputs, undefined);
});

test('populateRunOutputs: array / scalar node outputs are ignored (no key extraction)', () => {
  const wf: Workflow = {
    id: 'wf',
    outputs: { result: 'string' },
    nodes: [
      { id: 'a', kind: 'bash', bash: 'x' },
      { id: 'b', kind: 'bash', bash: 'y' },
    ],
  };
  const run = mkRun({
    a: { status: 'complete', output: ['result', 'no'] }, // array — ignored
    b: { status: 'complete', output: 'just a string' }, // scalar — ignored
  });
  populateRunOutputs(wf, run);
  assert.equal(run.outputs, undefined);
});

// ── isEmptyValue (done_when output-fields-non-empty contract) ───────────────

test('isEmptyValue: null + undefined → empty', () => {
  assert.equal(isEmptyValue(null), true);
  assert.equal(isEmptyValue(undefined), true);
});

test('isEmptyValue: trimmed-empty string → empty; whitespace-only → empty', () => {
  assert.equal(isEmptyValue(''), true);
  assert.equal(isEmptyValue('   '), true);
  assert.equal(isEmptyValue('\n\t'), true);
});

test('isEmptyValue: non-empty string → NOT empty', () => {
  assert.equal(isEmptyValue('x'), false);
  assert.equal(isEmptyValue(' x '), false);
});

test('isEmptyValue: empty array / object → empty', () => {
  assert.equal(isEmptyValue([]), true);
  assert.equal(isEmptyValue({}), true);
});

test('isEmptyValue: 0 + false → NOT empty (per spec)', () => {
  assert.equal(isEmptyValue(0), false);
  assert.equal(isEmptyValue(false), false);
});
