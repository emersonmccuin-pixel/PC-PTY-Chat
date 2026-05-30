// Section 35 — resolveWorkItemRef + looksLikeUlid.
//
// Exercises the modal-opener route's discriminant: a ref is either a
// 26-char Crockford ULID or a callsign string. Project-scoping is
// enforced — a ULID lookup that hits a row in a different project
// returns null so the route reports 404 (same as a miss).
//
// Run via:  pnpm --filter @pc/server test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-resolver-'));
process.env.PC_DATA_DIR = tmpDir;

import type { Stage, ULID } from '@pc/domain';

const {
  closeDb,
  runMigrations,
  createProject,
  createWorkItem,
} = await import('@pc/db');

const { looksLikeUlid, resolveWorkItemRef } = await import(
  '../src/services/work-item.ts'
);

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('looksLikeUlid: 26-char Crockford passes; callsigns fail', () => {
  // Real ULID shape — 26 chars, no I/L/O/U.
  assert.equal(looksLikeUlid('01KS1358GYAQFG8BW9ERSB2J7C'), true);
  // Callsigns: contain `-`, not 26 chars, may contain digits + dots.
  assert.equal(looksLikeUlid('pc-2'), false);
  assert.equal(looksLikeUlid('pc-2.1'), false);
  assert.equal(looksLikeUlid('pc-2.1.3'), false);
  // 26-char string with disallowed letters → fail.
  assert.equal(looksLikeUlid('I'.repeat(26)), false);
  // Wrong length → fail.
  assert.equal(looksLikeUlid('01KS1358GYAQFG8BW9ERSB2J7'), false);
});

test('resolveWorkItemRef: ULID lookup', () => {
  const p = createProject({
    slug: 'rr',
    name: 'RR',
    stages,
    folderPath: tmpDir,
  });
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'a',
  });
  const found = resolveWorkItemRef(p.id as ULID, wi.id);
  assert.ok(found);
  assert.equal(found.id, wi.id);
  assert.equal(found.callsign, 'rr-1');
});

test('resolveWorkItemRef: callsign lookup', () => {
  const p = createProject({
    slug: 'rr2',
    name: 'RR2',
    stages,
    folderPath: tmpDir,
  });
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'a',
  });
  assert.equal(wi.callsign, 'rr2-1');
  const found = resolveWorkItemRef(p.id as ULID, 'rr2-1');
  assert.ok(found);
  assert.equal(found.id, wi.id);
});

test('resolveWorkItemRef: mismatched-project callsign returns null', () => {
  const pA = createProject({
    slug: 'rr-a',
    name: 'RR A',
    stages,
    folderPath: tmpDir,
  });
  const pB = createProject({
    slug: 'rr-b',
    name: 'RR B',
    stages,
    folderPath: tmpDir,
  });
  createWorkItem({ projectId: pA.id as ULID, stageId: 'backlog', title: 'in A' });
  // Project B asks for project A's callsign — should miss.
  assert.equal(resolveWorkItemRef(pB.id as ULID, 'rr-a-1'), null);
});

test('resolveWorkItemRef: ULID lookup is project-scoped (cross-project ULID returns null)', () => {
  const pA = createProject({
    slug: 'rrx-a',
    name: 'RRX A',
    stages,
    folderPath: tmpDir,
  });
  const pB = createProject({
    slug: 'rrx-b',
    name: 'RRX B',
    stages,
    folderPath: tmpDir,
  });
  const wiA = createWorkItem({
    projectId: pA.id as ULID,
    stageId: 'backlog',
    title: 'in A',
  });
  // Project B asks for a row owned by project A — null, not a leak.
  assert.equal(resolveWorkItemRef(pB.id as ULID, wiA.id), null);
});

test('resolveWorkItemRef: unknown ref returns null (both shapes)', () => {
  const p = createProject({
    slug: 'rr-miss',
    name: 'RR Miss',
    stages,
    folderPath: tmpDir,
  });
  // Made-up ULID.
  assert.equal(resolveWorkItemRef(p.id as ULID, '01ZZZZZZZZZZZZZZZZZZZZZZZZ'), null);
  // Made-up callsign.
  assert.equal(resolveWorkItemRef(p.id as ULID, 'rr-miss-999'), null);
});

test('resolveWorkItemRef: empty / whitespace ref returns null', () => {
  const p = createProject({
    slug: 'rr-empty',
    name: 'RR Empty',
    stages,
    folderPath: tmpDir,
  });
  assert.equal(resolveWorkItemRef(p.id as ULID, ''), null);
  assert.equal(resolveWorkItemRef(p.id as ULID, '   '), null);
});
