// Pins the typed-edge YAML parser (Section 4h / 4h.3). Exercises every kind
// that carries wires + the `wire:` block + subagent output_schema + loop body
// recursion. The legacy parser still owns structural validation; this test
// suite focuses on the edge-extraction layer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTypedWorkflowText } from '../src/index.ts';

function ok(yamlText: string, expectedId: string) {
  const r = parseTypedWorkflowText(yamlText, { expectedId });
  if (!r.ok) {
    assert.fail(
      `expected typed-parse ok; got errors:\n${r.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`,
    );
  }
  if (!r.workflow || !r.edges) throw new Error('expected workflow + edges');
  return { workflow: r.workflow, edges: r.edges };
}

// --- typed-port wires (D77 A) ----------------------------------------------

test('attach-to-work-item: workItemId compact ref desugars into edges.inputs', () => {
  const yaml = `
id: t1
triggers:
  on_enter: { stage_id: discovery }
attached_to_work_item: required
nodes:
  - id: attach
    attach-to-work-item:
      workItemId: '@trigger.workItemId'
      name: notes.md
      content: hello
`;
  const r = ok(yaml, 't1');
  assert.deepEqual(r.edges.attach?.inputs, {
    workItemId: { kind: 'trigger', output: 'workItemId' },
  });
  // No wire: block + no output_schema on this node.
  assert.equal(r.edges.attach?.wire, undefined);
  assert.equal(r.edges.attach?.output_schema, undefined);
});

test('literal-valued typed port produces no edge entry', () => {
  const yaml = `
id: t2
triggers: { callable: true }
attached_to_work_item: optional
nodes:
  - id: attach
    attach-to-work-item:
      workItemId: '01HZZZZZZZZZZZZZZZZZZZZZZZ'
      name: notes.md
      content: hello
`;
  const r = ok(yaml, 't2');
  assert.equal(r.edges.attach, undefined);
});

test('http url can be wired; method literal stays literal', () => {
  // @env.* is always resolvable, sidesteps trigger-exposure rules for this
  // test which is about extraction shape, not exposure semantics.
  const yaml = `
id: t3
triggers: { callable: true }
nodes:
  - id: fetch
    http:
      method: GET
      url: '@env.API_URL'
      headers:
        Authorization: 'Bearer abc'
`;
  const r = ok(yaml, 't3');
  assert.deepEqual(r.edges.fetch?.inputs, {
    url: { kind: 'env', name: 'API_URL' },
  });
});

test('subagent.subagent field can be wired (dynamic dispatch)', () => {
  const yaml = `
id: t4
triggers: { callable: true }
nodes:
  - id: run
    subagent: '@env.DEFAULT_AGENT'
    prompt: 'hi'
`;
  const r = ok(yaml, 't4');
  assert.deepEqual(r.edges.run?.inputs, {
    subagent: { kind: 'env', name: 'DEFAULT_AGENT' },
  });
});

// --- wire block (D77 B) ----------------------------------------------------

test('subagent wire: block extracts each entry as an EdgeRef', () => {
  const yaml = `
id: t5
triggers: { callable: true }
nodes:
  - id: explore
    subagent: researcher
    prompt: 'look around'
    output_schema:
      summary: text
      fileCount: int
  - id: write
    depends_on: [explore]
    subagent: writer
    prompt: |
      Found {{ count }} files. Summary: {{ summary }}.
    wire:
      summary: '@explore.summary'
      count: '@explore.fileCount'
`;
  const r = ok(yaml, 't5');
  assert.deepEqual(r.edges.write?.wire, {
    summary: { kind: 'node', nodeId: 'explore', output: 'summary' },
    count: { kind: 'node', nodeId: 'explore', output: 'fileCount' },
  });
});

test('wire: with @env ref captures env edge kind', () => {
  const yaml = `
id: t6
triggers: { callable: true }
nodes:
  - id: fetch
    http:
      method: POST
      url: https://api.example.com
      body: '{"token":"{{ token }}"}'
    wire:
      token: '@env.API_TOKEN'
`;
  const r = ok(yaml, 't6');
  assert.deepEqual(r.edges.fetch?.wire?.token, { kind: 'env', name: 'API_TOKEN' });
});

test('malformed wire entry surfaces a structured error', () => {
  const yaml = `
id: t7
triggers: { callable: true }
nodes:
  - id: write
    subagent: writer
    prompt: hi
    wire:
      broken: 'not-a-ref'
`;
  const r = parseTypedWorkflowText(yaml, { expectedId: 't7' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'nodes[0].wire.broken'));
});

test('wire: must be a map, not an array', () => {
  const yaml = `
id: t8
triggers: { callable: true }
nodes:
  - id: write
    subagent: writer
    prompt: hi
    wire:
      - '@trigger.workItemId'
`;
  const r = parseTypedWorkflowText(yaml, { expectedId: 't8' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'nodes[0].wire'));
});

// --- output_schema (D78) ---------------------------------------------------

test('subagent output_schema captures author-declared field types', () => {
  const yaml = `
id: t9
triggers: { callable: true }
nodes:
  - id: explore
    subagent: researcher
    prompt: explore
    output_schema:
      fileCount: int
      summary: text
      notable: array
`;
  const r = ok(yaml, 't9');
  assert.deepEqual(r.edges.explore?.output_schema, {
    fileCount: 'int',
    summary: 'text',
    notable: 'array',
  });
});

test('unknown output_schema type surfaces an error', () => {
  const yaml = `
id: t10
triggers: { callable: true }
nodes:
  - id: explore
    subagent: researcher
    prompt: explore
    output_schema:
      summary: chicken
`;
  const r = parseTypedWorkflowText(yaml, { expectedId: 't10' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'nodes[0].output_schema.summary'));
});

test('output_schema on non-subagent kind is silently ignored', () => {
  const yaml = `
id: t11
triggers: { callable: true }
nodes:
  - id: cmd
    bash: echo hi
    output_schema:
      anything: int
`;
  const r = ok(yaml, 't11');
  assert.equal(r.edges.cmd?.output_schema, undefined);
});

// --- loop body recursion ---------------------------------------------------

test('loop body inner-node edges land in the same flat map', () => {
  const yaml = `
id: t12
triggers: { callable: true }
nodes:
  - id: spin
    loop:
      until: 'true'
      max_iterations: 3
      body:
        - id: write-each
          subagent: writer
          prompt: 'iteration'
          wire:
            seed: '@env.SEED'
`;
  const r = ok(yaml, 't12');
  assert.deepEqual(r.edges['write-each']?.wire, {
    seed: { kind: 'env', name: 'SEED' },
  });
});

// --- malformed-ref detection inside typed ports ---------------------------

test('typed port with @-prefixed garbage surfaces a structured error', () => {
  const yaml = `
id: t13
triggers: { callable: true }
nodes:
  - id: attach
    attach-to-work-item:
      workItemId: '@bad'
      name: x
      content: y
`;
  const r = parseTypedWorkflowText(yaml, { expectedId: 't13' });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => e.path === 'nodes[0].attach-to-work-item.workItemId'),
    JSON.stringify(r.errors),
  );
});

// --- nodes without typed edges fall through cleanly -----------------------

test('a wholly literal workflow produces an empty edges map', () => {
  const yaml = `
id: t14
triggers: { callable: true }
nodes:
  - id: cmd
    bash: echo hi
`;
  const r = ok(yaml, 't14');
  assert.deepEqual(r.edges, {});
});

// --- legacy-parse failure propagates --------------------------------------

test('structural error from legacy parser blocks typed parse', () => {
  const yaml = `
id: wrong-id-on-purpose
triggers: { callable: true }
nodes:
  - id: cmd
    bash: echo hi
`;
  const r = parseTypedWorkflowText(yaml, { expectedId: 't15' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'id'));
});
