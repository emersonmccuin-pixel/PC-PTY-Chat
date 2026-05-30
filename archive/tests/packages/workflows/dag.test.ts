import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { WorkflowV2 } from '@pc/domain';
import {
  buildTopologicalLayers,
  computeUpstreams,
  findForwardCycle,
  evaluateCondition,
  checkTriggerRule,
  substituteRefs,
  shellQuote,
  type RefResolver,
} from '../src/dag/index.ts';

type Node = WorkflowV2.WorkflowNode;

// Minimal node factory — only fields topo/when care about.
function agent(id: string, next?: string[]): Node {
  return { kind: 'agent', id, agent: 'x', task: 't', ...(next ? { next } : {}) } as Node;
}

// --- topology ------------------------------------------------------------

test('buildTopologicalLayers: linear chain → one node per layer', () => {
  const nodes = [agent('a', ['b']), agent('b', ['c']), agent('c')];
  const layers = buildTopologicalLayers(nodes).map((l) => l.map((n) => n.id));
  assert.deepEqual(layers, [['a'], ['b'], ['c']]);
});

test('buildTopologicalLayers: diamond → parallel middle layer', () => {
  const nodes = [agent('a', ['b', 'c']), agent('b', ['d']), agent('c', ['d']), agent('d')];
  const layers = buildTopologicalLayers(nodes).map((l) => l.map((n) => n.id).sort());
  assert.deepEqual(layers, [['a'], ['b', 'c'], ['d']]);
});

test('buildTopologicalLayers: two independent roots share layer 0', () => {
  const nodes = [agent('a', ['c']), agent('b', ['c']), agent('c')];
  const layers = buildTopologicalLayers(nodes).map((l) => l.map((n) => n.id).sort());
  assert.deepEqual(layers, [['a', 'b'], ['c']]);
});

test('buildTopologicalLayers: throws on a forward cycle', () => {
  const nodes = [agent('a', ['b']), agent('b', ['a'])];
  assert.throws(() => buildTopologicalLayers(nodes), /cycle/i);
});

test('buildTopologicalLayers: reject back-edge is NOT a cycle (excluded from topo)', () => {
  // review node `r` approves → done; rejects → back to `code`. The reject edge
  // must not register as a forward edge, so this layers cleanly.
  const code = agent('code', ['r']);
  const review = {
    kind: 'orchestrator-review',
    id: 'r',
    next: ['done'],
    reject: { back_to: 'code', max_iterations: 3 },
  } as Node;
  const done = agent('done');
  const layers = buildTopologicalLayers([code, review, done]).map((l) => l.map((n) => n.id));
  assert.deepEqual(layers, [['code'], ['r'], ['done']]);
});

test('forward edge to unknown node id is ignored by topo', () => {
  const nodes = [agent('a', ['ghost'])];
  const layers = buildTopologicalLayers(nodes).map((l) => l.map((n) => n.id));
  assert.deepEqual(layers, [['a']]);
});

test('computeUpstreams: inverts next edges', () => {
  const nodes = [agent('a', ['c']), agent('b', ['c']), agent('c')];
  const up = computeUpstreams(nodes);
  assert.deepEqual(up.get('c')!.sort(), ['a', 'b']);
  assert.deepEqual(up.get('a'), []);
});

test('findForwardCycle: returns path on cycle, null when acyclic', () => {
  assert.equal(findForwardCycle([agent('a', ['b']), agent('b')]), null);
  const cyc = findForwardCycle([agent('a', ['b']), agent('b', ['a'])]);
  assert.ok(cyc && cyc.includes('a') && cyc.includes('b'));
});

// --- when: evaluation ----------------------------------------------------

// resolver backed by a plain map of "nodeId" or "nodeId.field" → value
function resolverFrom(map: Record<string, string>): RefResolver {
  return (nodeId, field) => map[field ? `${nodeId}.${field}` : nodeId] ?? '';
}

test('evaluateCondition: string equality', () => {
  const r = resolverFrom({ classify: 'BUG' });
  assert.deepEqual(evaluateCondition("$classify.output == 'BUG'", r), { result: true, parsed: true });
  assert.deepEqual(evaluateCondition("$classify.output == 'FEATURE'", r), { result: false, parsed: true });
  assert.deepEqual(evaluateCondition("$classify.output != 'FEATURE'", r), { result: true, parsed: true });
});

test('evaluateCondition: dot field + numeric comparison', () => {
  const r = resolverFrom({ 'test.score': '92' });
  assert.equal(evaluateCondition("$test.output.score > '80'", r).result, true);
  assert.equal(evaluateCondition("$test.output.score >= '92'", r).result, true);
  assert.equal(evaluateCondition("$test.output.score < '80'", r).result, false);
});

test('evaluateCondition: numeric against non-numeric fails closed', () => {
  const r = resolverFrom({ 'test.score': 'high' });
  assert.deepEqual(evaluateCondition("$test.output.score > '80'", r), { result: false, parsed: false });
});

test('evaluateCondition: AND binds tighter than OR', () => {
  const r = resolverFrom({ a: 'X', b: 'Y', c: 'Z' });
  // (a==X && b==NO) || c==Z  → false || true → true
  assert.equal(evaluateCondition("$a.output == 'X' && $b.output == 'NO' || $c.output == 'Z'", r).result, true);
  // (a==X && b==Y) || c==NO → true
  assert.equal(evaluateCondition("$a.output == 'X' && $b.output == 'Y' || $c.output == 'NO'", r).result, true);
  // a==NO && ... → all-and false, no or → false
  assert.equal(evaluateCondition("$a.output == 'NO' && $b.output == 'Y'", r).result, false);
});

test('evaluateCondition: unparseable → fail-closed', () => {
  const r = resolverFrom({});
  assert.deepEqual(evaluateCondition('not an expression', r), { result: false, parsed: false });
});

// --- trigger_rule --------------------------------------------------------

test('checkTriggerRule: defaults to all_success', () => {
  assert.equal(checkTriggerRule(undefined, ['completed', 'completed']), 'run');
  assert.equal(checkTriggerRule(undefined, ['completed', 'failed']), 'skip');
});

test('checkTriggerRule: one_success / none_failed / all_done', () => {
  assert.equal(checkTriggerRule('one_success', ['failed', 'completed']), 'run');
  assert.equal(checkTriggerRule('none_failed_min_one_success', ['completed', 'skipped']), 'run');
  assert.equal(checkTriggerRule('none_failed_min_one_success', ['completed', 'failed']), 'skip');
  assert.equal(checkTriggerRule('all_done', ['completed', 'failed', 'skipped']), 'run');
  assert.equal(checkTriggerRule('all_done', ['completed', 'running']), 'skip');
});

test('checkTriggerRule: no upstreams → run (root node)', () => {
  assert.equal(checkTriggerRule('all_success', []), 'run');
});

// --- ref substitution ----------------------------------------------------

test('substituteRefs: plain output + dot field', () => {
  const r = resolverFrom({ code: 'patched A,B', 'test.verdict': 'pass' });
  assert.equal(substituteRefs('summary: $code.output', r), 'summary: patched A,B');
  assert.equal(substituteRefs('verdict=$test.output.verdict', r), 'verdict=pass');
});

test('substituteRefs: unknown ref → empty string', () => {
  const r = resolverFrom({});
  assert.equal(substituteRefs('x=$ghost.output', r), 'x=');
});

test('substituteRefs: bash-escaping single-quotes the value', () => {
  const r = resolverFrom({ code: "it's a value" });
  assert.equal(substituteRefs('$code.output', r, { escapedForBash: true }), `'it'\\''s a value'`);
});

test('shellQuote: wraps + escapes embedded quotes', () => {
  assert.equal(shellQuote('plain'), `'plain'`);
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
});
