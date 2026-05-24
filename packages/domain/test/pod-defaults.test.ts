// Section 26.3 — pod-defaults lookup pinning.
//
// Asserts the v1 stock-pod default expected_output shapes and ensures the
// roster matches the dispatchable stock pods exactly (orchestrator is
// excluded — it's not dispatchable; custom pods aren't here yet).
//
// Run via:  pnpm --filter @pc/domain test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DISPATCHABLE_STOCK_PODS,
  POD_DEFAULT_EXPECTED_OUTPUT,
  deriveAcceptanceCriteria,
  getPodDefaultExpectedOutput,
} from '../src/index.ts';

test('every dispatchable stock pod ships a default expected_output', () => {
  for (const name of DISPATCHABLE_STOCK_PODS) {
    const def = getPodDefaultExpectedOutput(name);
    assert.ok(def, `pod ${name} has no default expected_output`);
  }
});

test('roster matches dispatchable-stock-pods exactly (no orphans / extras)', () => {
  const expected = new Set(DISPATCHABLE_STOCK_PODS);
  const actual = new Set(Object.keys(POD_DEFAULT_EXPECTED_OUTPUT));
  const missing = [...expected].filter((n) => !actual.has(n));
  const extras = [...actual].filter((n) => !expected.has(n));
  assert.deepEqual(
    missing,
    [],
    `dispatchable pods missing a default: ${missing.join(', ')}`,
  );
  assert.deepEqual(extras, [], `defaults set for non-dispatchable pods: ${extras.join(', ')}`);
});

test('researcher default derives a body_contains predicate for the summary section', () => {
  const def = getPodDefaultExpectedOutput('researcher')!;
  assert.equal(def.kind, 'text');
  const ac = deriveAcceptanceCriteria(def);
  assert.deepEqual(ac, [{ kind: 'body_contains', pattern: 'summary' }]);
});

test('reviewer default derives fields_populated for the verdict / issues / recs trio', () => {
  const def = getPodDefaultExpectedOutput('reviewer')!;
  assert.equal(def.kind, 'structured');
  const ac = deriveAcceptanceCriteria(def);
  assert.deepEqual(ac, [
    { kind: 'fields_populated', keys: ['verdict', 'issues', 'recommendations'] },
  ]);
});

test('writer default derives no predicates (bare text)', () => {
  const def = getPodDefaultExpectedOutput('writer')!;
  assert.equal(def.kind, 'text');
  // No sections / min_chars → empty AC ("trust the agent's end-of-turn signal").
  assert.deepEqual(deriveAcceptanceCriteria(def), []);
});

test('unknown pod name returns undefined', () => {
  assert.equal(getPodDefaultExpectedOutput('does-not-exist'), undefined);
});

test('orchestrator has no dispatch default (not dispatchable)', () => {
  assert.equal(getPodDefaultExpectedOutput('orchestrator'), undefined);
});
