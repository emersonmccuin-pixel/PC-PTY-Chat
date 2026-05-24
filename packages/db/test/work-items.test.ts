// Round-trip tests for the work-items repo. Pins the shape contract that
// Phase 2a relies on: createWorkItem returns the full v2 domain shape,
// listWorkItems sorts by (position, createdAt), moves bump position +
// version, and the new fields (parentId, position, version, timestamps,
// deletedAt) all surface through toDomain.
//
// Run via:  pnpm --filter @pc/db test
// Or:       pnpm test:unit  (from repo root)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// PC_DATA_DIR is consulted lazily on first getDb() — set before importing.
const tmpDir = mkdtempSync(join(tmpdir(), 'pc-db-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  createWorkItem,
  listWorkItems,
  moveWorkItemStage,
  patchWorkItem,
  softDeleteWorkItem,
  restoreWorkItem,
  getWorkItem,
  getWorkItemIncludingArchived,
  listArchivedWorkItems,
  countWorkItemsInStage,
  reassignStage,
  appendWorkItemHistory,
  WorkItemVersionConflictError,
} = await import('../src/index.ts');
import type { Stage, ULID } from '@pc/domain';

const stages: Stage[] = [
  { id: 'backlog', name: 'Backlog', order: 0 },
  { id: 'doing', name: 'Doing', order: 1 },
];

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('createWorkItem returns full v2 domain shape', () => {
  const p = createProject({
    slug: 'shape-test',
    name: 'Shape Test',
    stages,
    folderPath: tmpDir,
  });
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'first',
  });

  assert.equal(wi.title, 'first');
  assert.equal(wi.projectId, p.id);
  assert.equal(wi.parentId, null);
  assert.equal(wi.position, 0);
  assert.equal(wi.stageId, 'backlog');
  assert.equal(wi.status, 'pending');
  assert.equal(wi.statusReason, null);
  assert.deepEqual(wi.fields, {});
  assert.equal(wi.body, '');
  assert.equal(wi.version, 1);
  assert.equal(wi.deletedAt, null);
  assert.equal(typeof wi.createdAt, 'number');
  assert.equal(typeof wi.updatedAt, 'number');
});

test('listWorkItems orders by position then createdAt', () => {
  const p = createProject({
    slug: 'ordering',
    name: 'Ordering',
    stages,
    folderPath: tmpDir,
  });
  const projectId = p.id as ULID;

  const a = createWorkItem({ projectId, stageId: 'backlog', title: 'A' });
  const b = createWorkItem({ projectId, stageId: 'backlog', title: 'B' });
  const c = createWorkItem({ projectId, stageId: 'backlog', title: 'C' });

  assert.equal(a.position, 0);
  assert.equal(b.position, 1);
  assert.equal(c.position, 2);

  const list = listWorkItems(projectId);
  assert.deepEqual(
    list.map((x) => x.title),
    ['A', 'B', 'C'],
  );
});

test('moveWorkItemStage assigns next-position in target stage + bumps version', () => {
  const p = createProject({
    slug: 'move-test',
    name: 'Move Test',
    stages,
    folderPath: tmpDir,
  });
  const projectId = p.id as ULID;

  const a = createWorkItem({ projectId, stageId: 'backlog', title: 'A' });
  const b = createWorkItem({ projectId, stageId: 'doing', title: 'B' });

  const moved = moveWorkItemStage(a.id, 'doing');
  assert.ok(moved);
  assert.equal(moved.stageId, 'doing');
  assert.equal(moved.version, 2);
  assert.equal(moved.position, 1);
  assert.equal(moved.position > b.position, true);
});

test('moveWorkItemStage defaults status to pending (today behavior preserved)', () => {
  const p = createProject({
    slug: 'move-status-default',
    name: 'Move Status Default',
    stages,
    folderPath: tmpDir,
  });
  const wi = createWorkItem({ projectId: p.id as ULID, stageId: 'backlog', title: 'x' });
  const moved = moveWorkItemStage(wi.id, 'doing');
  assert.ok(moved);
  assert.equal(moved.status, 'pending');
});

test('moveWorkItemStage honours explicit targetStatus (Section 27)', () => {
  const p = createProject({
    slug: 'move-status-explicit',
    name: 'Move Status Explicit',
    stages,
    folderPath: tmpDir,
  });
  const wi = createWorkItem({ projectId: p.id as ULID, stageId: 'backlog', title: 'x' });
  const done = moveWorkItemStage(wi.id, 'doing', 'complete');
  assert.ok(done);
  assert.equal(done.status, 'complete');
  const cancelled = moveWorkItemStage(wi.id, 'backlog', 'cancelled');
  assert.ok(cancelled);
  assert.equal(cancelled.status, 'cancelled');
});

test('moveWorkItemStage notes land on the move history entry', () => {
  const p = createProject({
    slug: 'move-note',
    name: 'Move Note',
    stages,
    folderPath: tmpDir,
  });
  const wi = createWorkItem({ projectId: p.id as ULID, stageId: 'backlog', title: 'x' });
  const moved = moveWorkItemStage(wi.id, 'doing', 'cancelled', 'duplicate of #42');
  assert.ok(moved);
  const lastEntry = moved.history[moved.history.length - 1]!;
  assert.equal(lastEntry.kind, 'move');
  assert.equal(lastEntry.note, 'duplicate of #42');
});

test('createWorkItem honours explicit position', () => {
  const p = createProject({
    slug: 'explicit-pos',
    name: 'Explicit',
    stages,
    folderPath: tmpDir,
  });
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'pinned',
    position: 99,
  });
  assert.equal(wi.position, 99);
});

test('patchWorkItem happy path bumps version + updates fields', () => {
  const p = createProject({
    slug: 'patch-happy',
    name: 'Patch Happy',
    stages,
    folderPath: tmpDir,
  });
  const wi = createWorkItem({ projectId: p.id as ULID, stageId: 'backlog', title: 'orig' });
  const patched = patchWorkItem(wi.id, {
    expectedVersion: wi.version,
    title: 'new title',
    body: 'a body',
    fields: { sev: 'high' },
  });
  assert.ok(patched);
  assert.equal(patched.title, 'new title');
  assert.equal(patched.body, 'a body');
  assert.deepEqual(patched.fields, { sev: 'high' });
  assert.equal(patched.version, wi.version + 1);
});

test('patchWorkItem throws WorkItemVersionConflictError on stale version', () => {
  const p = createProject({
    slug: 'patch-conflict',
    name: 'Patch Conflict',
    stages,
    folderPath: tmpDir,
  });
  const wi = createWorkItem({ projectId: p.id as ULID, stageId: 'backlog', title: 'orig' });
  patchWorkItem(wi.id, { expectedVersion: wi.version, title: 'first edit' });
  assert.throws(
    () => patchWorkItem(wi.id, { expectedVersion: wi.version, title: 'stale edit' }),
    (err) => {
      assert.ok(err instanceof WorkItemVersionConflictError);
      assert.equal(err.expected, wi.version);
      assert.equal(err.actual, wi.version + 1);
      assert.equal(err.current.title, 'first edit');
      return true;
    },
  );
});

test('softDeleteWorkItem hides from listWorkItems, sets archived status', () => {
  const p = createProject({
    slug: 'soft-delete',
    name: 'Soft Delete',
    stages,
    folderPath: tmpDir,
  });
  const projectId = p.id as ULID;
  const a = createWorkItem({ projectId, stageId: 'backlog', title: 'A' });
  createWorkItem({ projectId, stageId: 'backlog', title: 'B' });

  const archived = softDeleteWorkItem(a.id);
  assert.ok(archived);
  assert.equal(archived.status, 'archived');
  assert.equal(typeof archived.deletedAt, 'number');

  const live = listWorkItems(projectId);
  assert.deepEqual(
    live.map((x) => x.title),
    ['B'],
  );

  assert.equal(getWorkItem(a.id), null);
  assert.ok(getWorkItemIncludingArchived(a.id));

  const archivedList = listArchivedWorkItems(projectId);
  assert.equal(archivedList.length, 1);
  assert.equal(archivedList[0].id, a.id);
});

test('restoreWorkItem clears deletedAt + status, returns item to live list', () => {
  const p = createProject({
    slug: 'restore',
    name: 'Restore',
    stages,
    folderPath: tmpDir,
  });
  const projectId = p.id as ULID;
  const wi = createWorkItem({ projectId, stageId: 'backlog', title: 'gone' });
  softDeleteWorkItem(wi.id);

  const restored = restoreWorkItem(wi.id);
  assert.ok(restored);
  assert.equal(restored.deletedAt, null);
  assert.equal(restored.status, 'pending');

  const live = listWorkItems(projectId);
  assert.equal(live.length, 1);
  assert.equal(live[0].id, wi.id);

  // Cannot restore a live item.
  assert.equal(restoreWorkItem(wi.id), null);
});

test('countWorkItemsInStage counts live items only', () => {
  const p = createProject({
    slug: 'stage-count',
    name: 'Stage Count',
    stages,
    folderPath: tmpDir,
  });
  const projectId = p.id as ULID;
  createWorkItem({ projectId, stageId: 'backlog', title: 'A' });
  const b = createWorkItem({ projectId, stageId: 'backlog', title: 'B' });
  createWorkItem({ projectId, stageId: 'doing', title: 'C' });
  softDeleteWorkItem(b.id);
  assert.equal(countWorkItemsInStage(projectId, 'backlog'), 1);
  assert.equal(countWorkItemsInStage(projectId, 'doing'), 1);
});

test('reassignStage bulk-moves live items, renumbers position', () => {
  const p = createProject({
    slug: 'reassign',
    name: 'Reassign',
    stages,
    folderPath: tmpDir,
  });
  const projectId = p.id as ULID;
  createWorkItem({ projectId, stageId: 'doing', title: 'existing-doing' });
  const a = createWorkItem({ projectId, stageId: 'backlog', title: 'A' });
  const b = createWorkItem({ projectId, stageId: 'backlog', title: 'B' });
  const moved = reassignStage(projectId, 'backlog', 'doing');
  assert.equal(moved, 2);

  const inDoing = listWorkItems(projectId).filter((wi) => wi.stageId === 'doing');
  assert.equal(inDoing.length, 3);
  const titles = inDoing.map((wi) => wi.title);
  assert.deepEqual(titles, ['existing-doing', 'A', 'B']);
  assert.equal(countWorkItemsInStage(projectId, 'backlog'), 0);

  // Verify the moved items got fresh positions slotted after existing.
  const aMoved = inDoing.find((wi) => wi.id === a.id);
  const bMoved = inDoing.find((wi) => wi.id === b.id);
  assert.ok(aMoved && bMoved);
  assert.equal(aMoved.position, 1);
  assert.equal(bMoved.position, 2);
});

test('createWorkItem stores body + fields', () => {
  const p = createProject({
    slug: 'body-fields',
    name: 'Body Fields',
    stages,
    folderPath: tmpDir,
  });
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 't',
    body: 'hello world',
    fields: { severity: 'high', count: 3 },
  });
  assert.equal(wi.body, 'hello world');
  assert.deepEqual(wi.fields, { severity: 'high', count: 3 });
});

// Section 16b.7 — agent-comms audit rows land on workItems.history via
// appendWorkItemHistory + surface on the public WorkItem shape.
test('appendWorkItemHistory: append + read-back via getWorkItem', () => {
  const p = createProject({
    slug: 'audit-trail',
    name: 'Audit Trail',
    stages,
    folderPath: tmpDir,
  });
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'parent card',
  });
  assert.deepEqual(wi.history, []);
  const updated = appendWorkItemHistory(wi.id as ULID, {
    ts: new Date().toISOString(),
    kind: 'agent-invoke',
    agentName: 'researcher',
    sessionId: 'sess-1',
    runId: 'run-1',
    invokeMode: 'async',
    note: 'orchestrator dispatched researcher',
  });
  assert.ok(updated);
  assert.equal(updated.history.length, 1);
  assert.equal(updated.history[0]?.kind, 'agent-invoke');
  assert.equal(updated.history[0]?.agentName, 'researcher');
  // Read back through getWorkItem to confirm the new entry lands in the
  // public shape (not stripped by toDomain).
  const reread = getWorkItem(wi.id as ULID);
  assert.ok(reread);
  assert.equal(reread.history.length, 1);
  assert.equal(reread.history[0]?.runId, 'run-1');
  // Version intentionally NOT bumped — audit rows must not collide with
  // user-edit optimistic-concurrency checks.
  assert.equal(reread.version, wi.version);
});

test('appendWorkItemHistory: NOOP returns null for unknown id', () => {
  const result = appendWorkItemHistory('does-not-exist' as ULID, {
    ts: new Date().toISOString(),
    kind: 'agent-answer',
    pendingAskId: 'ask-1',
    answeredBy: 'orchestrator',
    note: 'answered "ship it"',
  });
  assert.equal(result, null);
});

// Section 26 — work-item-as-contract field round-trips. Plain work items
// default the contract fields to null/false; agent work items round-trip the
// full contract through createWorkItem → getWorkItem.

test('createWorkItem: plain work item defaults contract fields to null/false', () => {
  const p = createProject({
    slug: 'contract-default',
    name: 'Contract Default',
    stages,
    folderPath: tmpDir,
  });
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'plain task',
  });
  assert.equal(wi.isAgentTask, false);
  assert.equal(wi.ephemeral, false);
  assert.equal(wi.acceptanceCriteria, null);
  assert.equal(wi.expectedOutput, null);
  assert.equal(wi.verificationTier, null);
  assert.equal(wi.verificationStatus, null);
  assert.equal(wi.verificationNotes, null);
  assert.equal(wi.assignedAgentRunId, null);
  assert.equal(wi.worktreePath, null);
});

test('createWorkItem: agent work item round-trips contract fields', () => {
  const p = createProject({
    slug: 'contract-agent',
    name: 'Contract Agent',
    stages,
    folderPath: tmpDir,
  });
  const projectId = p.id as ULID;
  const wi = createWorkItem({
    projectId,
    stageId: 'backlog',
    title: 'researcher dispatch',
    body: 'Find three CSV parsing libs for Node.',
    isAgentTask: true,
    ephemeral: true,
    expectedOutput: { kind: 'text', sections: ['summary'] },
    acceptanceCriteria: [
      { kind: 'fields_populated', keys: ['summary'] },
      { kind: 'body_contains', pattern: 'csv' },
    ],
    verificationTier: 'auto',
    verificationStatus: null,
    assignedAgentRunId: '01JBOGUS-RUN-ID' as ULID,
    worktreePath: '/tmp/worktree-x',
  });

  // Read back via getWorkItem to confirm the values survived the JSON
  // round-trip + camelCase mapping.
  const reread = getWorkItem(wi.id);
  assert.ok(reread);
  assert.equal(reread.isAgentTask, true);
  assert.equal(reread.ephemeral, true);
  assert.equal(reread.verificationTier, 'auto');
  assert.equal(reread.verificationStatus, null);
  assert.equal(reread.assignedAgentRunId, '01JBOGUS-RUN-ID');
  assert.equal(reread.worktreePath, '/tmp/worktree-x');
  assert.deepEqual(reread.expectedOutput, { kind: 'text', sections: ['summary'] });
  assert.ok(reread.acceptanceCriteria);
  assert.equal(reread.acceptanceCriteria.length, 2);
  assert.equal(reread.acceptanceCriteria[0]?.kind, 'fields_populated');
  assert.equal(reread.acceptanceCriteria[1]?.kind, 'body_contains');
});

test('createWorkItem: mixed expected_output round-trips through JSON column', () => {
  const p = createProject({
    slug: 'contract-mixed',
    name: 'Contract Mixed',
    stages,
    folderPath: tmpDir,
  });
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'code-writer dispatch',
    isAgentTask: true,
    expectedOutput: {
      kind: 'mixed',
      files: { paths: ['src/foo.ts'], min_size_bytes: 10 },
      text: { sections: ['summary'] },
    },
    acceptanceCriteria: [
      { kind: 'files_exist', paths: ['src/foo.ts'], min_size_bytes: 10 },
      { kind: 'fields_populated', keys: ['summary'] },
    ],
    verificationTier: 'auto',
  });
  const reread = getWorkItem(wi.id);
  assert.ok(reread);
  assert.equal(reread.expectedOutput?.kind, 'mixed');
  assert.ok(reread.expectedOutput && reread.expectedOutput.kind === 'mixed');
  assert.deepEqual(reread.expectedOutput.files, {
    paths: ['src/foo.ts'],
    min_size_bytes: 10,
  });
  assert.equal(reread.acceptanceCriteria?.[0]?.kind, 'files_exist');
});

test('listWorkItems: surfaces contract fields on every row', () => {
  const p = createProject({
    slug: 'contract-list',
    name: 'Contract List',
    stages,
    folderPath: tmpDir,
  });
  const projectId = p.id as ULID;
  createWorkItem({ projectId, stageId: 'backlog', title: 'plain' });
  createWorkItem({
    projectId,
    stageId: 'backlog',
    title: 'agent',
    isAgentTask: true,
    verificationTier: 'orchestrator-review',
  });
  const list = listWorkItems(projectId);
  const plain = list.find((wi) => wi.title === 'plain');
  const agent = list.find((wi) => wi.title === 'agent');
  assert.ok(plain && agent);
  assert.equal(plain.isAgentTask, false);
  assert.equal(plain.verificationTier, null);
  assert.equal(agent.isAgentTask, true);
  assert.equal(agent.verificationTier, 'orchestrator-review');
});
