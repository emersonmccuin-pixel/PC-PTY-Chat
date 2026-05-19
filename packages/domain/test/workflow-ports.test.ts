// Pins the per-node-kind port schemas (Section 4h / 4h.2). The schemas are
// the contract the typed-edge parser (4h.3), save-time validator (4h.4),
// runtime substitution (4h.5), and graph editor (4h.11) all bind against.
// Anyone bumping a kind's IO bumps this test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { DagNode, NodePortSchema, PortShape } from '../src/index.ts';
import {
  CATALOG_TYPES,
  NODE_PORT_SCHEMAS,
  WORKFLOW_CATALOG,
  getPortSchema,
  isCatalogName,
} from '../src/index.ts';

const KINDS = [
  'subagent',
  'bash',
  'http',
  'script',
  'approval',
  'cancel',
  'workflow',
  'loop',
  'attach-to-work-item',
  'create-work-item',
  'update-work-item',
  'write-to-worktree',
  'orchestrator-review',
] as const satisfies readonly DagNode['kind'][];

// --- coverage ---------------------------------------------------------------

test('NODE_PORT_SCHEMAS covers every DagNode kind', () => {
  for (const k of KINDS) {
    const s: NodePortSchema | undefined = NODE_PORT_SCHEMAS[k];
    assert.ok(s, `missing schema: ${k}`);
    assert.equal(s.kind, k);
  }
  assert.equal(Object.keys(NODE_PORT_SCHEMAS).length, KINDS.length);
});

// --- type vocabulary --------------------------------------------------------

test('every fixed port type is a known CatalogType', () => {
  for (const k of KINDS) {
    const s = NODE_PORT_SCHEMAS[k];
    walkFixedTypes(k, s.inputs);
    walkFixedTypes(k, s.outputs);
  }
});

function walkFixedTypes(kind: string, shape: PortShape): void {
  if (shape.mode !== 'fixed') return;
  for (const p of shape.ports) {
    assert.ok(
      CATALOG_TYPES.includes(p.type),
      `${kind}.${p.name}: type "${p.type}" not in CATALOG_TYPES`,
    );
  }
}

test("catalog-named ports carry the catalog's type", () => {
  for (const k of KINDS) {
    const s = NODE_PORT_SCHEMAS[k];
    for (const shape of [s.inputs, s.outputs]) {
      if (shape.mode !== 'fixed') continue;
      for (const p of shape.ports) {
        if (isCatalogName(p.name)) {
          assert.equal(
            p.type,
            WORKFLOW_CATALOG[p.name].type,
            `${k}.${p.name}: port type "${p.type}" != catalog type "${WORKFLOW_CATALOG[p.name].type}"`,
          );
        }
      }
    }
  }
});

// --- name hygiene -----------------------------------------------------------

test('every port name + template name is unique within its kind', () => {
  for (const k of KINDS) {
    const s = NODE_PORT_SCHEMAS[k];
    const inputNames =
      s.inputs.mode === 'fixed' ? s.inputs.ports.map((p) => p.name) : [];
    const outputNames =
      s.outputs.mode === 'fixed' ? s.outputs.ports.map((p) => p.name) : [];
    const tmplNames = s.templates.map((t) => t.name);
    assert.equal(new Set(inputNames).size, inputNames.length, `${k}: duplicate input ports`);
    assert.equal(new Set(outputNames).size, outputNames.length, `${k}: duplicate output ports`);
    assert.equal(new Set(tmplNames).size, tmplNames.length, `${k}: duplicate template fields`);
    const inputAndTmpl = new Set([...inputNames, ...tmplNames]);
    assert.equal(
      inputAndTmpl.size,
      inputNames.length + tmplNames.length,
      `${k}: input port and template field share a name`,
    );
  }
});

test('every port + template has a non-empty description', () => {
  for (const k of KINDS) {
    const s = NODE_PORT_SCHEMAS[k];
    for (const shape of [s.inputs, s.outputs]) {
      if (shape.mode !== 'fixed') continue;
      for (const p of shape.ports) {
        assert.ok(p.description.trim().length > 0, `${k}.${p.name}: empty description`);
      }
    }
    for (const t of s.templates) {
      assert.ok(t.description.trim().length > 0, `${k}.${t.name}: empty description`);
    }
  }
});

// --- pinned shapes per D78 + buildout --------------------------------------

test('subagent outputs are author-declared', () => {
  assert.equal(NODE_PORT_SCHEMAS.subagent.outputs.mode, 'author-declared');
});

test('subagent requires a `subagent` input port + `prompt` template', () => {
  const s = NODE_PORT_SCHEMAS.subagent;
  if (s.inputs.mode !== 'fixed') throw new Error('expected fixed inputs');
  const sub = s.inputs.ports.find((p) => p.name === 'subagent');
  assert.ok(sub);
  assert.equal(sub?.type, 'string');
  assert.equal(sub?.required, true);
  const prompt = s.templates.find((t) => t.name === 'prompt');
  assert.ok(prompt);
  assert.equal(prompt?.required, true);
});

test('workflow (nested) inputs + outputs both inherit from called workflow', () => {
  assert.equal(NODE_PORT_SCHEMAS.workflow.inputs.mode, 'nested-workflow');
  assert.equal(NODE_PORT_SCHEMAS.workflow.outputs.mode, 'nested-workflow');
});

test('attach-to-work-item requires workItemId as a ulid', () => {
  const s = NODE_PORT_SCHEMAS['attach-to-work-item'];
  if (s.inputs.mode !== 'fixed') throw new Error('expected fixed inputs');
  const wi = s.inputs.ports.find((p) => p.name === 'workItemId');
  assert.ok(wi);
  assert.equal(wi?.type, 'ulid');
  assert.equal(wi?.required, true);
});

test('create-work-item produces a workItemId output', () => {
  const s = NODE_PORT_SCHEMAS['create-work-item'];
  if (s.outputs.mode !== 'fixed') throw new Error('expected fixed outputs');
  const wi = s.outputs.ports.find((p) => p.name === 'workItemId');
  assert.ok(wi);
  assert.equal(wi?.type, 'ulid');
});

test('bash and script share the {exitCode, stdout, stderr} output shape', () => {
  const expected = ['exitCode', 'stderr', 'stdout'];
  for (const k of ['bash', 'script'] as const) {
    const s = NODE_PORT_SCHEMAS[k];
    if (s.outputs.mode !== 'fixed') throw new Error(`${k}: expected fixed outputs`);
    assert.deepEqual([...s.outputs.ports.map((p) => p.name)].sort(), expected);
  }
});

test('http outputs status + body per D78', () => {
  const s = NODE_PORT_SCHEMAS.http;
  if (s.outputs.mode !== 'fixed') throw new Error('expected fixed outputs');
  assert.deepEqual(
    [...s.outputs.ports.map((p) => p.name)].sort(),
    ['body', 'status'],
  );
});

test('review-style kinds output {decision, notes}', () => {
  for (const k of ['approval', 'orchestrator-review'] as const) {
    const s = NODE_PORT_SCHEMAS[k];
    if (s.outputs.mode !== 'fixed') throw new Error(`${k}: expected fixed outputs`);
    assert.deepEqual(
      [...s.outputs.ports.map((p) => p.name)].sort(),
      ['decision', 'notes'],
    );
  }
});

test('kinds with no outputs are modeled as fixed empty arrays (not author-declared)', () => {
  for (const k of [
    'cancel',
    'loop',
    'attach-to-work-item',
    'update-work-item',
    'write-to-worktree',
  ] as const) {
    const s = NODE_PORT_SCHEMAS[k];
    assert.equal(s.outputs.mode, 'fixed', `${k}: expected fixed outputs`);
    if (s.outputs.mode === 'fixed') {
      assert.equal(s.outputs.ports.length, 0, `${k}: expected zero output ports`);
    }
  }
});

// --- helper -----------------------------------------------------------------

test('getPortSchema returns the same object as NODE_PORT_SCHEMAS lookup', () => {
  assert.equal(getPortSchema('bash'), NODE_PORT_SCHEMAS.bash);
  assert.equal(getPortSchema('subagent'), NODE_PORT_SCHEMAS.subagent);
  assert.equal(getPortSchema('orchestrator-review'), NODE_PORT_SCHEMAS['orchestrator-review']);
});
