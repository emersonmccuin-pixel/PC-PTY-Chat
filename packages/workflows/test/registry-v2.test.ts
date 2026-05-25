// Section 19 — v2 workflow registry: scans a dir, indexes valid v2, flags
// invalid v2, skips v1 files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowV2Registry } from '../src/registry-v2.ts';

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'pc-wf-v2-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const validV2 = `version: 2
id: ok
name: OK
triggers:
  - kind: stage-on-entry
    stage: build
nodes:
  - { kind: agent, id: a, agent: p, task: t }
`;

const invalidV2 = `version: 2
id: broken
name: Broken
triggers:
  - kind: stage-on-entry
    stage: review
nodes:
  - { kind: agent, id: a, agent: p, task: t, next: [ghost] }
`;

const v1File = `id: legacy
triggers:
  on_enter:
    stage_id: build
nodes: []
`;

test('indexes valid v2, flags invalid v2, skips v1', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'ok.yaml'), validV2);
    writeFileSync(join(dir, 'broken.yaml'), invalidV2);
    writeFileSync(join(dir, 'legacy.yaml'), v1File);

    const reg = new WorkflowV2Registry(dir);
    const state = reg.reload();

    assert.deepEqual(state.valid.map((e) => e.workflow.id), ['ok']);
    assert.equal(state.invalid.length, 1);
    assert.equal(state.invalid[0]!.fileName, 'broken.yaml');
    assert.equal(state.invalid[0]!.partialStageId, 'review');
    assert.ok(state.invalid[0]!.errors.some((e) => /ghost/.test(e)));
  });
});

test('listValid returns the parsed workflows; findById looks one up', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'ok.yaml'), validV2);
    const reg = new WorkflowV2Registry(dir);
    assert.deepEqual(reg.listValid().map((w) => w.id), ['ok']);
    assert.equal(reg.findById('ok')?.workflow.name, 'OK');
    assert.equal(reg.findById('nope'), undefined);
  });
});

test('id is coerced to the filename', () => {
  withDir((dir) => {
    // body says id: ok, but the file is named different.yaml
    writeFileSync(join(dir, 'different.yaml'), validV2);
    const reg = new WorkflowV2Registry(dir);
    assert.deepEqual(reg.listValid().map((w) => w.id), ['different']);
  });
});

test('missing dir yields empty state', () => {
  const reg = new WorkflowV2Registry(join(tmpdir(), 'pc-wf-v2-does-not-exist-xyz'));
  const state = reg.reload();
  assert.deepEqual(state, { valid: [], invalid: [] });
});
