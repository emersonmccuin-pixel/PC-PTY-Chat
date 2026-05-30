// Section 26 — derivation truth table for ExpectedOutput → AcceptanceCriteria.
// Pure-function tests; no IO, no fixtures.
//
// Run via:  pnpm --filter @pc/domain test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AcceptancePredicate, ExpectedOutput } from '../src/index.ts';
import { deriveAcceptanceCriteria } from '../src/index.ts';

// ── text ───────────────────────────────────────────────────────────────────

test('text with no sections + no min_chars → empty AC (trust agent)', () => {
  const ac = deriveAcceptanceCriteria({ kind: 'text' });
  assert.deepEqual(ac, []);
});

test('text with sections → body_contains per section', () => {
  const ac = deriveAcceptanceCriteria({
    kind: 'text',
    sections: ['Summary', 'Methodology'],
  });
  assert.equal(ac.length, 2);
  assert.deepEqual(ac[0], { kind: 'body_contains', pattern: 'Summary' });
  assert.deepEqual(ac[1], { kind: 'body_contains', pattern: 'Methodology' });
});

test('text with min_chars → body_contains regex appended', () => {
  const ac = deriveAcceptanceCriteria({ kind: 'text', min_chars: 200 });
  assert.equal(ac.length, 1);
  const pred = ac[0] as Extract<AcceptancePredicate, { kind: 'body_contains' }>;
  assert.equal(pred.kind, 'body_contains');
  assert.equal(pred.regex, true);
  assert.equal(pred.pattern, '^[\\s\\S]{200,}$');
});

test('text with sections AND min_chars → both predicates emitted in order', () => {
  const ac = deriveAcceptanceCriteria({
    kind: 'text',
    sections: ['Summary'],
    min_chars: 50,
  });
  assert.equal(ac.length, 2);
  assert.equal(ac[0]?.kind, 'body_contains');
  assert.equal(ac[1]?.kind, 'body_contains');
  const second = ac[1] as Extract<AcceptancePredicate, { kind: 'body_contains' }>;
  assert.equal(second.regex, true);
});

test('text with min_chars=0 skips the regex predicate', () => {
  const ac = deriveAcceptanceCriteria({ kind: 'text', min_chars: 0 });
  assert.deepEqual(ac, []);
});

// ── files ──────────────────────────────────────────────────────────────────

test('files with paths → single files_exist predicate', () => {
  const ac = deriveAcceptanceCriteria({
    kind: 'files',
    paths: ['src/foo.ts', 'src/bar.ts'],
  });
  assert.equal(ac.length, 1);
  const pred = ac[0] as Extract<AcceptancePredicate, { kind: 'files_exist' }>;
  assert.equal(pred.kind, 'files_exist');
  assert.deepEqual(pred.paths, ['src/foo.ts', 'src/bar.ts']);
  assert.equal(pred.min_size_bytes, undefined);
});

test('files with min_size_bytes → threshold flows through', () => {
  const ac = deriveAcceptanceCriteria({
    kind: 'files',
    paths: ['out.json'],
    min_size_bytes: 100,
  });
  const pred = ac[0] as Extract<AcceptancePredicate, { kind: 'files_exist' }>;
  assert.equal(pred.min_size_bytes, 100);
});

test('files with empty paths array → empty AC', () => {
  const ac = deriveAcceptanceCriteria({ kind: 'files', paths: [] });
  assert.deepEqual(ac, []);
});

// ── structured ─────────────────────────────────────────────────────────────

test('structured → single fields_populated for the declared keys', () => {
  const ac = deriveAcceptanceCriteria({
    kind: 'structured',
    fields: { verdict: 'string', issues: 'object' },
  });
  assert.equal(ac.length, 1);
  const pred = ac[0] as Extract<AcceptancePredicate, { kind: 'fields_populated' }>;
  assert.equal(pred.kind, 'fields_populated');
  assert.deepEqual(pred.keys, ['verdict', 'issues']);
});

test('structured with empty fields → empty AC', () => {
  const ac = deriveAcceptanceCriteria({ kind: 'structured', fields: {} });
  assert.deepEqual(ac, []);
});

// ── side-effect ────────────────────────────────────────────────────────────

test('side-effect with verify_via_bash → bash_exit_zero predicate', () => {
  const ac = deriveAcceptanceCriteria({
    kind: 'side-effect',
    describe: 'ran the migration',
    verify_via_bash: 'pnpm migrate:status | grep -q "up-to-date"',
  });
  assert.equal(ac.length, 1);
  const pred = ac[0] as Extract<AcceptancePredicate, { kind: 'bash_exit_zero' }>;
  assert.equal(pred.kind, 'bash_exit_zero');
  assert.equal(pred.command, 'pnpm migrate:status | grep -q "up-to-date"');
  assert.equal(pred.cwd, 'worktree');
});

test('side-effect with no verify_via_bash → empty AC (trust agent)', () => {
  const ac = deriveAcceptanceCriteria({
    kind: 'side-effect',
    describe: 'updated Snowflake table state',
  });
  assert.deepEqual(ac, []);
});

// ── mixed ──────────────────────────────────────────────────────────────────

test('mixed: union of all constituent derivations, order preserved', () => {
  const ac = deriveAcceptanceCriteria({
    kind: 'mixed',
    text: { sections: ['Summary'] },
    files: { paths: ['out.ts'], min_size_bytes: 10 },
    structured: { fields: { verdict: 'string' } },
    side_effect: { describe: 'ran tests', verify_via_bash: 'pnpm test' },
  });
  assert.equal(ac.length, 4);
  assert.equal(ac[0]?.kind, 'body_contains');
  assert.equal(ac[1]?.kind, 'files_exist');
  assert.equal(ac[2]?.kind, 'fields_populated');
  assert.equal(ac[3]?.kind, 'bash_exit_zero');
});

test('mixed with no constituents → empty AC', () => {
  const ac = deriveAcceptanceCriteria({ kind: 'mixed' });
  assert.deepEqual(ac, []);
});

test('mixed: omitted constituents do not emit predicates', () => {
  const ac = deriveAcceptanceCriteria({
    kind: 'mixed',
    files: { paths: ['x.ts'] },
  });
  assert.equal(ac.length, 1);
  assert.equal(ac[0]?.kind, 'files_exist');
});

// ── Pod-default scenarios from the design doc ──────────────────────────────

test('researcher default: { kind: text, sections: [summary] } → body_contains "summary"', () => {
  const ac: ExpectedOutput = { kind: 'text', sections: ['summary'] };
  const preds = deriveAcceptanceCriteria(ac);
  assert.equal(preds.length, 1);
  assert.equal(preds[0]?.kind, 'body_contains');
});

test('code-writer default shape: mixed with files + text + bash → 3+ predicates', () => {
  const ac = deriveAcceptanceCriteria({
    kind: 'mixed',
    files: { paths: ['src/**'] },
    text: { sections: ['summary'] },
    side_effect: { describe: 'tests pass', verify_via_bash: 'pnpm test' },
  });
  // 1 body_contains + 1 files_exist + 1 bash_exit_zero = 3
  assert.equal(ac.length, 3);
});

test('reviewer default: structured verdict → single fields_populated', () => {
  const ac = deriveAcceptanceCriteria({
    kind: 'structured',
    fields: { verdict: 'string', issues: 'object', recommendations: 'object' },
  });
  const pred = ac[0] as Extract<AcceptancePredicate, { kind: 'fields_populated' }>;
  assert.deepEqual(pred.keys, ['verdict', 'issues', 'recommendations']);
});
