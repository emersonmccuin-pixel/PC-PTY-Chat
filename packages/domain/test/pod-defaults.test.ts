// Section 26.3 — pod-defaults lookup pinning.
//
// Section 36 (2026-05-25) removed the iteration tests that walked the
// deleted DISPATCHABLE_STOCK_PODS constant. Stock-pod identity lives on the
// `agents.origin` column now; roster-vs-defaults consistency is implicitly
// checked by the seed step (stock-pod-seed inserts every entry it lists,
// each of which corresponds to a name in this map or omits a default).
//
// Run via:  pnpm --filter @pc/domain test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveAcceptanceCriteria,
  getPodDefaultExpectedOutput,
} from '../src/index.ts';

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
