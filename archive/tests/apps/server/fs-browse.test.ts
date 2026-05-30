import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { BrowseError, browseFolder, createChildFolder } from '../src/services/fs-browse.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'pc-fs-browse-'));

function fixtureFolder(name: string): string {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function assertBrowseError(fn: () => unknown, kind: BrowseError['kind']) {
  assert.throws(fn, (err) => err instanceof BrowseError && err.kind === kind);
}

test('fs-browse: createChildFolder creates a direct child and opens it', () => {
  const root = fixtureFolder('create-child');
  const result = createChildFolder(root, 'New Project', { roots: [root] });

  assert.equal(result.path, resolve(root, 'New Project'));
  assert.equal(existsSync(result.path), true);
  assert.deepEqual(result.entries, []);

  const rootView = browseFolder(root, { roots: [root] });
  assert.equal(
    rootView.entries.some((entry) => entry.name === 'New Project' && entry.isDirectory),
    true,
  );
});

test('fs-browse: createChildFolder rejects traversal names', () => {
  const root = fixtureFolder('reject-traversal');

  assertBrowseError(() => createChildFolder(root, '..', { roots: [root] }), 'invalid');
  assertBrowseError(() => createChildFolder(root, 'a/b', { roots: [root] }), 'invalid');
  assertBrowseError(() => createChildFolder(root, 'a\\b', { roots: [root] }), 'invalid');
});

test('fs-browse: createChildFolder enforces the browse gate', () => {
  const root = fixtureFolder('gate-root');
  const sibling = fixtureFolder('gate-root-sibling');

  assertBrowseError(
    () => createChildFolder(sibling, 'Nope', { roots: [root] }),
    'forbidden',
  );
});

test('fs-browse: createChildFolder rejects existing paths', () => {
  const root = fixtureFolder('existing-path');
  mkdirSync(resolve(root, 'Already Here'));

  assertBrowseError(
    () => createChildFolder(root, 'Already Here', { roots: [root] }),
    'already_exists',
  );
});

process.on('beforeExit', () => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
