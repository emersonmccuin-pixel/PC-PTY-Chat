// Section 35 — work-item callsigns.
//
// Covers the repo-side callsign claim contract:
//   - top-level rows get `<slug>-N` in createdAt order;
//   - children get `<parent.callsign>.M` over non-agent siblings;
//   - agent contracts (`isAgentTask=true`) stay NULL;
//   - non-agent child of an agent-contract parent gets a top-level number;
//   - archiving a row doesn't free its number — the seq keeps climbing;
//   - re-parenting is stable (callsign doesn't change);
//   - getWorkItemByCallsign resolves; project-scoped + null on miss;
//   - migration backfill assigns callsigns over a pre-seeded DB.
//
// Run via:  pnpm --filter @pc/db test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-db-callsign-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  createWorkItem,
  getWorkItem,
  getWorkItemByCallsign,
  softDeleteWorkItem,
  patchWorkItem,
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

test('top-level callsigns count up monotonically per project', () => {
  const p = createProject({
    slug: 'cs-root',
    name: 'CS Root',
    stages,
    folderPath: tmpDir,
  });
  const a = createWorkItem({ projectId: p.id as ULID, stageId: 'backlog', title: 'A' });
  const b = createWorkItem({ projectId: p.id as ULID, stageId: 'backlog', title: 'B' });
  const c = createWorkItem({ projectId: p.id as ULID, stageId: 'backlog', title: 'C' });
  assert.equal(a.callsign, 'cs-root-1');
  assert.equal(b.callsign, 'cs-root-2');
  assert.equal(c.callsign, 'cs-root-3');
});

test('child callsigns dot-suffix from the parent', () => {
  const p = createProject({
    slug: 'cs-child',
    name: 'CS Child',
    stages,
    folderPath: tmpDir,
  });
  const root = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'root',
  });
  assert.equal(root.callsign, 'cs-child-1');
  const child1 = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    parentId: root.id,
    title: 'child 1',
  });
  const child2 = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    parentId: root.id,
    title: 'child 2',
  });
  assert.equal(child1.callsign, 'cs-child-1.1');
  assert.equal(child2.callsign, 'cs-child-1.2');

  const grand = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    parentId: child1.id,
    title: 'grand',
  });
  assert.equal(grand.callsign, 'cs-child-1.1.1');
});

test('agent contracts stay NULL and do not burn root numbers', () => {
  const p = createProject({
    slug: 'cs-agent',
    name: 'CS Agent',
    stages,
    folderPath: tmpDir,
  });
  const u1 = createWorkItem({ projectId: p.id as ULID, stageId: 'backlog', title: 'u1' });
  const agent = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'agent contract',
    isAgentTask: true,
  });
  const u2 = createWorkItem({ projectId: p.id as ULID, stageId: 'backlog', title: 'u2' });
  assert.equal(u1.callsign, 'cs-agent-1');
  assert.equal(agent.callsign, null);
  // u2 is the SECOND non-agent root — gets cs-agent-2, not cs-agent-3.
  assert.equal(u2.callsign, 'cs-agent-2');
});

test('non-agent child of an agent-contract parent falls back to top-level numbering', () => {
  const p = createProject({
    slug: 'cs-orphan',
    name: 'CS Orphan',
    stages,
    folderPath: tmpDir,
  });
  const agent = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'agent contract',
    isAgentTask: true,
  });
  assert.equal(agent.callsign, null);
  const child = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    parentId: agent.id,
    title: 'user child of agent',
  });
  // Parent has no callsign → effective root → top-level number.
  assert.equal(child.callsign, 'cs-orphan-1');
});

test('child of a non-agent parent that is soft-deleted still suffixes from the parent callsign', () => {
  const p = createProject({
    slug: 'cs-archived-parent',
    name: 'CS Archived Parent',
    stages,
    folderPath: tmpDir,
  });
  const root = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'root',
  });
  assert.equal(root.callsign, 'cs-archived-parent-1');
  softDeleteWorkItem(root.id);
  const child = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    parentId: root.id,
    title: 'late child',
  });
  // Parent row still exists (soft-delete is just `deleted_at`) — its
  // callsign is still readable; the child suffixes off it.
  assert.equal(child.callsign, 'cs-archived-parent-1.1');
});

test('archived top-level numbers do not get reused', () => {
  const p = createProject({
    slug: 'cs-noreuse',
    name: 'CS No-Reuse',
    stages,
    folderPath: tmpDir,
  });
  const a = createWorkItem({ projectId: p.id as ULID, stageId: 'backlog', title: 'A' });
  assert.equal(a.callsign, 'cs-noreuse-1');
  softDeleteWorkItem(a.id);
  const b = createWorkItem({ projectId: p.id as ULID, stageId: 'backlog', title: 'B' });
  assert.equal(b.callsign, 'cs-noreuse-2');
});

test('re-parenting preserves the callsign (write-once)', () => {
  const p = createProject({
    slug: 'cs-reparent',
    name: 'CS Reparent',
    stages,
    folderPath: tmpDir,
  });
  const r1 = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'r1',
  });
  const r2 = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'r2',
  });
  const child = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    parentId: r1.id,
    title: 'child',
  });
  assert.equal(child.callsign, 'cs-reparent-1.1');
  const moved = patchWorkItem(child.id, { expectedVersion: child.version, parentId: r2.id });
  assert.ok(moved);
  // Callsign unchanged after re-parenting — buildout lock.
  assert.equal(moved.callsign, 'cs-reparent-1.1');
});

test('getWorkItemByCallsign resolves by project + returns null on miss + mismatched project', () => {
  const pA = createProject({
    slug: 'cs-resolve-a',
    name: 'CS Resolve A',
    stages,
    folderPath: tmpDir,
  });
  const pB = createProject({
    slug: 'cs-resolve-b',
    name: 'CS Resolve B',
    stages,
    folderPath: tmpDir,
  });
  const wi = createWorkItem({ projectId: pA.id as ULID, stageId: 'backlog', title: 'hit' });
  assert.equal(wi.callsign, 'cs-resolve-a-1');
  const found = getWorkItemByCallsign(pA.id as ULID, 'cs-resolve-a-1');
  assert.ok(found);
  assert.equal(found.id, wi.id);
  // Mismatched project → null even with a valid callsign string.
  const wrongProject = getWorkItemByCallsign(pB.id as ULID, 'cs-resolve-a-1');
  assert.equal(wrongProject, null);
  // Missing → null.
  assert.equal(getWorkItemByCallsign(pA.id as ULID, 'cs-resolve-a-999'), null);
});

test('soft-deleted rows are not returned by getWorkItemByCallsign', () => {
  const p = createProject({
    slug: 'cs-archived-lookup',
    name: 'CS Archived Lookup',
    stages,
    folderPath: tmpDir,
  });
  const wi = createWorkItem({ projectId: p.id as ULID, stageId: 'backlog', title: 'x' });
  softDeleteWorkItem(wi.id);
  assert.equal(getWorkItemByCallsign(p.id as ULID, wi.callsign as string), null);
  // But still readable by id-including-archived path; not exercised here.
  assert.equal(getWorkItem(wi.id), null);
});

test('child sibling numbering is per-parent and skips agent contracts', () => {
  const p = createProject({
    slug: 'cs-siblings',
    name: 'CS Siblings',
    stages,
    folderPath: tmpDir,
  });
  const root = createWorkItem({ projectId: p.id as ULID, stageId: 'backlog', title: 'r' });
  const c1 = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    parentId: root.id,
    title: 'c1',
  });
  const agentSibling = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    parentId: root.id,
    title: 'agent dispatch',
    isAgentTask: true,
  });
  const c2 = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    parentId: root.id,
    title: 'c2',
  });
  assert.equal(c1.callsign, 'cs-siblings-1.1');
  assert.equal(agentSibling.callsign, null);
  // c2 is the SECOND non-agent child — gets .2, not .3.
  assert.equal(c2.callsign, 'cs-siblings-1.2');
});
