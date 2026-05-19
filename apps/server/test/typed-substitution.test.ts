// Unit tests for typed-substitution.ts (Section 4h / 4h.5).
//
// Pins the runtime contract for typed-edge resolution:
//   - resolveEdgeRef: node / trigger / env source kinds, missing nodeOutputs
//     → undefined, primitive-only node outputs → undefined.
//   - resolveTriggerValue: well-known catalog names (workItemId, stageId,
//     projectId, runId, worktreePath) source from natural run fields;
//     webhook/session entries fall back to run.inputs.
//   - applyTypedPortEdges: clones the node, rewrites wired port values to
//     resolved EdgeRef results (string/object/primitive), no-ops when the
//     node has no edges registered.
//   - makeTemplateSubstituter: replaces `{{ name }}` placeholders from the
//     wire block (4h.9 path; legacy `$X.Y` chain was removed). Identity
//     fast-path when the node has no wire block.
//
// Run via:  pnpm --filter @pc/server test
// Or:       pnpm test:unit  (from repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  AttachToWorkItemNode,
  EdgeRef,
  HttpNode,
  NodeEdges,
  SubagentNode,
  WorkflowRun,
} from '@pc/domain';

import {
  applyTypedPortEdges,
  makeTemplateSubstituter,
  resolveEdgeRef,
  resolveTriggerValue,
  type TypedRefContext,
} from '../src/services/typed-substitution.ts';

function mkRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    workflowId: 'wf-test',
    workflowYamlSnapshot: '',
    status: 'in-progress',
    startedAt: new Date().toISOString(),
    worktreePath: null,
    nodeOutputs: {},
    ...overrides,
  };
}

function mkCtx(
  run: WorkflowRun,
  edges: Readonly<Record<string, NodeEdges>> = {},
  projectId = 'proj-1',
): TypedRefContext {
  return { run, projectId, edges };
}

// ── resolveTriggerValue ─────────────────────────────────────────────────────

test('resolveTriggerValue: workItemId reads run.workItemId', () => {
  const ctx = mkCtx(mkRun({ workItemId: 'wi-42' }));
  assert.equal(resolveTriggerValue('workItemId', ctx), 'wi-42');
});

test('resolveTriggerValue: stageId reads run.stageId', () => {
  const ctx = mkCtx(mkRun({ stageId: 'done' }));
  assert.equal(resolveTriggerValue('stageId', ctx), 'done');
});

test('resolveTriggerValue: projectId reads ctx.projectId', () => {
  const ctx = mkCtx(mkRun(), {}, 'proj-xyz');
  assert.equal(resolveTriggerValue('projectId', ctx), 'proj-xyz');
});

test('resolveTriggerValue: runId reads run.id', () => {
  const ctx = mkCtx(mkRun({ id: 'run-abc' }));
  assert.equal(resolveTriggerValue('runId', ctx), 'run-abc');
});

test('resolveTriggerValue: worktreePath reads run.worktreePath, null → undefined', () => {
  const ctxWith = mkCtx(mkRun({ worktreePath: '/tmp/wt' }));
  const ctxNull = mkCtx(mkRun({ worktreePath: null }));
  assert.equal(resolveTriggerValue('worktreePath', ctxWith), '/tmp/wt');
  assert.equal(resolveTriggerValue('worktreePath', ctxNull), undefined);
});

test('resolveTriggerValue: webhook entries route through run.inputs', () => {
  const ctx = mkCtx(mkRun({
    inputs: {
      webhookBody: 'hello',
      webhookQuery: { q: 'x' },
      webhookSource: 'github',
    },
  }));
  assert.equal(resolveTriggerValue('webhookBody', ctx), 'hello');
  assert.deepEqual(resolveTriggerValue('webhookQuery', ctx), { q: 'x' });
  assert.equal(resolveTriggerValue('webhookSource', ctx), 'github');
});

test('resolveTriggerValue: unknown name → undefined', () => {
  const ctx = mkCtx(mkRun());
  assert.equal(resolveTriggerValue('notACatalogName', ctx), undefined);
});

// ── resolveEdgeRef ─────────────────────────────────────────────────────────

test('resolveEdgeRef: node ref reads nodeOutputs[id].output.<field>', () => {
  const run = mkRun({
    nodeOutputs: {
      explore: { status: 'complete', output: { summary: 'short', count: 3 } },
    },
  });
  const ctx = mkCtx(run);
  assert.equal(
    resolveEdgeRef({ kind: 'node', nodeId: 'explore', output: 'summary' }, ctx),
    'short',
  );
  assert.equal(
    resolveEdgeRef({ kind: 'node', nodeId: 'explore', output: 'count' }, ctx),
    3,
  );
});

test('resolveEdgeRef: node ref on missing node → undefined', () => {
  const ctx = mkCtx(mkRun());
  assert.equal(
    resolveEdgeRef({ kind: 'node', nodeId: 'nope', output: 'x' }, ctx),
    undefined,
  );
});

test('resolveEdgeRef: node ref on primitive output → undefined (no field to drill)', () => {
  const run = mkRun({
    nodeOutputs: { simple: { status: 'complete', output: 'just a string' } },
  });
  const ctx = mkCtx(run);
  assert.equal(
    resolveEdgeRef({ kind: 'node', nodeId: 'simple', output: 'field' }, ctx),
    undefined,
  );
});

test('resolveEdgeRef: trigger ref dispatches to resolveTriggerValue', () => {
  const ctx = mkCtx(mkRun({ workItemId: 'wi-7' }));
  assert.equal(
    resolveEdgeRef({ kind: 'trigger', output: 'workItemId' }, ctx),
    'wi-7',
  );
});

test('resolveEdgeRef: env ref reads process.env', () => {
  process.env.PC_TYPED_REF_TEST = 'hello-env';
  const ctx = mkCtx(mkRun());
  try {
    assert.equal(
      resolveEdgeRef({ kind: 'env', name: 'PC_TYPED_REF_TEST' }, ctx),
      'hello-env',
    );
    assert.equal(
      resolveEdgeRef({ kind: 'env', name: 'PC_TYPED_REF_UNSET' }, ctx),
      undefined,
    );
  } finally {
    delete process.env.PC_TYPED_REF_TEST;
  }
});

// ── applyTypedPortEdges ─────────────────────────────────────────────────────

test('applyTypedPortEdges: node with no edges → returns input unchanged', () => {
  const node: SubagentNode = {
    id: 'n1',
    kind: 'subagent',
    subagent: 'researcher',
    prompt: 'do the thing',
  };
  const ctx = mkCtx(mkRun());
  const out = applyTypedPortEdges(node, ctx);
  assert.equal(out, node, 'fast path returns the exact same reference');
});

test('applyTypedPortEdges: subagent port rewired from trigger', () => {
  const node: SubagentNode = {
    id: 'n1',
    kind: 'subagent',
    subagent: '@trigger.workItemId',
    prompt: 'do the thing',
  };
  const edges: Record<string, NodeEdges> = {
    n1: {
      inputs: { subagent: { kind: 'trigger', output: 'workItemId' } as EdgeRef },
    },
  };
  const ctx = mkCtx(mkRun({ workItemId: 'wi-99' }), edges);
  const out = applyTypedPortEdges(node, ctx);
  assert.equal(out.subagent, 'wi-99');
  assert.equal(out.prompt, 'do the thing', 'non-port fields untouched');
});

test('applyTypedPortEdges: nested-body port rewired (attach-to-work-item.workItemId)', () => {
  const node: AttachToWorkItemNode = {
    id: 'attach-1',
    kind: 'attach-to-work-item',
    'attach-to-work-item': {
      workItemId: '@trigger.workItemId',
      name: 'summary.md',
      content: 'hi',
    },
  };
  const edges: Record<string, NodeEdges> = {
    'attach-1': {
      inputs: { workItemId: { kind: 'trigger', output: 'workItemId' } as EdgeRef },
    },
  };
  const ctx = mkCtx(mkRun({ workItemId: 'wi-42' }), edges);
  const out = applyTypedPortEdges(node, ctx);
  assert.equal(out['attach-to-work-item'].workItemId, 'wi-42');
  assert.equal(out['attach-to-work-item'].name, 'summary.md', 'unwired field untouched');
});

test('applyTypedPortEdges: object-typed port preserves object value (no stringification)', () => {
  const node: HttpNode = {
    id: 'h1',
    kind: 'http',
    http: {
      method: 'POST',
      url: 'https://example.com',
      headers: { existing: 'literal' },
    },
  };
  const edges: Record<string, NodeEdges> = {
    h1: {
      inputs: { headers: { kind: 'trigger', output: 'webhookHeaders' } as EdgeRef },
    },
  };
  const headersValue = { Authorization: 'Bearer xyz', 'x-trace': 'abc' };
  const ctx = mkCtx(mkRun({ inputs: { webhookHeaders: headersValue } }), edges);
  const out = applyTypedPortEdges(node, ctx);
  assert.deepEqual(out.http.headers, headersValue);
});

test('applyTypedPortEdges: undefined edge resolution → empty string (not "undefined" text)', () => {
  const node: SubagentNode = {
    id: 'n1',
    kind: 'subagent',
    subagent: '@create.workItemId',
    prompt: 'x',
  };
  const edges: Record<string, NodeEdges> = {
    n1: {
      inputs: { subagent: { kind: 'node', nodeId: 'create', output: 'workItemId' } as EdgeRef },
    },
  };
  // `create` hasn't run yet — its output is undefined.
  const ctx = mkCtx(mkRun(), edges);
  const out = applyTypedPortEdges(node, ctx);
  assert.equal(out.subagent, '');
});

test('applyTypedPortEdges: returns a clone — input node is not mutated', () => {
  const node: AttachToWorkItemNode = {
    id: 'attach-1',
    kind: 'attach-to-work-item',
    'attach-to-work-item': {
      workItemId: '@trigger.workItemId',
      name: 'a.md',
      content: 'b',
    },
  };
  const edges: Record<string, NodeEdges> = {
    'attach-1': {
      inputs: { workItemId: { kind: 'trigger', output: 'workItemId' } as EdgeRef },
    },
  };
  const ctx = mkCtx(mkRun({ workItemId: 'wi-1' }), edges);
  applyTypedPortEdges(node, ctx);
  assert.equal(
    node['attach-to-work-item'].workItemId,
    '@trigger.workItemId',
    'input body preserved',
  );
});

// ── makeTemplateSubstituter ────────────────────────────────────────────────

test('makeTemplateSubstituter: no wire block → identity', () => {
  const ctx = mkCtx(mkRun());
  const bound = makeTemplateSubstituter('n1', ctx);
  assert.equal(bound('hello world'), 'hello world');
  assert.equal(bound('{{ unknown }}'), '{{ unknown }}', 'no wire → placeholders are literal');
});

test('makeTemplateSubstituter: {{ name }} placeholder replaced from wire block', () => {
  const edges: Record<string, NodeEdges> = {
    n1: {
      wire: { summary: { kind: 'node', nodeId: 'explore', output: 'summary' } as EdgeRef },
    },
  };
  const run = mkRun({
    nodeOutputs: { explore: { status: 'complete', output: { summary: 'short story' } } },
  });
  const ctx = mkCtx(run, edges);
  const bound = makeTemplateSubstituter('n1', ctx);
  assert.equal(
    bound('Use this: {{ summary }} — done.'),
    'Use this: short story — done.',
  );
});

test('makeTemplateSubstituter: unknown placeholder name → empty string', () => {
  const edges: Record<string, NodeEdges> = {
    n1: { wire: { known: { kind: 'trigger', output: 'workItemId' } as EdgeRef } },
  };
  const ctx = mkCtx(mkRun({ workItemId: 'wi-5' }), edges);
  const bound = makeTemplateSubstituter('n1', ctx);
  assert.equal(bound('a={{ known }} b={{ unknown }}'), 'a=wi-5 b=');
});

test('makeTemplateSubstituter: stringifies object/number/boolean wire values', () => {
  const edges: Record<string, NodeEdges> = {
    n1: {
      wire: {
        n: { kind: 'node', nodeId: 'src', output: 'count' } as EdgeRef,
        b: { kind: 'node', nodeId: 'src', output: 'flag' } as EdgeRef,
        o: { kind: 'node', nodeId: 'src', output: 'obj' } as EdgeRef,
      },
    },
  };
  const run = mkRun({
    nodeOutputs: {
      src: {
        status: 'complete',
        output: { count: 42, flag: true, obj: { a: 1 } },
      },
    },
  });
  const ctx = mkCtx(run, edges);
  const bound = makeTemplateSubstituter('n1', ctx);
  assert.equal(
    bound('n={{ n }} b={{ b }} o={{ o }}'),
    'n=42 b=true o={"a":1}',
  );
});

test('makeTemplateSubstituter: whitespace inside {{ … }} tolerated', () => {
  const edges: Record<string, NodeEdges> = {
    n1: { wire: { x: { kind: 'trigger', output: 'workItemId' } as EdgeRef } },
  };
  const ctx = mkCtx(mkRun({ workItemId: 'wi-9' }), edges);
  const bound = makeTemplateSubstituter('n1', ctx);
  assert.equal(bound('a={{x}} b={{  x  }} c={{ x }}'), 'a=wi-9 b=wi-9 c=wi-9');
});
