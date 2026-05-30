// Unit tests for subagent-output-validation.ts (Section 4h / 4h.6 / D78).
//
// Pins the contract for `validateSubagentOutput`:
//   - Empty schema → trivially OK (nothing to enforce).
//   - Non-object outputs (null, undefined, primitive, array) → fail with a
//     descriptive message.
//   - Per-field type checks: ulid/string/text accept string; int accepts
//     integers only; bool accepts boolean only; object/array are escape
//     hatches.
//   - Missing required fields → fail with the missing field name.
//   - Extra fields beyond the schema are permitted (forward-compatibility).
//
// Run via:  pnpm --filter @pc/server test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CatalogType } from '@pc/domain';

import { validateSubagentOutput } from '../src/services/subagent-output-validation.ts';

function expectOk(result: ReturnType<typeof validateSubagentOutput>): void {
  if (!result.ok) {
    throw new Error(`expected ok=true, got error: ${result.message}`);
  }
}

function expectErr(
  result: ReturnType<typeof validateSubagentOutput>,
  needle: string,
): void {
  if (result.ok) throw new Error('expected ok=false, got ok=true');
  if (!result.message.includes(needle)) {
    throw new Error(`expected error to contain "${needle}", got: ${result.message}`);
  }
}

// ── empty + degenerate inputs ───────────────────────────────────────────────

test('validateSubagentOutput: empty schema → ok regardless of output', () => {
  expectOk(validateSubagentOutput(undefined, {}));
  expectOk(validateSubagentOutput(null, {}));
  expectOk(validateSubagentOutput({ anything: 1 }, {}));
  expectOk(validateSubagentOutput('a string', {}));
});

test('validateSubagentOutput: null output with non-empty schema → fail', () => {
  expectErr(
    validateSubagentOutput(null, { result: 'text' }),
    'got null',
  );
});

test('validateSubagentOutput: undefined output with non-empty schema → fail', () => {
  expectErr(
    validateSubagentOutput(undefined, { result: 'text' }),
    'no output',
  );
});

test('validateSubagentOutput: array output → fail (object expected)', () => {
  expectErr(
    validateSubagentOutput([1, 2, 3], { result: 'text' }),
    'got array',
  );
});

test('validateSubagentOutput: primitive output → fail (object expected)', () => {
  expectErr(
    validateSubagentOutput('a string', { result: 'text' }),
    'got string',
  );
  expectErr(
    validateSubagentOutput(42, { result: 'text' }),
    'got number',
  );
});

// ── per-field type checks ───────────────────────────────────────────────────

test('validateSubagentOutput: string/text/ulid all accept strings', () => {
  expectOk(
    validateSubagentOutput(
      { a: 'x', b: 'y', c: '01H...' },
      { a: 'string', b: 'text', c: 'ulid' },
    ),
  );
});

test('validateSubagentOutput: string type rejects non-string', () => {
  expectErr(
    validateSubagentOutput({ result: 42 }, { result: 'string' }),
    'expected string, got number',
  );
});

test('validateSubagentOutput: int accepts integer, rejects float / string', () => {
  expectOk(validateSubagentOutput({ n: 42 }, { n: 'int' }));
  expectErr(
    validateSubagentOutput({ n: 3.14 }, { n: 'int' }),
    'expected int, got number',
  );
  expectErr(
    validateSubagentOutput({ n: '42' }, { n: 'int' }),
    'expected int, got string',
  );
});

test('validateSubagentOutput: bool rejects truthy strings + 0/1 numbers', () => {
  expectOk(validateSubagentOutput({ b: true }, { b: 'bool' }));
  expectOk(validateSubagentOutput({ b: false }, { b: 'bool' }));
  expectErr(
    validateSubagentOutput({ b: 'true' }, { b: 'bool' }),
    'expected bool, got string',
  );
  expectErr(
    validateSubagentOutput({ b: 1 }, { b: 'bool' }),
    'expected bool, got number',
  );
});

test('validateSubagentOutput: object accepts plain object, rejects array', () => {
  expectOk(validateSubagentOutput({ o: { k: 1 } }, { o: 'object' }));
  expectErr(
    validateSubagentOutput({ o: [1, 2] }, { o: 'object' }),
    'expected object, got array',
  );
  expectErr(
    validateSubagentOutput({ o: null }, { o: 'object' }),
    'expected object, got null',
  );
});

test('validateSubagentOutput: array accepts arrays only', () => {
  expectOk(validateSubagentOutput({ a: [1, 2] }, { a: 'array' }));
  expectErr(
    validateSubagentOutput({ a: { 0: 1 } }, { a: 'array' }),
    'expected array, got object',
  );
});

// ── missing + extra fields ──────────────────────────────────────────────────

test('validateSubagentOutput: missing required field → fail with field name', () => {
  expectErr(
    validateSubagentOutput({ result: 'ok' }, { result: 'text', count: 'int' }),
    'missing field "count"',
  );
});

test('validateSubagentOutput: explicit undefined field counts as missing', () => {
  expectErr(
    validateSubagentOutput({ result: undefined }, { result: 'text' }),
    'missing field "result"',
  );
});

test('validateSubagentOutput: extra fields beyond schema → ok (forward-compat)', () => {
  expectOk(
    validateSubagentOutput(
      { result: 'ok', extra: 'whatever', moar: 42 },
      { result: 'text' },
    ),
  );
});

// ── realistic shape ─────────────────────────────────────────────────────────

test('validateSubagentOutput: multi-field schema happy path', () => {
  const schema: Record<string, CatalogType> = {
    fileCount: 'int',
    summary: 'text',
    notable: 'array',
  };
  expectOk(
    validateSubagentOutput(
      { fileCount: 5, summary: 'short overview', notable: ['a', 'b'] },
      schema,
    ),
  );
});

test('validateSubagentOutput: first failing field surfaces, others don\'t mask it', () => {
  const result = validateSubagentOutput(
    { fileCount: 'five', summary: '...' },
    { fileCount: 'int', summary: 'text', notable: 'array' },
  );
  if (result.ok) throw new Error('expected failure');
  // Either the int mismatch OR the missing notable could come first; the
  // message must name fileCount OR notable — but the contract is that we
  // surface the first failing field deterministically (object key order
  // is insertion order in JS, so fileCount fires first here).
  assert.match(result.message, /fileCount/);
});
