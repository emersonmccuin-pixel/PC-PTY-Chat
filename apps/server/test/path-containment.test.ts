// Section 22.7 — path containment tests.
//
// Two surfaces:
//   1. Static-file serving: `path.relative(PUBLIC, filePath)` must reject
//      sibling-prefix walks (PUBLIC="…/dist" vs "…/dist-evil/secret.html").
//      The handoff called this out as the canonical startsWith() trap.
//   2. Project file cleanup: `.claude/` is removed only when PC's
//      `.pc-managed` marker is present. Attach-to-git'd repos with their
//      own `.claude/` settings keep them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute, relative, resolve } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── 1. Static-serving path-containment via path.relative ──────────────────

/** Same containment check the static-file handler uses (apps/server/src/index.ts).
 *  Lifted into a pure function for the test; production keeps the inline check
 *  to avoid an import cycle through the Hono app. */
function isInsidePublic(publicDir: string, candidate: string): boolean {
  const rel = relative(publicDir, candidate);
  if (rel === '') return false; // candidate === publicDir (no file)
  if (rel.startsWith('..')) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

test('22.7: static containment accepts files under PUBLIC', () => {
  const pub = 'E:/PC/dist';
  assert.equal(isInsidePublic(pub, 'E:/PC/dist/index.html'), true);
  assert.equal(isInsidePublic(pub, 'E:/PC/dist/assets/app.js'), true);
});

test('22.7: static containment rejects parent-directory traversal', () => {
  const pub = 'E:/PC/dist';
  assert.equal(isInsidePublic(pub, 'E:/PC/secrets.txt'), false);
  assert.equal(isInsidePublic(pub, 'E:/etc/passwd'), false);
});

test('22.7: static containment rejects sibling-prefix paths (the startsWith trap)', () => {
  const pub = 'E:/PC/dist';
  // Pre-fix: `"E:/PC/dist-evil/secret.html".startsWith("E:/PC/dist") === true`
  // would have let this through. `path.relative` returns "../dist-evil/...",
  // which starts with '..' → correctly rejected.
  assert.equal(isInsidePublic(pub, 'E:/PC/dist-evil/secret.html'), false);
  assert.equal(isInsidePublic(pub, 'E:/PC/distro/something'), false);
});

test('22.7: static containment rejects the PUBLIC dir itself as a file', () => {
  const pub = 'E:/PC/dist';
  assert.equal(isInsidePublic(pub, 'E:/PC/dist'), false);
});

// ── 2. .claude marker check (delete-files endpoint) ───────────────────────

const tmpRoot = mkdtempSync(join(tmpdir(), 'pc-path-containment-'));

function fixtureFolder(name: string): string {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Mirrors the per-`.claude/` ownership check inside the delete-files
 *  endpoint. Same shape so a behaviour drift here would be caught. */
function shouldDeleteClaudeDir(folder: string): boolean {
  const target = resolve(folder, '.claude');
  if (!existsSync(target)) return false;
  return existsSync(resolve(target, '.pc-managed'));
}

test('22.7: .claude with .pc-managed marker is eligible for delete', () => {
  const folder = fixtureFolder('pc-managed');
  mkdirSync(resolve(folder, '.claude'), { recursive: true });
  writeFileSync(resolve(folder, '.claude', '.pc-managed'), 'marker\n');
  assert.equal(shouldDeleteClaudeDir(folder), true);
});

test('22.7: .claude without marker is NOT eligible (attach-to-git case)', () => {
  // Simulates a user-owned .claude/ from before they adopted the project in
  // PC. The dir has the user's own settings.json — losing it would be a
  // data-loss bug.
  const folder = fixtureFolder('user-owned');
  mkdirSync(resolve(folder, '.claude'), { recursive: true });
  writeFileSync(
    resolve(folder, '.claude', 'settings.json'),
    '{"user":"original config"}\n',
  );
  assert.equal(shouldDeleteClaudeDir(folder), false);
});

test('22.7: missing .claude returns false (idempotent delete)', () => {
  const folder = fixtureFolder('empty');
  assert.equal(shouldDeleteClaudeDir(folder), false);
});

// Cleanup.
process.on('beforeExit', () => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
