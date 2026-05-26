// Section 18.8 unit tests — JSONL retention sweep.
//
// Exercises the pure file-walking logic against a temp dir mimicking CC's
// `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` layout. No real CC
// or HTTP. Deterministic via the `now` + explicit `utimesSync` mtimes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sweepStaleJsonl } from '../src/services/jsonl-sweep.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function setMtime(filePath: string, ms: number): void {
  const seconds = ms / 1000;
  utimesSync(filePath, seconds, seconds);
}

function makeProjectTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-jsonl-sweep-'));
  return root;
}

test('retention="never" → no-op, returns zeros even when stale files exist', async () => {
  const root = makeProjectTree();
  try {
    const projectDir = join(root, '-c-Users-test-foo');
    mkdirSync(projectDir, { recursive: true });
    const f = join(projectDir, 'aaaa.jsonl');
    writeFileSync(f, '{"x":1}\n');
    setMtime(f, Date.now() - 365 * DAY_MS);

    const result = await sweepStaleJsonl({
      rootDir: root,
      retention: 'never',
      now: Date.now(),
    });
    assert.deepEqual(result, { scanned: 0, deleted: 0, skipped: 0, bytesFreed: 0 });
    assert.equal(existsSync(f), true, 'never opt-out must not delete anything');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing root dir → no-op, returns zeros (fresh install)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-jsonl-sweep-missing-'));
  // Delete the dir so we can verify the "ENOENT" handling.
  rmSync(root, { recursive: true, force: true });
  const result = await sweepStaleJsonl({
    rootDir: root,
    retention: 30,
    now: Date.now(),
  });
  assert.deepEqual(result, { scanned: 0, deleted: 0, skipped: 0, bytesFreed: 0 });
});

test('deletes stale .jsonl files, keeps fresh ones (mtime-based)', async () => {
  const root = makeProjectTree();
  try {
    const now = Date.now();
    const projA = join(root, '-c-Users-test-projA');
    const projB = join(root, '-c-Users-test-projB');
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });

    const old1 = join(projA, 'old1.jsonl');
    const old2 = join(projB, 'old2.jsonl');
    const fresh1 = join(projA, 'fresh1.jsonl');
    const fresh2 = join(projB, 'fresh2.jsonl');

    writeFileSync(old1, 'old1\n');
    writeFileSync(old2, 'old2\n');
    writeFileSync(fresh1, 'fresh1\n');
    writeFileSync(fresh2, 'fresh2\n');

    // Stale = > 30 days old. Fresh = 1 day old.
    setMtime(old1, now - 60 * DAY_MS);
    setMtime(old2, now - 31 * DAY_MS);
    setMtime(fresh1, now - 1 * DAY_MS);
    setMtime(fresh2, now - 1 * DAY_MS);

    const result = await sweepStaleJsonl({ rootDir: root, retention: 30, now });
    assert.equal(result.scanned, 4);
    assert.equal(result.deleted, 2);
    assert.equal(result.skipped, 0);
    assert.ok(result.bytesFreed > 0);

    assert.equal(existsSync(old1), false);
    assert.equal(existsSync(old2), false);
    assert.equal(existsSync(fresh1), true);
    assert.equal(existsSync(fresh2), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cutoff boundary: file with mtime == cutoff is kept (>= cutoff)', async () => {
  const root = makeProjectTree();
  try {
    const now = Date.UTC(2026, 0, 31, 0, 0, 0);
    const proj = join(root, '-c-Users-test-edge');
    mkdirSync(proj, { recursive: true });

    const exactlyAtCutoff = join(proj, 'edge.jsonl');
    const justBeforeCutoff = join(proj, 'older.jsonl');
    writeFileSync(exactlyAtCutoff, 'x\n');
    writeFileSync(justBeforeCutoff, 'y\n');

    const cutoffMs = now - 30 * DAY_MS;
    setMtime(exactlyAtCutoff, cutoffMs);
    setMtime(justBeforeCutoff, cutoffMs - 1000);

    const result = await sweepStaleJsonl({ rootDir: root, retention: 30, now });
    assert.equal(result.deleted, 1, 'only the strictly-older one is deleted');
    assert.equal(existsSync(exactlyAtCutoff), true, 'mtime == cutoff is NOT stale');
    assert.equal(existsSync(justBeforeCutoff), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-.jsonl files in project dirs are preserved', async () => {
  const root = makeProjectTree();
  try {
    const now = Date.now();
    const proj = join(root, '-c-Users-test-mix');
    mkdirSync(proj, { recursive: true });

    const stale = join(proj, 'stale.jsonl');
    const settings = join(proj, 'settings.json');
    const notes = join(proj, 'notes.txt');

    writeFileSync(stale, 'x\n');
    writeFileSync(settings, '{}\n');
    writeFileSync(notes, 'hi\n');

    setMtime(stale, now - 60 * DAY_MS);
    setMtime(settings, now - 60 * DAY_MS);
    setMtime(notes, now - 60 * DAY_MS);

    const result = await sweepStaleJsonl({ rootDir: root, retention: 30, now });
    assert.equal(result.scanned, 1, 'only .jsonl files are scanned');
    assert.equal(result.deleted, 1);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(settings), true, '.json must NOT be touched');
    assert.equal(existsSync(notes), true, '.txt must NOT be touched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-directory entries at root level are skipped (not crashed)', async () => {
  const root = makeProjectTree();
  try {
    // CC has been known to leave stray files at the projects/ root.
    writeFileSync(join(root, 'orphan.txt'), 'noise\n');
    const proj = join(root, '-c-Users-test-skip');
    mkdirSync(proj, { recursive: true });
    const stale = join(proj, 'stale.jsonl');
    writeFileSync(stale, 'x\n');
    setMtime(stale, Date.now() - 60 * DAY_MS);

    const result = await sweepStaleJsonl({ rootDir: root, retention: 30 });
    assert.equal(result.scanned, 1);
    assert.equal(result.deleted, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('empty project subdirectories are walked without error', async () => {
  const root = makeProjectTree();
  try {
    mkdirSync(join(root, '-c-Users-test-empty'), { recursive: true });
    const result = await sweepStaleJsonl({
      rootDir: root,
      retention: 30,
      now: Date.now(),
    });
    assert.deepEqual(result, { scanned: 0, deleted: 0, skipped: 0, bytesFreed: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retention=1 day works end-to-end (smoke for short windows)', async () => {
  const root = makeProjectTree();
  try {
    const now = Date.now();
    const proj = join(root, '-c-Users-test-short');
    mkdirSync(proj, { recursive: true });
    const oneDayOld = join(proj, 'a.jsonl');
    const halfDayOld = join(proj, 'b.jsonl');
    writeFileSync(oneDayOld, 'a\n');
    writeFileSync(halfDayOld, 'b\n');
    setMtime(oneDayOld, now - 2 * DAY_MS);
    setMtime(halfDayOld, now - 0.5 * DAY_MS);

    const result = await sweepStaleJsonl({ rootDir: root, retention: 1, now });
    assert.equal(result.deleted, 1);
    assert.equal(existsSync(oneDayOld), false);
    assert.equal(existsSync(halfDayOld), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
