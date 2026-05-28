import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import type { ULID } from '@pc/domain';

import { registerFileRoutes } from '../src/features/files/routes.ts';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-file-routes-'));
const projectId = '01HWFILESROUTES00000000000' as ULID;

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeHarness(folderPath: string | null) {
  const app = new Hono();
  registerFileRoutes(app, {
    projectFolderPath: (id) => (id === projectId ? folderPath : null),
  });
  return { app };
}

async function json<T>(res: Response): Promise<T> {
  return await res.json() as T;
}

test('filesystem browse, mkdir, drives, and probe routes preserve envelopes', async () => {
  const root = join(tmpDir, 'browse-root');
  mkdirSync(join(root, 'child-dir'), { recursive: true });
  writeFileSync(join(root, 'alpha.txt'), 'alpha', 'utf8');
  const { app } = makeHarness(null);

  let res = await app.request(`/api/fs/browse?${new URLSearchParams({ path: root })}`);
  const browse = await json<{
    ok: boolean;
    path: string;
    parent: string | null;
    entries: Array<{ name: string; isDirectory: boolean }>;
  }>(res);
  assert.equal(res.status, 200);
  assert.equal(browse.ok, true);
  assert.equal(browse.path, root);
  assert.equal(browse.entries.some((entry) => entry.name === 'child-dir' && entry.isDirectory), true);

  res = await app.request('/api/fs/drives');
  const drives = await json<{ ok: boolean; drives: string[] }>(res);
  assert.equal(res.status, 200);
  assert.equal(drives.ok, true);
  assert.equal(Array.isArray(drives.drives), true);

  res = await app.request('/api/fs/mkdir', {
    method: 'POST',
    body: JSON.stringify({ parentPath: root, name: 'created', gateRoot: root }),
    headers: { 'content-type': 'application/json' },
  });
  const mkdir = await json<{ ok: boolean; path: string }>(res);
  assert.equal(res.status, 200);
  assert.equal(mkdir.ok, true);
  assert.equal(mkdir.path, join(root, 'created'));

  res = await app.request('/api/fs/probe', {
    method: 'POST',
    body: JSON.stringify({ path: root }),
    headers: { 'content-type': 'application/json' },
  });
  const probe = await json<{
    ok: boolean;
    probe: { path: string; exists: boolean; isDirectory: boolean; hasFiles: boolean };
  }>(res);
  assert.equal(res.status, 200);
  assert.deepEqual(probe.probe, {
    path: root,
    exists: true,
    isDirectory: true,
    hasFiles: true,
    fileCount: 3,
    isGitRepo: false,
    hasPcScaffold: false,
    hasMcpJson: false,
  });
});

test('filesystem routes keep validation and browse error response shapes', async () => {
  const root = join(tmpDir, 'gate-root');
  const outside = join(tmpDir, 'outside-root');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const { app } = makeHarness(null);

  let res = await app.request('/api/fs/mkdir', {
    method: 'POST',
    body: JSON.stringify({ parentPath: '', name: 'created' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), { ok: false, error: 'parentPath required' });

  res = await app.request(
    `/api/fs/browse?${new URLSearchParams({ path: outside, gateRoot: root })}`,
  );
  const browse = await json<{ ok: boolean; error: string; kind: string }>(res);
  assert.equal(res.status, 403);
  assert.equal(browse.ok, false);
  assert.equal(browse.kind, 'forbidden');
  assert.match(browse.error, /^path not inside the allowed root/);

  res = await app.request('/api/fs/probe', {
    method: 'POST',
    body: JSON.stringify({ path: '' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), { ok: false, error: 'path required' });
});

test('project file tree and preview routes preserve project error handling', async () => {
  const root = join(tmpDir, 'project-root');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'ignored'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'ignored.txt\n', 'utf8');
  writeFileSync(join(root, 'README.md'), '# Readme\n', 'utf8');
  writeFileSync(join(root, 'ignored.txt'), 'hidden by gitignore', 'utf8');
  writeFileSync(join(root, 'src', 'note.txt'), 'hello', 'utf8');
  writeFileSync(join(root, 'node_modules', 'ignored', 'package.json'), '{}', 'utf8');
  const { app } = makeHarness(root);

  let res = await app.request(`/api/projects/${projectId}/files/tree`);
  const tree = await json<{
    ok: boolean;
    tree: Array<{ name: string; kind: string; children?: Array<{ name: string }> }>;
  }>(res);
  assert.equal(res.status, 200);
  assert.equal(tree.ok, true);
  assert.equal(tree.tree.some((node) => node.name === 'README.md'), true);
  assert.equal(tree.tree.some((node) => node.name === 'ignored.txt'), false);
  assert.equal(tree.tree.some((node) => node.name === 'node_modules'), false);

  res = await app.request(
    `/api/projects/${projectId}/files/preview?${new URLSearchParams({ path: 'README.md' })}`,
  );
  const preview = await json<{
    ok: boolean;
    preview: { kind: string; content: string; byteSize: number };
  }>(res);
  assert.equal(res.status, 200);
  assert.deepEqual(preview, {
    ok: true,
    preview: { kind: 'markdown', content: '# Readme\n', byteSize: 9 },
  });

  res = await app.request(`/api/projects/${projectId}/files/preview`);
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), { ok: false, error: 'path query param is required' });

  res = await app.request(
    `/api/projects/${projectId}/files/preview?${new URLSearchParams({ path: '../escape.txt' })}`,
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), {
    ok: false,
    error: 'path escapes project root: ../escape.txt',
  });

  res = await app.request(
    `/api/projects/${projectId}/files/preview?${new URLSearchParams({ path: 'missing.txt' })}`,
  );
  assert.equal(res.status, 404);
  assert.deepEqual(await json(res), { ok: false, error: 'file not found: missing.txt' });

  res = await app.request('/api/projects/missing/files/tree');
  assert.equal(res.status, 404);
  assert.deepEqual(await json(res), { ok: false, error: 'unknown project: missing' });
});
