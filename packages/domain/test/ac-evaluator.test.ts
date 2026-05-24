// Section 26 — tier-1 predicate evaluator. Verifies the pass/fail semantics
// per predicate kind. Pure predicates run against in-memory contexts; the
// two side-effecting predicates (files_exist, bash_exit_zero) are tested
// against fake executors that record their inputs.
//
// Run via:  pnpm --filter @pc/domain test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  AcceptanceCriteria,
  EvaluationContext,
  PredicateExecutors,
} from '../src/index.ts';
import { evaluateAcceptance, evaluatePredicate } from '../src/index.ts';

// ── Test helpers ───────────────────────────────────────────────────────────

function ctx(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    body: '',
    fields: {},
    attachments: [],
    childWorkItems: [],
    ...overrides,
  };
}

/** Executor stub that throws "unexpected" if any side-effecting predicate is
 *  invoked. Use for pure-predicate tests; if an executor fires we want to
 *  know — it's a contract violation. */
const NEVER_CALL_EXECUTORS: PredicateExecutors = {
  fileSize: async () => {
    throw new Error('fileSize should not be called for pure predicates');
  },
  runBash: async () => {
    throw new Error('runBash should not be called for pure predicates');
  },
};

function fakeFileExecutors(sizes: Record<string, number | null>): PredicateExecutors {
  return {
    fileSize: async (path: string) => (path in sizes ? sizes[path]! : null),
    runBash: async () => {
      throw new Error('runBash unexpectedly called');
    },
  };
}

function fakeBashExecutors(exitCode: number): PredicateExecutors {
  return {
    fileSize: async () => {
      throw new Error('fileSize unexpectedly called');
    },
    runBash: async () => exitCode,
  };
}

// ── fields_populated ───────────────────────────────────────────────────────

test('fields_populated: all keys populated → pass', async () => {
  const r = await evaluatePredicate(
    { kind: 'fields_populated', keys: ['summary', 'verdict'] },
    ctx({ fields: { summary: 'hi', verdict: 'ok' } }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, true);
});

test('fields_populated: missing key → fail with reason', async () => {
  const r = await evaluatePredicate(
    { kind: 'fields_populated', keys: ['summary', 'methodology'] },
    ctx({ fields: { summary: 'hi' } }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, false);
  assert.match(r.reason ?? '', /methodology/);
});

test('fields_populated: empty string / array / object are rejected', async () => {
  const r = await evaluatePredicate(
    { kind: 'fields_populated', keys: ['a', 'b', 'c'] },
    ctx({ fields: { a: '', b: [], c: {} } }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, false);
  assert.match(r.reason ?? '', /a, b, c/);
});

test('fields_populated: 0 and false are populated (truthy-by-design exception)', async () => {
  const r = await evaluatePredicate(
    { kind: 'fields_populated', keys: ['n', 'flag'] },
    ctx({ fields: { n: 0, flag: false } }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, true);
});

// ── field_matches ──────────────────────────────────────────────────────────

test('field_matches: regex hits → pass', async () => {
  const r = await evaluatePredicate(
    { kind: 'field_matches', key: 'verdict', pattern: '^(pass|fail)$' },
    ctx({ fields: { verdict: 'pass' } }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, true);
});

test('field_matches: regex miss → fail', async () => {
  const r = await evaluatePredicate(
    { kind: 'field_matches', key: 'verdict', pattern: '^(pass|fail)$' },
    ctx({ fields: { verdict: 'maybe' } }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, false);
  assert.match(r.reason ?? '', /verdict/);
});

test('field_matches: missing field → fail', async () => {
  const r = await evaluatePredicate(
    { kind: 'field_matches', key: 'verdict', pattern: '.*' },
    ctx({ fields: {} }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, false);
  assert.match(r.reason ?? '', /missing/);
});

test('field_matches: invalid regex → fail with helpful message', async () => {
  const r = await evaluatePredicate(
    { kind: 'field_matches', key: 'verdict', pattern: '(' },
    ctx({ fields: { verdict: 'ok' } }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, false);
  assert.match(r.reason ?? '', /invalid regex/);
});

// ── body_contains ──────────────────────────────────────────────────────────

test('body_contains: literal substring match → pass', async () => {
  const r = await evaluatePredicate(
    { kind: 'body_contains', pattern: 'Methodology' },
    ctx({ body: '## Methodology\nWe ran tests.' }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, true);
});

test('body_contains: literal substring miss → fail', async () => {
  const r = await evaluatePredicate(
    { kind: 'body_contains', pattern: 'Methodology' },
    ctx({ body: 'just findings, no methodology header' }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, false);
});

test('body_contains: regex mode matches', async () => {
  const r = await evaluatePredicate(
    { kind: 'body_contains', pattern: '^[\\s\\S]{10,}$', regex: true },
    ctx({ body: 'some long enough body content here' }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, true);
});

test('body_contains: regex too short → fail', async () => {
  const r = await evaluatePredicate(
    { kind: 'body_contains', pattern: '^[\\s\\S]{100,}$', regex: true },
    ctx({ body: 'short' }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, false);
});

// Section 26 carry-over #2 (option A) — body_contains scans attachment
// content too. Agents commonly persist non-trivial deliverables as
// attachments; the predicate now succeeds whether the pattern lives in the
// body OR in any attachment's content.
test('body_contains: substring in attachment content → pass', async () => {
  const r = await evaluatePredicate(
    { kind: 'body_contains', pattern: 'Methodology' },
    ctx({
      body: 'just a brief — see findings.md',
      attachments: [
        {
          name: 'findings.md',
          content: '# Findings\n\n## Methodology\nWe ran tests.',
        },
      ],
    }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, true);
});

test('body_contains: substring missing from both body + attachments → fail', async () => {
  const r = await evaluatePredicate(
    { kind: 'body_contains', pattern: 'Conclusion' },
    ctx({
      body: 'just findings, no conclusion header',
      attachments: [{ name: 'findings.md', content: 'methodology only here' }],
    }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, false);
  assert.match(r.reason ?? '', /body or attachments/);
});

test('body_contains: attachments with no content do not satisfy the predicate', async () => {
  const r = await evaluatePredicate(
    { kind: 'body_contains', pattern: 'Summary' },
    ctx({
      body: 'short brief',
      attachments: [{ name: 'report.md' }], // no content key
    }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, false);
});

test('body_contains: regex mode searches body + attachments', async () => {
  const r = await evaluatePredicate(
    { kind: 'body_contains', pattern: '^[\\s\\S]{200,}$', regex: true },
    ctx({
      body: 'short body',
      attachments: [
        {
          name: 'findings.md',
          content: 'x'.repeat(300),
        },
      ],
    }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, true);
});

// ── attachments_present ────────────────────────────────────────────────────

test('attachments_present: every name present → pass', async () => {
  const r = await evaluatePredicate(
    { kind: 'attachments_present', names: ['log.txt', 'diff.patch'] },
    ctx({
      attachments: [
        { name: 'log.txt' },
        { name: 'diff.patch' },
        { name: 'extra.bin' },
      ],
    }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, true);
});

test('attachments_present: missing name → fail with names listed', async () => {
  const r = await evaluatePredicate(
    { kind: 'attachments_present', names: ['log.txt', 'screenshot.png'] },
    ctx({ attachments: [{ name: 'log.txt' }] }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, false);
  assert.match(r.reason ?? '', /screenshot\.png/);
});

// ── child_work_items_done ──────────────────────────────────────────────────

test('child_work_items_done (default all): every child complete → pass', async () => {
  const r = await evaluatePredicate(
    { kind: 'child_work_items_done' },
    ctx({
      childWorkItems: [{ status: 'complete' }, { status: 'complete' }],
    }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, true);
});

test('child_work_items_done (default all): partial complete → fail', async () => {
  const r = await evaluatePredicate(
    { kind: 'child_work_items_done' },
    ctx({
      childWorkItems: [{ status: 'complete' }, { status: 'in-progress' }],
    }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, false);
  assert.match(r.reason ?? '', /1\/2/);
});

test('child_work_items_done (default all): no children → fail', async () => {
  const r = await evaluatePredicate(
    { kind: 'child_work_items_done' },
    ctx({ childWorkItems: [] }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, false);
});

test('child_work_items_done (all: false, count: 2): meets minimum → pass', async () => {
  const r = await evaluatePredicate(
    { kind: 'child_work_items_done', all: false, count: 2 },
    ctx({
      childWorkItems: [
        { status: 'complete' },
        { status: 'complete' },
        { status: 'in-progress' },
      ],
    }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, true);
});

test('child_work_items_done (all: false, count: 3): under minimum → fail', async () => {
  const r = await evaluatePredicate(
    { kind: 'child_work_items_done', all: false, count: 3 },
    ctx({
      childWorkItems: [{ status: 'complete' }, { status: 'complete' }],
    }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, false);
});

// ── files_exist ────────────────────────────────────────────────────────────

test('files_exist: all paths present + non-empty → pass', async () => {
  const r = await evaluatePredicate(
    { kind: 'files_exist', paths: ['a.ts', 'b.ts'] },
    ctx(),
    fakeFileExecutors({ 'a.ts': 100, 'b.ts': 200 }),
  );
  assert.equal(r.pass, true);
});

test('files_exist: path missing → fail with path name', async () => {
  const r = await evaluatePredicate(
    { kind: 'files_exist', paths: ['a.ts', 'b.ts'] },
    ctx(),
    fakeFileExecutors({ 'a.ts': 100 }),
  );
  assert.equal(r.pass, false);
  assert.match(r.reason ?? '', /b\.ts.*missing/);
});

test('files_exist: path present but under min_size_bytes → fail', async () => {
  const r = await evaluatePredicate(
    { kind: 'files_exist', paths: ['a.ts'], min_size_bytes: 100 },
    ctx(),
    fakeFileExecutors({ 'a.ts': 50 }),
  );
  assert.equal(r.pass, false);
  assert.match(r.reason ?? '', /50b < min 100b/);
});

test('files_exist: zero-byte file (empty) → fail by default threshold of 1b', async () => {
  const r = await evaluatePredicate(
    { kind: 'files_exist', paths: ['a.ts'] },
    ctx(),
    fakeFileExecutors({ 'a.ts': 0 }),
  );
  assert.equal(r.pass, false);
});

// ── bash_exit_zero ─────────────────────────────────────────────────────────

test('bash_exit_zero: exit 0 → pass', async () => {
  const r = await evaluatePredicate(
    { kind: 'bash_exit_zero', command: 'pnpm test' },
    ctx(),
    fakeBashExecutors(0),
  );
  assert.equal(r.pass, true);
});

test('bash_exit_zero: non-zero exit → fail with code', async () => {
  const r = await evaluatePredicate(
    { kind: 'bash_exit_zero', command: 'pnpm test' },
    ctx(),
    fakeBashExecutors(1),
  );
  assert.equal(r.pass, false);
  assert.match(r.reason ?? '', /exited 1/);
});

test('bash_exit_zero: cwd flows to executor (verified via captured arg)', async () => {
  let capturedCwd: string | null = null;
  const exec: PredicateExecutors = {
    fileSize: async () => {
      throw new Error('not expected');
    },
    runBash: async (_command, cwd) => {
      capturedCwd = cwd;
      return 0;
    },
  };
  await evaluatePredicate(
    { kind: 'bash_exit_zero', command: 'echo hi', cwd: 'project' },
    ctx(),
    exec,
  );
  assert.equal(capturedCwd, 'project');
});

test('bash_exit_zero: omitted cwd defaults to worktree', async () => {
  let capturedCwd: string | null = null;
  const exec: PredicateExecutors = {
    fileSize: async () => {
      throw new Error('not expected');
    },
    runBash: async (_command, cwd) => {
      capturedCwd = cwd;
      return 0;
    },
  };
  await evaluatePredicate(
    { kind: 'bash_exit_zero', command: 'echo hi' },
    ctx(),
    exec,
  );
  assert.equal(capturedCwd, 'worktree');
});

// ── evaluateAcceptance (aggregator) ────────────────────────────────────────

test('evaluateAcceptance: all predicates pass → pass with no failures', async () => {
  const criteria: AcceptanceCriteria = [
    { kind: 'fields_populated', keys: ['summary'] },
    { kind: 'body_contains', pattern: 'Methodology' },
  ];
  const r = await evaluateAcceptance(
    criteria,
    ctx({ body: '## Methodology', fields: { summary: 'done' } }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, true);
  assert.equal(r.failures.length, 0);
});

test('evaluateAcceptance: one predicate fails → fail with one failure entry', async () => {
  const criteria: AcceptanceCriteria = [
    { kind: 'fields_populated', keys: ['summary'] },
    { kind: 'body_contains', pattern: 'Conclusion' },
  ];
  const r = await evaluateAcceptance(
    criteria,
    ctx({ body: 'no conclusion section', fields: { summary: 'done' } }),
    NEVER_CALL_EXECUTORS,
  );
  assert.equal(r.pass, false);
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0]?.kind, 'body_contains');
});

test('evaluateAcceptance: multiple failures collected', async () => {
  const criteria: AcceptanceCriteria = [
    { kind: 'fields_populated', keys: ['summary'] },
    { kind: 'body_contains', pattern: 'Conclusion' },
    { kind: 'attachments_present', names: ['log.txt'] },
  ];
  const r = await evaluateAcceptance(criteria, ctx(), NEVER_CALL_EXECUTORS);
  assert.equal(r.pass, false);
  assert.equal(r.failures.length, 3);
  const kinds = r.failures.map((f) => f.kind);
  assert.deepEqual(kinds, ['fields_populated', 'body_contains', 'attachments_present']);
});

test('evaluateAcceptance: empty criteria → pass (no predicates to check)', async () => {
  const r = await evaluateAcceptance([], ctx(), NEVER_CALL_EXECUTORS);
  assert.equal(r.pass, true);
  assert.deepEqual(r.failures, []);
});

test('evaluateAcceptance: mixed pure + side-effect predicates dispatch correctly', async () => {
  const criteria: AcceptanceCriteria = [
    { kind: 'fields_populated', keys: ['summary'] },
    { kind: 'bash_exit_zero', command: 'pnpm test' },
  ];
  const r = await evaluateAcceptance(
    criteria,
    ctx({ fields: { summary: 'ok' } }),
    fakeBashExecutors(0),
  );
  assert.equal(r.pass, true);
});
