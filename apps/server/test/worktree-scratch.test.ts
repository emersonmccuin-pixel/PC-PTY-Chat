// Unit tests for the scratch convention helpers on WorktreeService (4a.8 /
// D18): ensureScratchDir, wipeScratchDir, sweepStaleScratch. Filesystem-only
// — no git operations, no DB. Each test uses its own tmp baseDir.
//
// Run via:  pnpm --filter @pc/server test
// Or:       pnpm test:unit  (from repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { WorktreeService, SCRATCH_SWEEP_MAX_AGE_MS } from '../src/services/worktree.ts';

function mkBaseDir(): { workspaceDir: string; baseDir: string } {
  const root = mkdtempSync(resolve(tmpdir(), 'wt-scratch-'));
  return {
    workspaceDir: resolve(root, 'repo'),
    baseDir: resolve(root, 'worktrees'),
  };
}

test('ensureScratchDir: creates scratch/ + .gitignore inside the worktree', () => {
  const { workspaceDir, baseDir } = mkBaseDir();
  const wtPath = resolve(baseDir, 'wt-a');
  mkdirSync(wtPath, { recursive: true });
  const svc = new WorktreeService(workspaceDir, baseDir);
  const scratch = svc.ensureScratchDir(wtPath);
  assert.equal(scratch, resolve(wtPath, 'scratch'));
  assert.ok(existsSync(scratch));
  const gitignore = readFileSync(resolve(scratch, '.gitignore'), 'utf-8');
  assert.match(gitignore, /\*/);
});

test('ensureScratchDir: idempotent (second call no-ops + preserves .gitignore content)', () => {
  const { workspaceDir, baseDir } = mkBaseDir();
  const wtPath = resolve(baseDir, 'wt-a');
  mkdirSync(wtPath, { recursive: true });
  const svc = new WorktreeService(workspaceDir, baseDir);
  svc.ensureScratchDir(wtPath);
  // User edited the .gitignore — second call must NOT overwrite.
  writeFileSync(resolve(wtPath, 'scratch', '.gitignore'), '# my custom rules\n*.tmp\n', 'utf-8');
  svc.ensureScratchDir(wtPath);
  const gitignore = readFileSync(resolve(wtPath, 'scratch', '.gitignore'), 'utf-8');
  assert.match(gitignore, /# my custom rules/);
});

test('wipeScratchDir: removes all entries + re-creates scratch/ with .gitignore', () => {
  const { workspaceDir, baseDir } = mkBaseDir();
  const wtPath = resolve(baseDir, 'wt-a');
  mkdirSync(wtPath, { recursive: true });
  const svc = new WorktreeService(workspaceDir, baseDir);
  svc.ensureScratchDir(wtPath);
  const scratch = resolve(wtPath, 'scratch');
  writeFileSync(resolve(scratch, 'file1.txt'), 'old', 'utf-8');
  writeFileSync(resolve(scratch, 'file2.txt'), 'older', 'utf-8');
  mkdirSync(resolve(scratch, 'subdir'));
  writeFileSync(resolve(scratch, 'subdir', 'inner.txt'), 'x', 'utf-8');

  svc.wipeScratchDir(wtPath);
  assert.ok(existsSync(scratch));
  assert.ok(existsSync(resolve(scratch, '.gitignore')));
  assert.equal(existsSync(resolve(scratch, 'file1.txt')), false);
  assert.equal(existsSync(resolve(scratch, 'subdir')), false);
});

test('sweepStaleScratch: removes top-level entries older than threshold + keeps fresh ones', () => {
  const { workspaceDir, baseDir } = mkBaseDir();
  const wtA = resolve(baseDir, 'wt-a');
  const wtB = resolve(baseDir, 'wt-b');
  mkdirSync(wtA, { recursive: true });
  mkdirSync(wtB, { recursive: true });
  const svc = new WorktreeService(workspaceDir, baseDir);
  svc.ensureScratchDir(wtA);
  svc.ensureScratchDir(wtB);

  const stalePath = resolve(wtA, 'scratch', 'stale.txt');
  const freshPath = resolve(wtA, 'scratch', 'fresh.txt');
  const stalePathB = resolve(wtB, 'scratch', 'stale-b.txt');
  writeFileSync(stalePath, 'old', 'utf-8');
  writeFileSync(freshPath, 'new', 'utf-8');
  writeFileSync(stalePathB, 'old', 'utf-8');

  // Stamp two paths in the past (well beyond the 14-day threshold).
  const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  utimesSync(stalePath, past, past);
  utimesSync(stalePathB, past, past);

  const { removed } = svc.sweepStaleScratch();
  const removedSet = new Set(removed);
  assert.ok(removedSet.has(stalePath), `expected ${stalePath} in ${JSON.stringify(removed)}`);
  assert.ok(removedSet.has(stalePathB));
  assert.equal(removedSet.has(freshPath), false);
  assert.equal(existsSync(stalePath), false);
  assert.equal(existsSync(freshPath), true);
});

test('sweepStaleScratch: skips .gitignore even if stale', () => {
  const { workspaceDir, baseDir } = mkBaseDir();
  const wt = resolve(baseDir, 'wt');
  mkdirSync(wt, { recursive: true });
  const svc = new WorktreeService(workspaceDir, baseDir);
  svc.ensureScratchDir(wt);
  const gitignore = resolve(wt, 'scratch', '.gitignore');
  const past = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  utimesSync(gitignore, past, past);
  svc.sweepStaleScratch();
  assert.equal(existsSync(gitignore), true, '.gitignore must survive sweep');
});

test('sweepStaleScratch: no-ops when baseDir does not exist', () => {
  const { workspaceDir, baseDir } = mkBaseDir();
  // Do NOT create baseDir.
  const svc = new WorktreeService(workspaceDir, baseDir);
  const { removed } = svc.sweepStaleScratch();
  assert.deepEqual(removed, []);
});

test('SCRATCH_SWEEP_MAX_AGE_MS: 14-day threshold as documented', () => {
  assert.equal(SCRATCH_SWEEP_MAX_AGE_MS, 14 * 24 * 60 * 60 * 1000);
});
