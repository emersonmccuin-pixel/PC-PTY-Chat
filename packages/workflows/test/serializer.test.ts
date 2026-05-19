// Unit tests for the typed-Workflow → YAML serializer (4b.1).
//
// Roundtrip contract:
//   serializeWorkflow(wf) → parseWorkflowText(...) → identical logical wf
//   (modulo the post-parse `kind:` discriminator the validator adds, which
//   never appears on disk).
//
// Run via:  pnpm --filter @pc/workflows test
// Or:       pnpm test:unit  (from repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Workflow } from '@pc/domain';

import { serializeWorkflow } from '../src/serializer.ts';
import { parseWorkflowText } from '../src/validator.ts';

function roundtrip(wf: Workflow): Workflow {
  const yaml = serializeWorkflow(wf);
  const result = parseWorkflowText(yaml, { expectedId: wf.id });
  assert.equal(result.ok, true, `parse failed: ${JSON.stringify(result.errors)}`);
  return result.workflow!;
}

// ── minimal happy path ─────────────────────────────────────────────────────

test('serializer: minimal subagent workflow roundtrips', () => {
  const wf: Workflow = {
    id: 'minimal',
    triggers: { callable: true },
    nodes: [{ kind: 'subagent', id: 'n1', subagent: 'researcher', prompt: 'go' }],
  };
  const out = roundtrip(wf);
  assert.equal(out.id, 'minimal');
  assert.equal(out.nodes.length, 1);
  const n = out.nodes[0]!;
  assert.equal(n.kind, 'subagent');
  assert.equal((n as { subagent: string }).subagent, 'researcher');
  assert.equal((n as { prompt: string }).prompt, 'go');
});

test('serializer: emits stable key order (id → description → triggers → nodes)', () => {
  const wf: Workflow = {
    id: 'ordered',
    description: 'd',
    triggers: { callable: true },
    nodes: [{ kind: 'bash', id: 'n1', bash: 'echo hi' }],
  };
  const yaml = serializeWorkflow(wf);
  const idIdx = yaml.indexOf('id:');
  const descIdx = yaml.indexOf('description:');
  const trigIdx = yaml.indexOf('triggers:');
  const nodesIdx = yaml.indexOf('nodes:');
  assert.ok(
    idIdx < descIdx && descIdx < trigIdx && trigIdx < nodesIdx,
    `key order broke: ${yaml}`,
  );
});

test('serializer: never emits the `kind:` discriminator', () => {
  const wf: Workflow = {
    id: 'no-kind',
    triggers: { callable: true },
    nodes: [
      { kind: 'subagent', id: 'a', subagent: 'r', prompt: 'p' },
      { kind: 'bash', id: 'b', bash: 'ls' },
    ],
  };
  const yaml = serializeWorkflow(wf);
  assert.ok(!/^\s*kind:/m.test(yaml), `unexpected kind: line in YAML: ${yaml}`);
});

// ── triggers ───────────────────────────────────────────────────────────────

test('serializer: on_enter trigger roundtrips', () => {
  const wf: Workflow = {
    id: 'on-enter',
    triggers: { on_enter: { stage_id: 'review' } },
    nodes: [{ kind: 'subagent', id: 'n1', subagent: 'researcher', prompt: 'go' }],
  };
  const out = roundtrip(wf);
  assert.equal(out.triggers?.on_enter?.stage_id, 'review');
});

test('serializer: callable trigger roundtrips', () => {
  const wf: Workflow = {
    id: 'callable',
    triggers: { callable: true },
    nodes: [{ kind: 'bash', id: 'n1', bash: 'echo' }],
  };
  const out = roundtrip(wf);
  assert.equal(out.triggers?.callable, true);
});

// ── inputs / outputs / worktree / scratch_cleanup ─────────────────────────

test('serializer: inputs + outputs + worktree + scratch_cleanup roundtrip', () => {
  const wf: Workflow = {
    id: 'all-meta',
    triggers: { callable: true },
    inputs: { agent: 'string', payload: 'string' },
    outputs: { result: 'string' },
    worktree: 'auto',
    scratch_cleanup: 'auto',
    nodes: [{ kind: 'subagent', id: 'n1', subagent: '$inputs.agent', prompt: '$inputs.payload' }],
  };
  const out = roundtrip(wf);
  assert.deepEqual(out.inputs, { agent: 'string', payload: 'string' });
  assert.deepEqual(out.outputs, { result: 'string' });
  assert.equal(out.worktree, 'auto');
  assert.equal(out.scratch_cleanup, 'auto');
});

// ── all step kinds ─────────────────────────────────────────────────────────

test('serializer: http step roundtrips with headers + body', () => {
  const wf: Workflow = {
    id: 'http-wf',
    triggers: { callable: true },
    nodes: [
      {
        kind: 'http',
        id: 'h',
        http: {
          method: 'POST',
          url: 'https://api.example.com/x',
          headers: { Authorization: 'Bearer $ENV.TOKEN', 'Content-Type': 'application/json' },
          body: '{"x":1}',
          timeout: 5000,
        },
      },
    ],
  };
  const out = roundtrip(wf);
  const node = out.nodes[0] as { http: { method: string; url: string; headers: Record<string, string>; body: string; timeout: number } };
  assert.equal(node.http.method, 'POST');
  assert.equal(node.http.url, 'https://api.example.com/x');
  assert.equal(node.http.headers.Authorization, 'Bearer $ENV.TOKEN');
  assert.equal(node.http.body, '{"x":1}');
  assert.equal(node.http.timeout, 5000);
});

test('serializer: human-review (approval) step roundtrips', () => {
  const wf: Workflow = {
    id: 'review-wf',
    triggers: { callable: true },
    nodes: [
      {
        kind: 'approval',
        id: 'gate',
        approval: { message: 'Look good?', on_reject: { prompt: 'Try again' } },
      },
    ],
  };
  const out = roundtrip(wf);
  const node = out.nodes[0] as { approval: { message: string; on_reject?: { prompt: string } } };
  assert.equal(node.approval.message, 'Look good?');
  assert.equal(node.approval.on_reject?.prompt, 'Try again');
});

test('serializer: orchestrator-review step roundtrips', () => {
  const wf: Workflow = {
    id: 'orc-review-wf',
    triggers: { callable: true },
    nodes: [
      {
        kind: 'orchestrator-review',
        id: 'gate',
        'orchestrator-review': {
          prompt: 'Check this',
          artifact: '$n1.output.path',
          on_revise: { prompt: 'Suggest fixes' },
        },
      },
    ],
  };
  const out = roundtrip(wf);
  const node = out.nodes[0] as { 'orchestrator-review': { prompt: string; artifact?: string; on_revise?: { prompt: string } } };
  assert.equal(node['orchestrator-review'].prompt, 'Check this');
  assert.equal(node['orchestrator-review'].artifact, '$n1.output.path');
  assert.equal(node['orchestrator-review'].on_revise?.prompt, 'Suggest fixes');
});

test('serializer: routing kinds (attach / create / update / write) roundtrip', () => {
  const wf: Workflow = {
    id: 'routing-wf',
    triggers: { callable: true },
    nodes: [
      {
        kind: 'attach-to-work-item',
        id: 'a',
        'attach-to-work-item': {
          workItemId: '$inputs.wi',
          name: 'report.md',
          content: '$prior.output.body',
          kind: 'markdown',
        },
      },
      {
        kind: 'create-work-item',
        id: 'c',
        'create-work-item': {
          title: 'spawn',
          body: 'b',
          stage: 'todo',
          parentId: '$inputs.parent',
        },
      },
      {
        kind: 'update-work-item',
        id: 'u',
        'update-work-item': {
          workItemId: '$inputs.wi',
          title: 'renamed',
          fields: { priority: 'high' },
        },
      },
      {
        kind: 'write-to-worktree',
        id: 'w',
        'write-to-worktree': { path: 'notes.md', content: 'hi', mode: 'append' },
      },
    ],
  };
  const out = roundtrip(wf);
  assert.equal(out.nodes.length, 4);
  const a = out.nodes[0] as { 'attach-to-work-item': { workItemId: string; name: string; kind?: string } };
  assert.equal(a['attach-to-work-item'].workItemId, '$inputs.wi');
  assert.equal(a['attach-to-work-item'].kind, 'markdown');
  const w = out.nodes[3] as { 'write-to-worktree': { mode?: string } };
  assert.equal(w['write-to-worktree'].mode, 'append');
});

test('serializer: nested workflow step roundtrips', () => {
  const wf: Workflow = {
    id: 'parent-wf',
    triggers: { callable: true },
    nodes: [
      {
        kind: 'workflow',
        id: 'child',
        workflow: 'child-flow',
        inputs: { a: 'hello' },
      },
    ],
  };
  const out = roundtrip(wf);
  const node = out.nodes[0] as { workflow: string; inputs?: Record<string, string> };
  assert.equal(node.workflow, 'child-flow');
  assert.deepEqual(node.inputs, { a: 'hello' });
});

test('serializer: loop step roundtrips + recursively strips kind: from body nodes', () => {
  const wf: Workflow = {
    id: 'loop-wf',
    triggers: { callable: true },
    nodes: [
      {
        kind: 'loop',
        id: 'l',
        loop: {
          body: [
            { kind: 'bash', id: 'b', bash: 'echo' },
            { kind: 'subagent', id: 's', subagent: 'researcher', prompt: 'go' },
          ],
          until: '$b.output.done == true',
          max_iterations: 5,
        },
      },
    ],
  };
  const yaml = serializeWorkflow(wf);
  // No `kind:` lines anywhere, including inside loop body.
  assert.ok(!/^\s*kind:/m.test(yaml), `unexpected kind: in: ${yaml}`);
  const out = roundtrip(wf);
  const node = out.nodes[0] as { loop: { body: { kind: string; id: string }[]; max_iterations: number } };
  assert.equal(node.loop.body.length, 2);
  assert.equal(node.loop.body[0]!.kind, 'bash');
  assert.equal(node.loop.body[1]!.kind, 'subagent');
  assert.equal(node.loop.max_iterations, 5);
});

test('serializer: script + cancel steps roundtrip', () => {
  const wf: Workflow = {
    id: 'misc-wf',
    triggers: { callable: true },
    nodes: [
      { kind: 'script', id: 's', script: 'print("hi")', runtime: 'python' },
      { kind: 'cancel', id: 'x', cancel: 'aborted via flag' },
    ],
  };
  const out = roundtrip(wf);
  const s = out.nodes[0] as { script: string; runtime: string };
  assert.equal(s.script, 'print("hi")');
  assert.equal(s.runtime, 'python');
  const x = out.nodes[1] as { cancel: string };
  assert.equal(x.cancel, 'aborted via flag');
});

// ── base fields ────────────────────────────────────────────────────────────

test('serializer: depends_on + when + trigger_rule + done_when + timeout + retry roundtrip', () => {
  const wf: Workflow = {
    id: 'base-fields',
    triggers: { callable: true },
    nodes: [
      { kind: 'bash', id: 'a', bash: 'echo a' },
      {
        kind: 'bash',
        id: 'b',
        bash: 'echo b',
        depends_on: ['a'],
        when: '$a.output.ok == true',
        trigger_rule: 'all_done',
        done_when: { 'files-non-empty': ['report.md'] },
        timeout: 10000,
        retry: { max_attempts: 3, on: ['failed', 'timeout'], delay_ms: 500 },
      },
    ],
  };
  const out = roundtrip(wf);
  const b = out.nodes[1] as {
    depends_on: string[];
    when: string;
    trigger_rule: string;
    done_when: { 'files-non-empty': string[] };
    timeout: number;
    retry: { max_attempts: number; on: string[]; delay_ms: number };
  };
  assert.deepEqual(b.depends_on, ['a']);
  assert.equal(b.when, '$a.output.ok == true');
  assert.equal(b.trigger_rule, 'all_done');
  assert.deepEqual(b.done_when, { 'files-non-empty': ['report.md'] });
  assert.equal(b.timeout, 10000);
  assert.equal(b.retry.max_attempts, 3);
  assert.deepEqual(b.retry.on, ['failed', 'timeout']);
  assert.equal(b.retry.delay_ms, 500);
});

// ── undefined-field omission ──────────────────────────────────────────────

// ── 4f / D62 + D67 — disabled + attached_to_work_item ─────────────────────

test('serializer: disabled: true roundtrips', () => {
  const wf: Workflow = {
    id: 'paused',
    triggers: { callable: true },
    disabled: true,
    nodes: [{ kind: 'bash', id: 'n1', bash: 'echo' }],
  };
  const out = roundtrip(wf);
  assert.equal(out.disabled, true);
});

test('serializer: disabled: false is omitted (semantic identity with absent)', () => {
  const wf: Workflow = {
    id: 'live',
    triggers: { callable: true },
    disabled: false,
    nodes: [{ kind: 'bash', id: 'n1', bash: 'echo' }],
  };
  const yaml = serializeWorkflow(wf);
  assert.ok(!/^disabled:/m.test(yaml), `disabled should be omitted when false: ${yaml}`);
});

test('serializer: attached_to_work_item roundtrips for each value', () => {
  for (const v of ['required', 'optional', 'forbidden'] as const) {
    const wf: Workflow = {
      id: `wc-${v}`,
      triggers: { callable: true },
      attached_to_work_item: v,
      nodes: [{ kind: 'bash', id: 'n1', bash: 'echo' }],
    };
    const out = roundtrip(wf);
    assert.equal(out.attached_to_work_item, v, `${v} did not roundtrip`);
  }
});

test('serializer: key order keeps disabled + attached_to_work_item between triggers and inputs', () => {
  const wf: Workflow = {
    id: 'ordered-4f',
    triggers: { callable: true },
    disabled: true,
    attached_to_work_item: 'required',
    inputs: { workItemId: 'string' },
    nodes: [{ kind: 'bash', id: 'n1', bash: 'echo' }],
  };
  const yaml = serializeWorkflow(wf);
  const trigIdx = yaml.indexOf('triggers:');
  const disIdx = yaml.indexOf('disabled:');
  const attIdx = yaml.indexOf('attached_to_work_item:');
  const inIdx = yaml.indexOf('inputs:');
  assert.ok(
    trigIdx < disIdx && disIdx < attIdx && attIdx < inIdx,
    `4f key order broke: ${yaml}`,
  );
});

test('serializer: omits undefined top-level fields', () => {
  // 4f / D70 #1 — a savable workflow needs a trigger, so this test asserts
  // omission only for fields that genuinely default-absent (description /
  // inputs / outputs / worktree / scratch_cleanup / disabled /
  // attached_to_work_item).
  const wf: Workflow = {
    id: 'minimal',
    triggers: { callable: true },
    nodes: [{ kind: 'bash', id: 'n1', bash: 'echo' }],
  };
  const yaml = serializeWorkflow(wf);
  assert.ok(!yaml.includes('description:'));
  assert.ok(!yaml.includes('inputs:'));
  assert.ok(!yaml.includes('outputs:'));
  assert.ok(!yaml.includes('worktree:'));
  assert.ok(!yaml.includes('scratch_cleanup:'));
  assert.ok(!yaml.includes('disabled:'));
  assert.ok(!yaml.includes('attached_to_work_item:'));
});
