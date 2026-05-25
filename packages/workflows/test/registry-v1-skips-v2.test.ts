// Section 19.x — v1 registry must skip files carrying `version: 2`.
//
// Surfaced live in the 19.10 UI walk: publishing a v2 workflow via
// `pc_publish_workflow` landed it in the shared workflows dir, the v1
// `WorkflowRegistry.reload()` parsed it, the v1 typed-parser rejected it
// (v2 has no `triggers.on_enter`, no `subagent:` nodes, etc.), and the
// `invalid` entry surfaced with v1's ValidationError {path, message} shape.
// The frontend's WorkflowList renderer then crashed trying to use the object
// as a React child.
//
// Fix: registry.ts imports `isV2WorkflowText` and skips the file before
// `parseTypedWorkflowText` runs. The v2 registry handles v2 files
// independently.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowRegistry } from '../src/registry.ts';

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'pc-wf-v1-skip-v2-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const v2YamlValid = `version: 2
id: pc-published
name: PC published
worktree: none
triggers:
  - kind: manual
nodes:
  - id: echo
    kind: bash
    bash: echo hello
`;

const v2YamlBroken = `version: 2
id: pc-published-broken
name: Broken
triggers: not a list
nodes: []
`;

const v1YamlValid = `id: legacy-ok
triggers:
  on_enter:
    stage_id: backlog
nodes:
  - id: n1
    subagent: writer
    prompt: ok
`;

test('19.x v1 registry skips a valid `version: 2` file (no invalid surfacing)', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'pc-published.yaml'), v2YamlValid);
    const reg = new WorkflowRegistry(dir);
    const state = reg.reload();
    assert.equal(state.valid.length, 0, 'no v1-valid entries');
    assert.equal(state.invalid.length, 0, 'no v1-invalid entries — file was skipped, not parsed');
  });
});

test('19.x v1 registry skips an INVALID v2 file too (skip is shape-based, not validity-based)', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'pc-published-broken.yaml'), v2YamlBroken);
    const reg = new WorkflowRegistry(dir);
    const state = reg.reload();
    assert.equal(state.valid.length, 0);
    // Critical: invalid v2 files MUST NOT leak into v1's invalid list — that
    // would re-surface the React-child crash that 19.10 found.
    assert.equal(
      state.invalid.length,
      0,
      'invalid v2 file MUST NOT appear in v1 invalid list — the v2 registry owns these',
    );
  });
});

test('19.x v1 registry still loads a valid v1 file when v2 files coexist', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'pc-published.yaml'), v2YamlValid);
    writeFileSync(join(dir, 'legacy-ok.yaml'), v1YamlValid);
    const reg = new WorkflowRegistry(dir);
    const state = reg.reload();
    assert.equal(state.valid.length, 1, 'v1 file is loaded');
    assert.equal(state.valid[0]!.workflow.id, 'legacy-ok');
    assert.equal(state.invalid.length, 0, 'v2 file did not poison the invalid list');
  });
});
