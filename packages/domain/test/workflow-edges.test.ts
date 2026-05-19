// Pins the EdgeRef parser/formatter contract (Section 4h / 4h.3). Compact
// `'@X.Y'` ↔ structured EdgeRef round-trip.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EdgeRef } from '../src/index.ts';
import { formatEdgeRef, isCompactEdgeRef, parseEdgeRef } from '../src/index.ts';

test('parseEdgeRef: node ref', () => {
  assert.deepEqual(parseEdgeRef('@create-card.workItemId'), {
    kind: 'node',
    nodeId: 'create-card',
    output: 'workItemId',
  });
});

test('parseEdgeRef: trigger ref', () => {
  assert.deepEqual(parseEdgeRef('@trigger.workItemId'), {
    kind: 'trigger',
    output: 'workItemId',
  });
});

test('parseEdgeRef: env ref', () => {
  assert.deepEqual(parseEdgeRef('@env.GITHUB_TOKEN'), {
    kind: 'env',
    name: 'GITHUB_TOKEN',
  });
});

test('parseEdgeRef: identifier-with-dashes node id', () => {
  assert.deepEqual(parseEdgeRef('@some-node-id.fieldName'), {
    kind: 'node',
    nodeId: 'some-node-id',
    output: 'fieldName',
  });
});

test('parseEdgeRef: rejects non-ref strings', () => {
  assert.equal(parseEdgeRef('plain literal'), null);
  assert.equal(parseEdgeRef(''), null);
  assert.equal(parseEdgeRef('@'), null);
  assert.equal(parseEdgeRef('@incomplete'), null);
  assert.equal(parseEdgeRef('@a.'), null);
  assert.equal(parseEdgeRef('@.foo'), null);
  assert.equal(parseEdgeRef('@a.b.c'), null);
  assert.equal(parseEdgeRef('not.an.@ref'), null);
});

test('parseEdgeRef: rejects strings with embedded whitespace', () => {
  assert.equal(parseEdgeRef('@trigger .workItemId'), null);
  assert.equal(parseEdgeRef('@trigger. workItemId'), null);
  assert.equal(parseEdgeRef(' @trigger.workItemId'), null);
});

test('isCompactEdgeRef: cheap pre-check', () => {
  assert.equal(isCompactEdgeRef('@trigger.workItemId'), true);
  assert.equal(isCompactEdgeRef('@anything'), true);
  assert.equal(isCompactEdgeRef('literal'), false);
  assert.equal(isCompactEdgeRef(''), false);
  assert.equal(isCompactEdgeRef(42), false);
  assert.equal(isCompactEdgeRef(null), false);
  assert.equal(isCompactEdgeRef(undefined), false);
});

test('formatEdgeRef: round-trips parseEdgeRef', () => {
  const cases: readonly string[] = [
    '@trigger.workItemId',
    '@env.GITHUB_TOKEN',
    '@some-node.someField',
  ];
  for (const s of cases) {
    const ref = parseEdgeRef(s);
    assert.ok(ref, s);
    assert.equal(formatEdgeRef(ref as EdgeRef), s);
  }
});

test('formatEdgeRef: covers every kind explicitly', () => {
  assert.equal(formatEdgeRef({ kind: 'node', nodeId: 'a', output: 'b' }), '@a.b');
  assert.equal(formatEdgeRef({ kind: 'trigger', output: 'workItemId' }), '@trigger.workItemId');
  assert.equal(formatEdgeRef({ kind: 'env', name: 'TOKEN' }), '@env.TOKEN');
});
