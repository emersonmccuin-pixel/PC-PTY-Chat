// Unit tests for output-substitution.ts.
//
// Slice 9 M6 shipped substituteOutputs + evaluateBoolean without colocated
// tests; 4a.1 adds the $inputs.<key>[.path] sibling and pins the contract
// here so the existing $<stepId>.output paths can't silently regress as the
// runtime grows. Coverage:
//   - $<stepId>.output happy + nested-path
//   - $inputs.<key>     happy + nested-path
//   - missing keys / missing inputs / missing nodeOutputs resolve to ''
//   - mixed tokens in one string
//   - stringify rules (number / boolean / object → JSON)
//   - evaluateBoolean equivalents for the same coverage axes
//
// Run via:  pnpm --filter @pc/server test
// Or:       pnpm test:unit  (from repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { WorkflowRun } from '@pc/domain';
import { substituteOutputs, evaluateBoolean } from '../src/services/output-substitution.ts';

function mkRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    workflowId: 'wf-test',
    workflowYamlSnapshot: '',
    status: 'in-progress',
    startedAt: new Date().toISOString(),
    worktreePath: null,
    nodeOutputs: {},
    ...overrides,
  };
}

// ── substituteOutputs ───────────────────────────────────────────────────────

test('substituteOutputs: $<stepId>.output happy path (string)', () => {
  const run = mkRun({
    nodeOutputs: { researcher: { status: 'complete', output: 'all good' } },
  });
  assert.equal(substituteOutputs('Result: $researcher.output', run), 'Result: all good');
});

test('substituteOutputs: $<stepId>.output nested path', () => {
  const run = mkRun({
    nodeOutputs: {
      researcher: {
        status: 'complete',
        output: { summary: 'short', details: { count: 3 } },
      },
    },
  });
  assert.equal(
    substituteOutputs('Summary: $researcher.output.summary; n=$researcher.output.details.count', run),
    'Summary: short; n=3',
  );
});

test('substituteOutputs: missing node resolves to empty string', () => {
  const run = mkRun();
  assert.equal(substituteOutputs('x=$nope.output.something', run), 'x=');
});

test('substituteOutputs: $inputs.<key> happy path (string)', () => {
  const run = mkRun({ inputs: { agent: 'researcher' } });
  assert.equal(substituteOutputs('Hello $inputs.agent', run), 'Hello researcher');
});

test('substituteOutputs: $inputs.<key> nested path', () => {
  const run = mkRun({
    inputs: { config: { model: 'opus', limits: { tokens: 8192 } } },
  });
  assert.equal(
    substituteOutputs('model=$inputs.config.model, t=$inputs.config.limits.tokens', run),
    'model=opus, t=8192',
  );
});

test('substituteOutputs: missing $inputs key resolves to empty string', () => {
  const run = mkRun({ inputs: { other: 'x' } });
  assert.equal(substituteOutputs('agent=$inputs.agent', run), 'agent=');
});

test('substituteOutputs: undefined run.inputs resolves to empty string', () => {
  const run = mkRun(); // no `inputs` field at all
  assert.equal(substituteOutputs('agent=$inputs.agent', run), 'agent=');
});

test('substituteOutputs: $inputs and $<stepId>.output mixed in one string', () => {
  const run = mkRun({
    inputs: { agent: 'researcher' },
    nodeOutputs: { run: { status: 'complete', output: { summary: 'done' } } },
  });
  assert.equal(
    substituteOutputs('agent=$inputs.agent says $run.output.summary', run),
    'agent=researcher says done',
  );
});

test('substituteOutputs: object/array values stringify to JSON', () => {
  const run = mkRun({
    inputs: { tags: ['a', 'b'], meta: { k: 1 } },
  });
  assert.equal(substituteOutputs('$inputs.tags', run), '["a","b"]');
  assert.equal(substituteOutputs('$inputs.meta', run), '{"k":1}');
});

test('substituteOutputs: boolean / number inputs stringify via String()', () => {
  const run = mkRun({ inputs: { active: true, n: 0 } });
  assert.equal(substituteOutputs('active=$inputs.active n=$inputs.n', run), 'active=true n=0');
});

test('substituteOutputs: input key named "output" is fine (no grammar collision)', () => {
  // $inputs.output reads run.inputs.output. The regex requires literal `inputs`
  // first segment, so it won't collide with the $<stepId>.output grammar.
  const run = mkRun({ inputs: { output: 'final' } });
  assert.equal(substituteOutputs('$inputs.output', run), 'final');
});

test('substituteOutputs: $inputs key cannot contain hyphens (grammar lock)', () => {
  // Path segments use [a-zA-Z_][a-zA-Z0-9_]* — no hyphens. A workflow author
  // who tries `$inputs.foo-bar` only matches up to `$inputs.foo`; the rest
  // stays as literal text.
  const run = mkRun({ inputs: { foo: 'X' } });
  assert.equal(substituteOutputs('$inputs.foo-bar', run), 'X-bar');
});

// ── evaluateBoolean ─────────────────────────────────────────────────────────

test('evaluateBoolean: $<stepId>.output equality', () => {
  const run = mkRun({
    nodeOutputs: { gate: { status: 'complete', output: { approved: true } } },
  });
  assert.equal(evaluateBoolean('$gate.output.approved == true', run), true);
  assert.equal(evaluateBoolean('$gate.output.approved == false', run), false);
});

test('evaluateBoolean: $inputs.<key> equality', () => {
  const run = mkRun({ inputs: { mode: 'fast' } });
  assert.equal(evaluateBoolean('$inputs.mode == "fast"', run), true);
  assert.equal(evaluateBoolean('$inputs.mode == "slow"', run), false);
});

test('evaluateBoolean: $inputs nested-path comparison', () => {
  const run = mkRun({ inputs: { limits: { tokens: 8192 } } });
  assert.equal(evaluateBoolean('$inputs.limits.tokens > 1000', run), true);
  assert.equal(evaluateBoolean('$inputs.limits.tokens < 100', run), false);
});

test('evaluateBoolean: missing $inputs key coerces to false', () => {
  const run = mkRun({ inputs: { other: 1 } });
  // undefined → coerceBoolean(undefined) === false
  assert.equal(evaluateBoolean('$inputs.missing', run), false);
});

test('evaluateBoolean: $inputs and $<stepId>.output combined', () => {
  const run = mkRun({
    inputs: { mode: 'fast' },
    nodeOutputs: { gate: { status: 'complete', output: { ok: true } } },
  });
  assert.equal(evaluateBoolean('$inputs.mode == "fast" && $gate.output.ok', run), true);
  assert.equal(evaluateBoolean('$inputs.mode == "slow" || $gate.output.ok', run), true);
  assert.equal(evaluateBoolean('$inputs.mode == "slow" && $gate.output.ok', run), false);
});

test('evaluateBoolean: $inputs key named "output" reads inputs, not nodeOutputs', () => {
  // Verifies the head-segment branch — `$inputs.output` resolves to
  // run.inputs.output, not to a (non-existent) nodeOutput called "inputs".
  const run = mkRun({ inputs: { output: 'yes' } });
  assert.equal(evaluateBoolean('$inputs.output == "yes"', run), true);
});

test('evaluateBoolean: undefined run.inputs still tokenizes + resolves to undefined', () => {
  const run = mkRun(); // no inputs
  assert.equal(evaluateBoolean('$inputs.foo', run), false);
  assert.equal(evaluateBoolean('!$inputs.foo', run), true);
});
