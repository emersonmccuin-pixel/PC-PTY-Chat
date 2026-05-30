// Section 19.6 — workflow graph validator. Pure unit tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowV2 } from '@pc/domain';
import { validateWorkflowV2 } from '../src/dag/validate.ts';

type Node = WorkflowV2.WorkflowNode;

function agent(id: string, next?: string[]): Node {
  return { kind: 'agent', id, agent: 'pod', task: `do ${id}`, ...(next ? { next } : {}) } as Node;
}
function wf(nodes: Node[], extra: Partial<WorkflowV2.Workflow> = {}): WorkflowV2.Workflow {
  return { id: 'w', name: 'Test WF', triggers: [{ kind: 'manual' }], nodes, ...extra };
}

/** Assert the result is invalid and at least one error matches `re`. */
function expectError(result: { ok: boolean; errors: string[] }, re: RegExp): void {
  assert.equal(result.ok, false, `expected invalid, got ${JSON.stringify(result)}`);
  assert.ok(
    result.errors.some((e) => re.test(e)),
    `no error matched ${re} in ${JSON.stringify(result.errors)}`
  );
}

test('valid linear workflow passes', () => {
  const r = validateWorkflowV2(wf([agent('a', ['b']), agent('b')]));
  assert.deepEqual(r, { ok: true, errors: [] });
});

test('valid reject-loop workflow passes (back-edge is NOT a cycle)', () => {
  const r = validateWorkflowV2(
    wf([
      agent('code', ['test']),
      agent('test', ['review']),
      {
        kind: 'orchestrator-review',
        id: 'review',
        next: ['done'],
        bundle_from: ['code', 'test'],
        reject: { back_to: 'code', max_iterations: 3, carry: { feedback: '$self.output.notes' } },
      } as Node,
      agent('done'),
    ])
  );
  assert.deepEqual(r, { ok: true, errors: [] });
});

test('forward cycle is rejected', () => {
  const r = validateWorkflowV2(wf([agent('a', ['b']), agent('b', ['a'])]));
  expectError(r, /cycle/i);
});

test('unknown next target', () => {
  expectError(validateWorkflowV2(wf([agent('a', ['nope'])])), /next → unknown node "nope"/);
});

test('unknown reject.back_to target', () => {
  const r = validateWorkflowV2(
    wf([agent('a', ['rev']), { kind: 'orchestrator-review', id: 'rev', reject: { back_to: 'ghost' } } as Node])
  );
  expectError(r, /reject\.back_to → unknown node "ghost"/);
});

test('unknown bundle_from target', () => {
  const r = validateWorkflowV2(
    wf([agent('a', ['rev']), { kind: 'orchestrator-review', id: 'rev', bundle_from: ['ghost'] } as Node])
  );
  expectError(r, /bundle_from → unknown node "ghost"/);
});

test('duplicate node id', () => {
  expectError(validateWorkflowV2(wf([agent('a'), agent('a')])), /duplicate node id "a"/);
});

test('unknown node kind', () => {
  expectError(validateWorkflowV2(wf([{ kind: 'frobnicate', id: 'x' } as unknown as Node])), /unknown kind "frobnicate"/);
});

test('agent node missing agent + task', () => {
  const r = validateWorkflowV2(wf([{ kind: 'agent', id: 'a' } as unknown as Node]));
  expectError(r, /missing "agent"/);
  expectError(r, /missing "task"/);
});

test('bash node missing command', () => {
  expectError(validateWorkflowV2(wf([{ kind: 'bash', id: 'b' } as unknown as Node])), /missing "bash"/);
});

test('script node bad runtime', () => {
  const r = validateWorkflowV2(wf([{ kind: 'script', id: 's', script: 'x', runtime: 'ruby' } as unknown as Node]));
  expectError(r, /runtime must be "node" or "python"/);
});

test('malformed when: is rejected', () => {
  expectError(validateWorkflowV2(wf([{ ...agent('a'), when: 'this is not a condition' } as Node])), /failed to parse/);
});

test('valid when: forms pass (string eq, numeric, compound)', () => {
  const r = validateWorkflowV2(
    wf([
      agent('a', ['b']),
      { ...agent('b'), when: "$a.output == 'ok' && $a.output.score >= '80' || $a.output != 'no'" } as Node,
    ])
  );
  assert.deepEqual(r, { ok: true, errors: [] });
});

test('no triggers is rejected', () => {
  expectError(validateWorkflowV2(wf([agent('a')], { triggers: [] })), /at least one trigger/);
});

test('stage-on-entry trigger missing stage', () => {
  const r = validateWorkflowV2(wf([agent('a')], { triggers: [{ kind: 'stage-on-entry' } as never] }));
  expectError(r, /stage-on-entry trigger: missing "stage"/);
});

test('schedule + event triggers require cron / source', () => {
  expectError(validateWorkflowV2(wf([agent('a')], { triggers: [{ kind: 'schedule' } as never] })), /missing "cron"/);
  expectError(validateWorkflowV2(wf([agent('a')], { triggers: [{ kind: 'event' } as never] })), /missing "source"/);
});

test('empty workflow (no nodes, no name)', () => {
  const r = validateWorkflowV2({ id: 'w', name: '', triggers: [{ kind: 'manual' }], nodes: [] });
  expectError(r, /at least one node/);
  expectError(r, /name is required/);
});

test('node id "root" is reserved', () => {
  expectError(validateWorkflowV2(wf([{ ...agent('root'), id: 'root' } as Node])), /node id "root" is reserved/);
});

test('move-work-item node with to_stage passes', () => {
  const r = validateWorkflowV2(wf([{ kind: 'move-work-item', id: 'mv', to_stage: 'review' } as unknown as Node]));
  assert.deepEqual(r, { ok: true, errors: [] });
});

test('move-work-item node missing to_stage is rejected', () => {
  expectError(
    validateWorkflowV2(wf([{ kind: 'move-work-item', id: 'mv' } as unknown as Node])),
    /move-work-item node "mv": missing "to_stage"/
  );
});

test('move-work-item node with empty to_stage is rejected', () => {
  expectError(
    validateWorkflowV2(wf([{ kind: 'move-work-item', id: 'mv', to_stage: '' } as unknown as Node])),
    /move-work-item node "mv": missing "to_stage"/
  );
});

test('collects multiple errors at once', () => {
  const r = validateWorkflowV2(wf([agent('a', ['ghost']), { kind: 'bash', id: 'a' } as unknown as Node]));
  // duplicate id + missing bash + unknown next target — at least 3 distinct errors
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 3, `expected ≥3 errors, got ${JSON.stringify(r.errors)}`);
});

// ── cross-workflow stage-on-entry collision (opts path) ──

const OTHER_WORKFLOWS = [{ workflowId: 'other-wf', name: 'Onboarding', stage: 'review' }];

test('move to a colliding stage without ack → error', () => {
  const r = validateWorkflowV2(
    wf([{ kind: 'move-work-item', id: 'mv', to_stage: 'review' } as unknown as Node]),
    { stageOnEntryWorkflows: OTHER_WORKFLOWS },
  );
  expectError(
    r,
    /move-work-item node "mv": destination stage is the on-entry trigger of workflow "Onboarding" — that workflow will be silently skipped\./,
  );
});

test('move to a colliding stage with allow_stage_workflow_skip: true → no error', () => {
  const r = validateWorkflowV2(
    wf([{ kind: 'move-work-item', id: 'mv', to_stage: 'review', allow_stage_workflow_skip: true } as unknown as Node]),
    { stageOnEntryWorkflows: OTHER_WORKFLOWS },
  );
  assert.deepEqual(r, { ok: true, errors: [] });
});

test('opts omitted → no cross-workflow error (back-compat)', () => {
  const r = validateWorkflowV2(
    wf([{ kind: 'move-work-item', id: 'mv', to_stage: 'review' } as unknown as Node]),
  );
  assert.deepEqual(r, { ok: true, errors: [] });
});

test('move to a stage NOT in the stageOnEntryWorkflows list → no error', () => {
  const r = validateWorkflowV2(
    wf([{ kind: 'move-work-item', id: 'mv', to_stage: 'backlog' } as unknown as Node]),
    { stageOnEntryWorkflows: OTHER_WORKFLOWS },
  );
  assert.deepEqual(r, { ok: true, errors: [] });
});
