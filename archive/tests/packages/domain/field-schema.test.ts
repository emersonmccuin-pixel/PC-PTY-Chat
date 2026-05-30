// Truth table for validateFields. Pins the coercion + required + enum contract
// the WorkItem detail modal and the create/PATCH endpoints both rely on.
//
// Run via:  pnpm --filter @pc/domain test
// Or:       pnpm test:unit  (from repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { FieldSchema, ULID } from '../src/index.ts';
import { validateFields } from '../src/index.ts';

const projectId = '01HZZZZZZZZZZZZZZZZZZZZZZZ' as ULID;

function s(partial: Partial<FieldSchema> & Pick<FieldSchema, 'key' | 'type'>): FieldSchema {
  return {
    id: ('01' + partial.key.padEnd(24, 'X')) as ULID,
    projectId,
    label: partial.key,
    required: false,
    order: 0,
    ...partial,
  };
}

// --- text -------------------------------------------------------------------

test('text: accepts string', () => {
  const r = validateFields({ name: 'hi' }, [s({ key: 'name', type: 'text' })], { mode: 'create' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.value, { name: 'hi' });
});

test('text: rejects number', () => {
  const r = validateFields({ name: 42 }, [s({ key: 'name', type: 'text' })], { mode: 'create' });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.errors.name);
});

// --- number -----------------------------------------------------------------

test('number: accepts number', () => {
  const r = validateFields({ n: 7 }, [s({ key: 'n', type: 'number' })], { mode: 'create' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.value, { n: 7 });
});

test('number: coerces numeric string', () => {
  const r = validateFields({ n: '3.5' }, [s({ key: 'n', type: 'number' })], { mode: 'create' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.value, { n: 3.5 });
});

test('number: rejects non-numeric string', () => {
  const r = validateFields({ n: 'abc' }, [s({ key: 'n', type: 'number' })], { mode: 'create' });
  assert.equal(r.ok, false);
});

test('number: accepts zero (not treated as empty)', () => {
  const r = validateFields({ n: 0 }, [s({ key: 'n', type: 'number' })], { mode: 'create' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.value, { n: 0 });
});

// --- boolean ----------------------------------------------------------------

test('boolean: accepts true and false', () => {
  const schemas = [s({ key: 'b', type: 'boolean' })];
  const t = validateFields({ b: true }, schemas, { mode: 'create' });
  const f = validateFields({ b: false }, schemas, { mode: 'create' });
  assert.equal(t.ok, true);
  assert.deepEqual(t.ok && t.value, { b: true });
  assert.equal(f.ok, true);
  assert.deepEqual(f.ok && f.value, { b: false });
});

test('boolean: rejects string "true"', () => {
  const r = validateFields({ b: 'true' }, [s({ key: 'b', type: 'boolean' })], { mode: 'create' });
  assert.equal(r.ok, false);
});

// --- enum -------------------------------------------------------------------

test('enum: accepts allowed option', () => {
  const r = validateFields(
    { sev: 'high' },
    [s({ key: 'sev', type: 'enum', options: ['low', 'medium', 'high'] })],
    { mode: 'create' },
  );
  assert.equal(r.ok, true);
});

test('enum: rejects disallowed option', () => {
  const r = validateFields(
    { sev: 'critical' },
    [s({ key: 'sev', type: 'enum', options: ['low', 'medium', 'high'] })],
    { mode: 'create' },
  );
  assert.equal(r.ok, false);
});

test('enum: rejects when options missing', () => {
  const r = validateFields(
    { sev: 'high' },
    [s({ key: 'sev', type: 'enum' })],
    { mode: 'create' },
  );
  assert.equal(r.ok, false);
});

// --- date -------------------------------------------------------------------

test('date: accepts ISO date string and coerces to ms', () => {
  const r = validateFields(
    { d: '2026-05-17' },
    [s({ key: 'd', type: 'date' })],
    { mode: 'create' },
  );
  assert.equal(r.ok, true);
  assert.equal(typeof (r.ok && r.value.d), 'number');
  assert.equal(r.ok && r.value.d, Date.parse('2026-05-17'));
});

test('date: accepts numeric ms', () => {
  const ms = Date.parse('2026-05-17T12:00:00Z');
  const r = validateFields({ d: ms }, [s({ key: 'd', type: 'date' })], { mode: 'create' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.value, { d: ms });
});

test('date: rejects garbage string', () => {
  const r = validateFields({ d: 'not a date' }, [s({ key: 'd', type: 'date' })], {
    mode: 'create',
  });
  assert.equal(r.ok, false);
});

// --- required ---------------------------------------------------------------

test('required + create: missing key → error', () => {
  const r = validateFields(
    {},
    [s({ key: 'name', type: 'text', required: true })],
    { mode: 'create' },
  );
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.errors.name);
});

test('required + patch: missing key → ok (only validates submitted keys)', () => {
  const r = validateFields(
    {},
    [s({ key: 'name', type: 'text', required: true })],
    { mode: 'patch' },
  );
  assert.equal(r.ok, true);
});

test('required + empty string → error', () => {
  const r = validateFields(
    { name: '' },
    [s({ key: 'name', type: 'text', required: true })],
    { mode: 'create' },
  );
  assert.equal(r.ok, false);
});

test('required + null → error', () => {
  const r = validateFields(
    { name: null },
    [s({ key: 'name', type: 'text', required: true })],
    { mode: 'create' },
  );
  assert.equal(r.ok, false);
});

// --- default ---------------------------------------------------------------

test('create + missing key + default → default applied', () => {
  const r = validateFields(
    {},
    [s({ key: 'sev', type: 'enum', options: ['low', 'high'], default: 'low' })],
    { mode: 'create' },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.value, { sev: 'low' });
});

test('patch + missing key + default → default NOT applied', () => {
  const r = validateFields(
    {},
    [s({ key: 'sev', type: 'enum', options: ['low'], default: 'low' })],
    { mode: 'patch' },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.value, {});
});

// --- orphan keys ------------------------------------------------------------

test('orphan keys (no schema match) pass through', () => {
  const r = validateFields(
    { name: 'hi', legacyTag: 'rip' },
    [s({ key: 'name', type: 'text' })],
    { mode: 'patch' },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.value, { name: 'hi', legacyTag: 'rip' });
});

// --- multi-error aggregation ------------------------------------------------

test('multiple errors aggregate', () => {
  const r = validateFields(
    { a: 'x', b: 'y' },
    [s({ key: 'a', type: 'number' }), s({ key: 'b', type: 'boolean' })],
    { mode: 'create' },
  );
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.errors.a);
  assert.ok(!r.ok && r.errors.b);
});
