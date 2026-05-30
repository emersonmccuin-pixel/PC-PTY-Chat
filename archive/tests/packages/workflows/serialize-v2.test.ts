// Section 19 — v2 workflow serialize/parse round-trip + version discrimination.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowV2 } from '@pc/domain';
import { serializeWorkflowV2, parseWorkflowV2Text, WORKFLOW_V2_VERSION } from '../src/serialize-v2.ts';

const sample: WorkflowV2.Workflow = {
  id: 'build-and-test',
  name: 'Build and test',
  description: 'Code, test, review.',
  worktree: 'auto',
  max_concurrency: 4,
  triggers: [
    { kind: 'stage-on-entry', stage: 'build' },
    { kind: 'manual' },
  ],
  nodes: [
    { kind: 'agent', id: 'code', agent: 'code-writer', task: 'write the code', next: ['review'] },
    {
      kind: 'orchestrator-review',
      id: 'review',
      bundle_from: ['code'],
      reject: { back_to: 'code', max_iterations: 3, carry: { feedback: '$self.output.notes' } },
    },
  ],
};

test('serialize → parse round-trips a valid v2 workflow', () => {
  const yaml = serializeWorkflowV2(sample);
  assert.match(yaml, /^version: 2/m);
  const r = parseWorkflowV2Text(yaml);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.workflow, sample);
});

test('serialized YAML keeps node kind on disk', () => {
  const yaml = serializeWorkflowV2(sample);
  assert.match(yaml, /kind: agent/);
  assert.match(yaml, /kind: orchestrator-review/);
});

test('parse marks a non-v2 (v1) document as notV2', () => {
  const v1Yaml = 'id: legacy\ntriggers:\n  on_enter:\n    stage_id: build\nnodes: []\n';
  const r = parseWorkflowV2Text(v1Yaml);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.notV2, true);
});

test('parse marks a doc without version:2 as notV2 (even if otherwise v2-shaped)', () => {
  const noVersion = 'id: x\nname: X\ntriggers:\n  - kind: manual\nnodes:\n  - { kind: agent, id: a, agent: p, task: t }\n';
  const r = parseWorkflowV2Text(noVersion);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.notV2, true);
});

test('parse surfaces validation errors for a malformed v2 doc', () => {
  const bad = `version: ${WORKFLOW_V2_VERSION}\nid: bad\nname: Bad\ntriggers:\n  - kind: stage-on-entry\n    stage: build\nnodes:\n  - { kind: agent, id: a, agent: p, task: t, next: [ghost] }\n`;
  const r = parseWorkflowV2Text(bad);
  assert.equal(r.ok, false);
  if (!r.ok && !r.notV2) {
    assert.ok(r.errors.some((e) => /unknown node "ghost"/.test(e)));
    assert.equal(r.partialStageId, 'build');
  }
});

test('expectedId from filename overrides the body id', () => {
  const yaml = serializeWorkflowV2(sample);
  const r = parseWorkflowV2Text(yaml, { expectedId: 'renamed-on-disk' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.workflow.id, 'renamed-on-disk');
});

test('YAML parse error reports as an error, not notV2', () => {
  const r = parseWorkflowV2Text('version: 2\n  : : broken yaml :::\n');
  assert.equal(r.ok, false);
  if (!r.ok) assert.notEqual(r.notV2, true);
});

test('move-work-item node: to_stage round-trips through serialize/parse', () => {
  const wfWithMove: WorkflowV2.Workflow = {
    id: 'move-test',
    name: 'Move test',
    triggers: [{ kind: 'manual' }],
    nodes: [
      { kind: 'move-work-item', id: 'mv', to_stage: 'review' } as WorkflowV2.WorkflowNode,
    ],
  };
  const yaml = serializeWorkflowV2(wfWithMove);
  assert.match(yaml, /kind: move-work-item/);
  assert.match(yaml, /to_stage: review/);
  const r = parseWorkflowV2Text(yaml);
  assert.equal(r.ok, true);
  if (r.ok) {
    const mvNode = r.workflow.nodes[0] as WorkflowV2.MoveWorkItemNode;
    assert.equal(mvNode.kind, 'move-work-item');
    assert.equal(mvNode.to_stage, 'review');
  }
});
