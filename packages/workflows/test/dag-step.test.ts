import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { WorkflowV2 } from '@pc/domain';
import {
  initDagState,
  selectReady,
  markRunning,
  markAwaitingReview,
  settleNode,
  markSkipped,
  loopSubtree,
  applyReviewDecision,
  computeRunStatus,
} from '../src/dag/index.ts';

type Node = WorkflowV2.WorkflowNode;
const noResolve = () => '';

function agent(id: string, next?: string[]): Node {
  return { kind: 'agent', id, agent: 'x', task: 't', ...(next ? { next } : {}) } as Node;
}
function review(id: string, opts: { next?: string[]; reject?: WorkflowV2.RejectEdge }): Node {
  return {
    kind: 'orchestrator-review',
    id,
    ...(opts.next ? { next: opts.next } : {}),
    ...(opts.reject ? { reject: opts.reject } : {}),
  } as Node;
}
function wf(nodes: Node[]): WorkflowV2.Workflow {
  return { id: 'w', name: 'w', triggers: [{ kind: 'manual' }], nodes };
}

// --- ready selection -----------------------------------------------------

test('initDagState: every node pending', () => {
  const w = wf([agent('a', ['b']), agent('b')]);
  const s = initDagState(w);
  assert.equal(s.nodes.a.state, 'pending');
  assert.equal(s.nodes.b.state, 'pending');
});

test('selectReady: only roots are ready; downstream waits', () => {
  const w = wf([agent('a', ['b']), agent('b')]);
  const { ready } = selectReady(w, initDagState(w), noResolve);
  assert.deepEqual(ready, ['a']);
});

test('selectReady: parallel roots both ready', () => {
  const w = wf([agent('a', ['c']), agent('b', ['c']), agent('c')]);
  const { ready } = selectReady(w, initDagState(w), noResolve);
  assert.deepEqual(ready.sort(), ['a', 'b']);
});

test('selectReady: downstream becomes ready once upstream settles', () => {
  const w = wf([agent('a', ['b']), agent('b')]);
  let s = initDagState(w);
  s = markRunning(s, 'a');
  s = settleNode(s, 'a', { state: 'completed' });
  assert.deepEqual(selectReady(w, s, noResolve).ready, ['b']);
});

test('selectReady: all_success upstream failure → downstream skipped', () => {
  const w = wf([agent('a', ['b']), agent('b')]);
  let s = settleNode(initDagState(w), 'a', { state: 'failed', error: 'boom' });
  const sel = selectReady(w, s, noResolve);
  assert.deepEqual(sel.ready, []);
  assert.deepEqual(sel.skips, [{ nodeId: 'b', reason: 'trigger_rule' }]);
});

test('selectReady: when:false → skipped', () => {
  const w = wf([agent('a', ['b']), { ...agent('b'), when: "$a.output == 'GO'" } as Node]);
  let s = settleNode(initDagState(w), 'a', { state: 'completed' });
  const resolve = () => 'STOP';
  const sel = selectReady(w, s, resolve);
  assert.deepEqual(sel.skips, [{ nodeId: 'b', reason: 'when_false' }]);
});

test('selectReady: unparseable when → skipped (fail-closed)', () => {
  const w = wf([agent('a', ['b']), { ...agent('b'), when: 'garbage' } as Node]);
  let s = settleNode(initDagState(w), 'a', { state: 'completed' });
  assert.equal(selectReady(w, s, noResolve).skips[0]!.reason, 'when_parse_error');
});

// --- run status ----------------------------------------------------------

test('computeRunStatus: running → completed', () => {
  const w = wf([agent('a', ['b']), agent('b')]);
  let s = initDagState(w);
  assert.equal(computeRunStatus(w, s), 'running');
  s = settleNode(s, 'a', { state: 'completed' });
  s = settleNode(s, 'b', { state: 'completed' });
  assert.equal(computeRunStatus(w, s), 'completed');
});

test('computeRunStatus: any failure (all settled) → failed', () => {
  const w = wf([agent('a')]);
  const s = settleNode(initDagState(w), 'a', { state: 'failed', error: 'x' });
  assert.equal(computeRunStatus(w, s), 'failed');
});

test('computeRunStatus: awaiting-review wins', () => {
  const w = wf([review('r', {})]);
  const s = markAwaitingReview(initDagState(w), 'r');
  assert.equal(computeRunStatus(w, s), 'awaiting-review');
});

// --- loop subtree --------------------------------------------------------

test('loopSubtree: code→review path excludes the downstream done node', () => {
  const w = wf([agent('code', ['r']), review('r', { next: ['done'], reject: { back_to: 'code' } }), agent('done')]);
  assert.deepEqual(loopSubtree(w, 'code', 'r').sort(), ['code', 'r']);
});

test('loopSubtree: multi-node loop body', () => {
  // code → test → review ; reject back_to code  → subtree {code,test,review}
  const w = wf([
    agent('code', ['test']),
    agent('test', ['r']),
    review('r', { reject: { back_to: 'code' } }),
  ]);
  assert.deepEqual(loopSubtree(w, 'code', 'r').sort(), ['code', 'r', 'test']);
});

// --- review approve / reject --------------------------------------------

test('approve: review completes, next becomes eligible, run completes', () => {
  const w = wf([agent('code', ['r']), review('r', { next: ['done'] }), agent('done')]);
  let s = settleNode(initDagState(w), 'code', { state: 'completed' });
  s = markAwaitingReview(s, 'r');
  const out = applyReviewDecision(w, s, 'r', { kind: 'approve' });
  s = out.state;
  assert.equal(s.nodes.r.state, 'completed');
  assert.deepEqual(selectReady(w, s, noResolve).ready, ['done']);
  s = settleNode(s, 'done', { state: 'completed' });
  assert.equal(computeRunStatus(w, s), 'completed');
});

test('reject under ceiling: resets loop subtree to pending, bumps iteration', () => {
  const w = wf([agent('code', ['r']), review('r', { next: ['done'], reject: { back_to: 'code', max_iterations: 3 } }), agent('done')]);
  let s = initDagState(w);
  s = markRunning(s, 'code');
  s = settleNode(s, 'code', { state: 'completed' });
  s = markAwaitingReview(s, 'r');

  const out = applyReviewDecision(w, s, 'r', { kind: 'reject', notes: 'fix it' });
  s = out.state;
  assert.equal(out.heldForHuman, false);
  assert.deepEqual(out.kickedBack!.sort(), ['code', 'r']);
  assert.equal(s.nodes.code.state, 'pending');
  assert.equal(s.nodes.r.state, 'pending');
  assert.equal(s.rejectIterations!.r, 1);
  // code is dispatchable again
  assert.deepEqual(selectReady(w, s, noResolve).ready, ['code']);
});

test('reject at ceiling: held for human, review node fails', () => {
  const w = wf([agent('code', ['r']), review('r', { next: ['done'], reject: { back_to: 'code', max_iterations: 2 } }), agent('done')]);
  let s = settleNode(initDagState(w), 'code', { state: 'completed' });
  s = markAwaitingReview(s, 'r');

  // 1st reject → kickback (count 1 < 2)
  let out = applyReviewDecision(w, s, 'r', { kind: 'reject' });
  assert.equal(out.heldForHuman, false);
  s = out.state;
  s = settleNode(s, 'code', { state: 'completed' });
  s = markAwaitingReview(s, 'r');
  // 2nd reject → ceiling (count 2 >= 2)
  out = applyReviewDecision(w, s, 'r', { kind: 'reject' });
  s = out.state;
  assert.equal(out.heldForHuman, true);
  assert.equal(s.nodes.r.state, 'failed');
  assert.equal(s.rejectIterations!.r, 2);
});

test('reject with no reject edge → review fails', () => {
  const w = wf([agent('code', ['r']), review('r', {})]);
  let s = settleNode(initDagState(w), 'code', { state: 'completed' });
  s = markAwaitingReview(s, 'r');
  const out = applyReviewDecision(w, s, 'r', { kind: 'reject' });
  assert.equal(out.state.nodes.r.state, 'failed');
  assert.equal(out.heldForHuman, false);
});

// --- end-to-end tick simulation -----------------------------------------

test('tick simulation: code → test (parallel-safe) → review approve → done', () => {
  const w = wf([
    agent('code', ['test']),
    agent('test', ['review']),
    review('review', { next: ['done'], reject: { back_to: 'code' } }),
    agent('done'),
  ]);
  let s = initDagState(w);
  const order: string[] = [];

  // Drive ticks: dispatch ready agents (auto-complete), pause at review.
  for (let guard = 0; guard < 50; guard++) {
    const { ready, skips } = selectReady(w, s, noResolve);
    for (const sk of skips) s = markSkipped(s, sk.nodeId, sk.reason);
    if (ready.length === 0) break;
    for (const id of ready) {
      s = markRunning(s, id);
      const node = w.nodes.find((n) => n.id === id)!;
      if (node.kind === 'orchestrator-review') {
        s = markAwaitingReview(s, id);
      } else {
        order.push(id);
        s = settleNode(s, id, { state: 'completed' });
      }
    }
    if (computeRunStatus(w, s) === 'awaiting-review') {
      s = applyReviewDecision(w, s, 'review', { kind: 'approve' }).state;
    }
  }

  assert.deepEqual(order, ['code', 'test', 'done']);
  assert.equal(computeRunStatus(w, s), 'completed');
});
