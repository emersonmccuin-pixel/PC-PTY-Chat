// Pins the typed-edge save-time validator (Section 4h / 4h.4). Drives via
// parseTypedWorkflowText so the parser + validator integration is exercised
// end-to-end on each scenario.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTypedWorkflowText, validateTypedWorkflow } from '../src/index.ts';

function parse(yamlText: string, expectedId: string) {
  return parseTypedWorkflowText(yamlText, { expectedId });
}

function expectFail(yamlText: string, expectedId: string) {
  const r = parse(yamlText, expectedId);
  assert.equal(r.ok, false, 'expected validation to fail');
  return r.errors;
}

// --- resolution: trigger refs ----------------------------------------------

test('trigger ref to an exposed catalog name passes', () => {
  const yaml = `
id: t-trig-ok
triggers:
  on_enter: { stage_id: discovery }
attached_to_work_item: required
nodes:
  - id: attach
    attach-to-work-item:
      workItemId: '@trigger.workItemId'
      name: x.md
      content: y
`;
  const r = parse(yaml, 't-trig-ok');
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('trigger ref to an output the trigger does not expose fails', () => {
  // callable + required exposes workItemId only, NOT stageId.
  const yaml = `
id: t-trig-bad
triggers: { callable: true }
attached_to_work_item: required
nodes:
  - id: upd
    update-work-item:
      workItemId: '@trigger.workItemId'
      stage: '@trigger.stageId'
`;
  const errs = expectFail(yaml, 't-trig-bad');
  assert.ok(
    errs.some((e) => /trigger\.stageId/.test(e.message)),
    JSON.stringify(errs),
  );
});

test('multi-trigger intersection: on_enter ∩ callable+required exposes workItemId only', () => {
  const yaml = `
id: t-multi
triggers:
  on_enter: { stage_id: triage }
  callable: true
attached_to_work_item: required
nodes:
  - id: upd
    update-work-item:
      workItemId: '@trigger.workItemId'
      stage: '@trigger.stageId'
`;
  const errs = expectFail(yaml, 't-multi');
  // workItemId is in the intersection; stageId is on_enter-only → must fail
  assert.ok(
    errs.some((e) => /trigger\.stageId/.test(e.message)),
    JSON.stringify(errs),
  );
  assert.ok(
    !errs.some((e) => /trigger\.workItemId/.test(e.message)),
    JSON.stringify(errs),
  );
});

// --- resolution: node refs -------------------------------------------------

test('node ref to fixed-output kind passes when port exists', () => {
  const yaml = `
id: t-node-ok
triggers: { callable: true }
nodes:
  - id: cmd
    bash: echo hi
  - id: write
    depends_on: [cmd]
    subagent: writer
    prompt: 'code = {{ code }}'
    wire:
      code: '@cmd.exitCode'
`;
  const r = parse(yaml, 't-node-ok');
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('node ref to unknown output port fails with kind-specific message', () => {
  const yaml = `
id: t-node-bad
triggers: { callable: true }
nodes:
  - id: cmd
    bash: echo hi
  - id: write
    depends_on: [cmd]
    subagent: writer
    prompt: '{{ thing }}'
    wire:
      thing: '@cmd.notAnOutput'
`;
  const errs = expectFail(yaml, 't-node-bad');
  assert.ok(
    errs.some((e) => /no output "notAnOutput"/.test(e.message)),
    JSON.stringify(errs),
  );
});

test('node ref to unknown nodeId fails', () => {
  const yaml = `
id: t-unknown-node
triggers: { callable: true }
nodes:
  - id: write
    subagent: writer
    prompt: '{{ thing }}'
    wire:
      thing: '@no-such-node.field'
`;
  const errs = expectFail(yaml, 't-unknown-node');
  assert.ok(
    errs.some((e) => /unknown node "no-such-node"/.test(e.message)),
    JSON.stringify(errs),
  );
});

test('node ref to a subagent without output_schema fails with clear hint', () => {
  const yaml = `
id: t-no-schema
triggers: { callable: true }
nodes:
  - id: explore
    subagent: researcher
    prompt: explore
  - id: write
    depends_on: [explore]
    subagent: writer
    prompt: '{{ s }}'
    wire:
      s: '@explore.summary'
`;
  const errs = expectFail(yaml, 't-no-schema');
  assert.ok(
    errs.some((e) => /no output_schema/.test(e.message)),
    JSON.stringify(errs),
  );
});

test('node ref to a subagent output declared in output_schema passes', () => {
  const yaml = `
id: t-schema-ok
triggers: { callable: true }
nodes:
  - id: explore
    subagent: researcher
    prompt: explore
    output_schema:
      summary: text
      fileCount: int
  - id: write
    depends_on: [explore]
    subagent: writer
    prompt: '{{ s }} ({{ n }} files)'
    wire:
      s: '@explore.summary'
      n: '@explore.fileCount'
`;
  const r = parse(yaml, 't-schema-ok');
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('node ref to a subagent field not in output_schema fails', () => {
  const yaml = `
id: t-missing-field
triggers: { callable: true }
nodes:
  - id: explore
    subagent: researcher
    prompt: explore
    output_schema:
      summary: text
  - id: write
    depends_on: [explore]
    subagent: writer
    prompt: '{{ n }}'
    wire:
      n: '@explore.fileCount'
`;
  const errs = expectFail(yaml, 't-missing-field');
  assert.ok(
    errs.some((e) => /does not declare "fileCount"/.test(e.message)),
    JSON.stringify(errs),
  );
});

// --- type compatibility (D79) ----------------------------------------------

test('type mismatch: int output → string typed-port fails', () => {
  // bash exitCode is int; attach-to-work-item.workItemId is ulid (string-family
  // but not int)
  const yaml = `
id: t-mismatch
triggers: { callable: true }
nodes:
  - id: cmd
    bash: echo hi
  - id: attach
    depends_on: [cmd]
    attach-to-work-item:
      workItemId: '@cmd.exitCode'
      name: x.md
      content: y
`;
  const errs = expectFail(yaml, 't-mismatch');
  assert.ok(
    errs.some((e) => /type mismatch/.test(e.message)),
    JSON.stringify(errs),
  );
});

test('ulid widens to string OK', () => {
  // create-work-item produces { workItemId: ulid }; HTTP url accepts string.
  const yaml = `
id: t-widen
triggers: { callable: true }
nodes:
  - id: mk
    create-work-item:
      title: hello
  - id: fetch
    depends_on: [mk]
    http:
      method: GET
      url: '@mk.workItemId'
`;
  const r = parse(yaml, 't-widen');
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('env ref typed as string lands on a string port OK', () => {
  const yaml = `
id: t-env
triggers: { callable: true }
nodes:
  - id: fetch
    http:
      method: GET
      url: '@env.API_URL'
`;
  const r = parse(yaml, 't-env');
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// --- D76: optional contract + workItemId trigger wire ----------------------

test('optional Work Contract + @trigger.workItemId wire fails', () => {
  // attached_to_work_item omitted → defaults to optional
  const yaml = `
id: t-opt-bad
triggers: { callable: true }
nodes:
  - id: attach
    attach-to-work-item:
      workItemId: '@trigger.workItemId'
      name: x.md
      content: y
`;
  const errs = expectFail(yaml, 't-opt-bad');
  assert.ok(
    errs.some((e) => /attached_to_work_item to required/.test(e.message)),
    JSON.stringify(errs),
  );
});

test('required Work Contract + @trigger.workItemId wire passes', () => {
  const yaml = `
id: t-req-ok
triggers: { callable: true }
attached_to_work_item: required
nodes:
  - id: attach
    attach-to-work-item:
      workItemId: '@trigger.workItemId'
      name: x.md
      content: y
`;
  const r = parse(yaml, 't-req-ok');
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('optional + @trigger.workItemId inside wire: block also fails', () => {
  const yaml = `
id: t-opt-wire
triggers: { callable: true }
nodes:
  - id: write
    subagent: writer
    prompt: 'card={{ wi }}'
    wire:
      wi: '@trigger.workItemId'
`;
  const errs = expectFail(yaml, 't-opt-wire');
  assert.ok(
    errs.some((e) => /attached_to_work_item to required/.test(e.message)),
    JSON.stringify(errs),
  );
});

// --- combined-graph cycle (D79) --------------------------------------------

test('wire-introduced cycle fails (A reads from B, B reads from A)', () => {
  // Both nodes have output_schema'd subagents wiring to each other. Each
  // declares depends_on the other to keep the runtime in a valid topo at
  // legacy-validator time; but the depends_on cycle would already fail there.
  // So instead we use wires WITHOUT explicit depends_on to surface the
  // typed-validator combined-cycle check.
  const yaml = `
id: t-wire-cycle
triggers: { callable: true }
nodes:
  - id: a
    subagent: writer
    prompt: '{{ x }}'
    output_schema:
      out: text
    wire:
      x: '@b.out'
  - id: b
    subagent: writer
    prompt: '{{ y }}'
    output_schema:
      out: text
    wire:
      y: '@a.out'
`;
  const errs = expectFail(yaml, 't-wire-cycle');
  assert.ok(
    errs.some((e) => /cycle/.test(e.message)),
    JSON.stringify(errs),
  );
});

// --- validateTypedWorkflow alone (no parser) -------------------------------

test('validateTypedWorkflow runs cleanly on a parser-produced TypedWorkflow', () => {
  // Smoke test the direct entrypoint — exposes it for future callers
  // (registry, server endpoints) that want to revalidate after edits.
  const yaml = `
id: t-direct
triggers: { callable: true }
nodes:
  - id: cmd
    bash: echo hi
`;
  const r = parse(yaml, 't-direct');
  assert.equal(r.ok, true);
  if (!r.workflow || !r.edges) throw new Error('expected workflow + edges');
  const errs = validateTypedWorkflow({ workflow: r.workflow, edges: r.edges });
  assert.deepEqual([...errs], []);
});
