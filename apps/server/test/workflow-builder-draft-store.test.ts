// Section 19.9 — focused tests for ProjectRuntime's workflow-builder draft
// store. The store is in-memory + keyed by transient PC_SESSION_ID; this
// pins the contract that the modal + the agent (via pc_save_workflow_draft /
// pc_read_workflow_draft) rely on.
//
// The PtySession-spawning side of startWorkflowBuilder isn't exercised here —
// it depends on `preparePodSpawn` (DB-resident pod row + materialised mcp.json)
// + real claude.exe + the per-spawn handshake. Pod-spawn is covered by
// agent-designer integration; this file targets the draft-store seam.
//
// Run via: pnpm --filter @pc/server test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Project, Stage, ULID, WorkflowV2 } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-wb-draft-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, runMigrations, createProject } = await import('@pc/db');
const { ProjectRuntime } = await import('../src/services/project-runtime.ts');

const stages: Stage[] = [
  { id: 'backlog', name: 'Backlog', order: 0 },
  { id: 'done', name: 'Done', order: 1 },
];

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

let seq = 0;

function mkRuntime(): InstanceType<typeof ProjectRuntime> {
  seq += 1;
  const folder = resolve(tmpDir, `proj-${String(seq)}`);
  mkdirSync(folder, { recursive: true });
  const project = createProject({
    slug: `wb-draft-${String(seq)}`,
    name: `wb draft ${String(seq)}`,
    stages,
    folderPath: folder,
  }) as unknown as Project;
  return new ProjectRuntime(project, {
    dataDir: tmpDir,
    channelPort: 0,
    broadcast: () => {},
    templatesDir: resolve(tmpDir, 'templates'),
    trunkPath: tmpDir,
  });
}

function sampleDraft(id: string): WorkflowV2.Workflow {
  return {
    id,
    name: id,
    triggers: [{ kind: 'manual' }],
    nodes: [
      { id: 'a', kind: 'bash', bash: 'echo hello', next: ['b'] } as WorkflowV2.BashNode,
      { id: 'b', kind: 'bash', bash: 'echo world' } as WorkflowV2.BashNode,
    ],
  };
}

test('19.9 draft store: save → read round-trip returns the same def', () => {
  const rt = mkRuntime();
  const draft = sampleDraft('wf-1');
  rt.setWorkflowBuilderDraft('sess-1' as ULID, draft);
  const read = rt.getWorkflowBuilderDraft('sess-1' as ULID);
  assert.deepEqual(read, draft);
});

test('19.9 draft store: unknown session id returns undefined (no info leak)', () => {
  const rt = mkRuntime();
  rt.setWorkflowBuilderDraft('sess-real', sampleDraft('wf-2'));
  assert.equal(rt.getWorkflowBuilderDraft('sess-other'), undefined);
});

test('19.9 draft store: subsequent save replaces the prior draft', () => {
  const rt = mkRuntime();
  const first = sampleDraft('wf-3');
  rt.setWorkflowBuilderDraft('sess-3', first);
  // Add a node + save again.
  const second: WorkflowV2.Workflow = {
    ...first,
    nodes: [
      ...first.nodes,
      { id: 'c', kind: 'bash', bash: 'echo more' } as WorkflowV2.BashNode,
    ],
  };
  rt.setWorkflowBuilderDraft('sess-3', second);
  const read = rt.getWorkflowBuilderDraft('sess-3');
  assert.deepEqual(read, second);
  assert.equal(read?.nodes.length, 3);
});

test('19.9 draft store: clearWorkflowBuilderDraft drops the entry', () => {
  const rt = mkRuntime();
  rt.setWorkflowBuilderDraft('sess-4', sampleDraft('wf-4'));
  assert.ok(rt.getWorkflowBuilderDraft('sess-4'));
  rt.clearWorkflowBuilderDraft('sess-4');
  assert.equal(rt.getWorkflowBuilderDraft('sess-4'), undefined);
});

test('19.9 draft store: different sessions are isolated', () => {
  const rt = mkRuntime();
  const a = sampleDraft('wf-a');
  const b = sampleDraft('wf-b');
  rt.setWorkflowBuilderDraft('sess-a', a);
  rt.setWorkflowBuilderDraft('sess-b', b);
  assert.deepEqual(rt.getWorkflowBuilderDraft('sess-a'), a);
  assert.deepEqual(rt.getWorkflowBuilderDraft('sess-b'), b);
  // Clearing one doesn't affect the other.
  rt.clearWorkflowBuilderDraft('sess-a');
  assert.equal(rt.getWorkflowBuilderDraft('sess-a'), undefined);
  assert.deepEqual(rt.getWorkflowBuilderDraft('sess-b'), b);
});

test('19.9 draft store: shutdown clears every workflow-builder draft', () => {
  const rt = mkRuntime();
  rt.setWorkflowBuilderDraft('sess-x', sampleDraft('wf-x'));
  rt.setWorkflowBuilderDraft('sess-y', sampleDraft('wf-y'));
  rt.shutdown();
  assert.equal(rt.getWorkflowBuilderDraft('sess-x'), undefined);
  assert.equal(rt.getWorkflowBuilderDraft('sess-y'), undefined);
});

test('19.9 draft store: workflowBuilderSession is null until startWorkflowBuilder', () => {
  const rt = mkRuntime();
  assert.equal(rt.workflowBuilderSession(), null);
  // We don't call startWorkflowBuilder here (depends on a seeded pod row +
  // real PtySession spawn) — just pin that the getter returns null in the
  // pre-start state. Lifecycle wiring is exercised by Section-25 + the
  // existing agent-designer integration tests.
});
