// Section 19.4d — DAG executor orchestration, driven with fake deps. Verifies
// the control flow (dispatch → settle → advance → review pause → kick-back →
// approve → terminal) without any live spawn / DB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ULID, WorkflowV2 } from '@pc/domain';
import { DagExecutor, type DagExecutorDeps, type NodeOutcome } from '../src/services/dag-executor.ts';

type Node = WorkflowV2.WorkflowNode;

function agent(id: string, next?: string[]): Node {
  return { kind: 'agent', id, agent: 'pod', task: `do ${id}`, ...(next ? { next } : {}) } as Node;
}
function bash(id: string, next?: string[]): Node {
  return { kind: 'bash', id, bash: `echo ${id}`, ...(next ? { next } : {}) } as Node;
}
function review(id: string, opts: { next?: string[]; reject?: WorkflowV2.RejectEdge }): Node {
  return {
    kind: 'orchestrator-review',
    id,
    ...(opts.next ? { next: opts.next } : {}),
    ...(opts.reject ? { reject: opts.reject } : {}),
  } as Node;
}
function wf(nodes: Node[], extra: Partial<WorkflowV2.Workflow> = {}): WorkflowV2.Workflow {
  return { id: 'w', name: 'w', triggers: [{ kind: 'manual' }], nodes, ...extra };
}

interface Recorder {
  deps: DagExecutorDeps;
  agentCalls: string[];
  cmdCalls: string[];
  carries: { id: string; carry: Record<string, string> }[];
  reviewRequests: string[];
  events: { type: string; nodeId?: string }[];
  holds: string[];
  lastStatus: () => string | undefined;
  lastReason: () => string | undefined;
  outputs: Record<string, string>;
}

/** Fake deps. `agentOutcome` lets a test force a node's outcome; default completed. */
function recorder(opts: { agentOutcome?: (id: string, call: number) => NodeOutcome } = {}): Recorder {
  const agentCalls: string[] = [];
  const cmdCalls: string[] = [];
  const carries: { id: string; carry: Record<string, string> }[] = [];
  const reviewRequests: string[] = [];
  const events: { type: string; nodeId?: string }[] = [];
  const holds: string[] = [];
  const outputs: Record<string, string> = {};
  let lastStatus: string | undefined;
  let lastReason: string | undefined;
  const callCount: Record<string, number> = {};

  const deps: DagExecutorDeps = {
    resolveRef: () => (nodeId, field) => outputs[field ? `${nodeId}.${field}` : nodeId] ?? '',
    dispatchAgent: async (node, ctx) => {
      callCount[node.id] = (callCount[node.id] ?? 0) + 1;
      agentCalls.push(node.id);
      carries.push({ id: node.id, carry: { ...ctx.carry } });
      outputs[node.id] = `output-of-${node.id}`;
      return opts.agentOutcome
        ? opts.agentOutcome(node.id, callCount[node.id]!)
        : { state: 'completed', workItemId: `wi-${node.id}` as ULID };
    },
    runCommand: async (node) => {
      cmdCalls.push(node.id);
      return { state: 'completed' };
    },
    requestReview: async (node) => {
      reviewRequests.push(node.id);
    },
    persist: (_state, status, o) => {
      lastStatus = status;
      if (o?.lastReason !== undefined) lastReason = o.lastReason;
    },
    event: (ev) => events.push({ type: ev.type, nodeId: ev.nodeId }),
    isCancelled: () => false,
    holdForHuman: (nodeId) => holds.push(nodeId),
  };

  return {
    deps,
    agentCalls,
    cmdCalls,
    carries,
    reviewRequests,
    events,
    holds,
    outputs,
    lastStatus: () => lastStatus,
    lastReason: () => lastReason,
  };
}

const base = { runId: 'run-1' as ULID, rootWorkItemId: 'root-1' as ULID, worktreePath: null };

test('linear agent chain runs to completion', async () => {
  const r = recorder();
  const exec = DagExecutor.start(wf([agent('a', ['b']), agent('b')]), r.deps, base);
  const status = await exec.advance();
  assert.equal(status, 'completed');
  assert.deepEqual(r.agentCalls, ['a', 'b']);
});

test('parallel layer dispatches both, then converges', async () => {
  const r = recorder();
  const exec = DagExecutor.start(wf([agent('a', ['c']), agent('b', ['c']), agent('c')]), r.deps, base);
  const status = await exec.advance();
  assert.equal(status, 'completed');
  assert.deepEqual([...r.agentCalls].sort(), ['a', 'b', 'c']);
});

test('bash node goes through runCommand', async () => {
  const r = recorder();
  const exec = DagExecutor.start(wf([bash('build', ['ship']), agent('ship')]), r.deps, base);
  await exec.advance();
  assert.deepEqual(r.cmdCalls, ['build']);
  assert.deepEqual(r.agentCalls, ['ship']);
});

test('agent failure → run fails, downstream not dispatched', async () => {
  const r = recorder({ agentOutcome: (id) => (id === 'a' ? { state: 'failed', error: 'boom' } : { state: 'completed' }) });
  const exec = DagExecutor.start(wf([agent('a', ['b']), agent('b')]), r.deps, base);
  const status = await exec.advance();
  assert.equal(status, 'failed');
  assert.deepEqual(r.agentCalls, ['a']); // b skipped (all_success upstream failed)
  // F#2: failed runs must carry a lastReason derived from the failed node(s).
  assert.equal(r.lastReason(), 'a: boom');
});

test('review pause then approve → run completes', async () => {
  const r = recorder();
  const exec = DagExecutor.start(
    wf([agent('code', ['rev']), review('rev', { next: ['done'] }), agent('done')]),
    r.deps,
    base
  );
  let status = await exec.advance();
  assert.equal(status, 'awaiting-review');
  assert.deepEqual(r.reviewRequests, ['rev']);
  assert.deepEqual(r.agentCalls, ['code']); // done not yet run

  status = await exec.onReviewDecision('rev', { kind: 'approve' });
  assert.equal(status, 'completed');
  assert.deepEqual(r.agentCalls, ['code', 'done']);
});

test('review reject kicks back, re-runs code, then approve completes', async () => {
  const r = recorder();
  const exec = DagExecutor.start(
    wf([agent('code', ['rev']), review('rev', { next: ['done'], reject: { back_to: 'code', max_iterations: 3 } }), agent('done')]),
    r.deps,
    base
  );
  await exec.advance(); // → awaiting-review, code dispatched once
  assert.deepEqual(r.agentCalls, ['code']);

  let status = await exec.onReviewDecision('rev', { kind: 'reject', notes: 'fix' });
  assert.equal(status, 'awaiting-review'); // kicked back, code re-ran, paused again
  assert.deepEqual(r.agentCalls, ['code', 'code']);

  status = await exec.onReviewDecision('rev', { kind: 'approve' });
  assert.equal(status, 'completed');
  assert.deepEqual(r.agentCalls, ['code', 'code', 'done']);
});

test('reject past the ceiling → held for human, run fails', async () => {
  const r = recorder();
  const exec = DagExecutor.start(
    wf([agent('code', ['rev']), review('rev', { next: ['done'], reject: { back_to: 'code', max_iterations: 2 } }), agent('done')]),
    r.deps,
    base
  );
  await exec.advance();
  await exec.onReviewDecision('rev', { kind: 'reject' }); // count 1 < 2 → kickback
  const status = await exec.onReviewDecision('rev', { kind: 'reject' }); // count 2 ≥ 2 → ceiling
  assert.equal(status, 'failed');
  assert.deepEqual(r.holds, ['rev']);
  assert.ok(r.events.some((e) => e.type === 'iteration_ceiling_hit'));
  assert.deepEqual(r.agentCalls, ['code', 'code']); // never re-ran a 3rd time; done never ran
  // F#2: ceiling failures must carry a debuggable lastReason (was null pre-fix).
  assert.match(r.lastReason() ?? '', /rev: reject iteration ceiling reached \(2\/2\)/);
});

test('reject carry: reviewer notes flow into the re-dispatched node via $self.output (19.5)', async () => {
  const r = recorder();
  const exec = DagExecutor.start(
    wf([
      agent('code', ['rev']),
      review('rev', {
        next: ['done'],
        reject: { back_to: 'code', max_iterations: 3, carry: { feedback: '$self.output.notes' } },
      }),
      agent('done'),
    ]),
    r.deps,
    base
  );
  await exec.advance(); // first dispatch — no feedback yet
  assert.equal(r.carries[0]!.id, 'code');
  assert.equal(r.carries[0]!.carry.feedback ?? '', '');

  await exec.onReviewDecision('rev', { kind: 'reject', notes: 'tests miss edge case X' });
  // code re-ran; the reviewer's notes landed in its carry
  const reRun = r.carries.filter((c) => c.id === 'code')[1];
  assert.equal(reRun!.carry.feedback, 'tests miss edge case X');
});

test('cancellation between layers stops the run', async () => {
  const r = recorder();
  let cancel = false;
  r.deps.isCancelled = () => cancel;
  const exec = DagExecutor.start(wf([agent('a', ['b']), agent('b')]), r.deps, base);
  // cancel before first tick
  cancel = true;
  const status = await exec.advance();
  assert.equal(status, 'cancelled');
  assert.deepEqual(r.agentCalls, []);
});

test('emits lifecycle events (node_started/completed + workflow_completed)', async () => {
  const r = recorder();
  const exec = DagExecutor.start(wf([agent('a')]), r.deps, base);
  await exec.advance();
  const types = r.events.map((e) => e.type);
  assert.ok(types.includes('node_started'));
  assert.ok(types.includes('node_completed'));
  assert.ok(types.includes('workflow_completed'));
});
