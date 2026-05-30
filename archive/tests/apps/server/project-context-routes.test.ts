import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Hono } from 'hono';
import type { ULID } from '@pc/domain';
import type { CustomCommand } from '../src/services/custom-commands.ts';
import type { MemoryFile, MemoryScope } from '../src/services/memory-files.ts';

import { registerProjectContextRoutes } from '../src/features/project-context/routes.ts';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-project-context-routes-'));

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function json<T>(res: Response): Promise<T> {
  return await res.json() as T;
}

function makeHarness() {
  const folderPath = join(tmpDir, `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(folderPath, { recursive: true });
  const commandsCalls: string[] = [];
  const memoryReads: Array<{ scope: MemoryScope; folderPath: string }> = [];
  const memoryWrites: Array<{ scope: MemoryScope; folderPath: string; content: string }> = [];
  const broadcasts: Array<{ projectId: ULID; msg: unknown }> = [];
  const commands: CustomCommand[] = [{ name: 'build', body: 'pnpm build', scope: 'project' }];
  const app = new Hono();

  registerProjectContextRoutes(app, {
    resolveProject: (projectId) => (projectId === 'known' ? { folderPath } : null),
    getProjectFolderPath: (projectId) => (projectId === 'known' ? folderPath : null),
    broadcastTo: (projectId, msg) => broadcasts.push({ projectId, msg }),
    listCustomCommands: (projectFolder) => {
      commandsCalls.push(projectFolder);
      return commands;
    },
    readMemoryFile: (scope, projectFolder): MemoryFile => {
      memoryReads.push({ scope, folderPath: projectFolder });
      return {
        scope,
        path: resolve(projectFolder, `${scope}-CLAUDE.md`),
        content: `${scope} content`,
        exists: true,
      };
    },
    writeMemoryFile: (scope, projectFolder, content): MemoryFile => {
      memoryWrites.push({ scope, folderPath: projectFolder, content });
      return {
        scope,
        path: resolve(projectFolder, `${scope}-CLAUDE.md`),
        content,
        exists: true,
      };
    },
  });

  return {
    app,
    folderPath,
    commands,
    commandsCalls,
    memoryReads,
    memoryWrites,
    broadcasts,
  };
}

test('custom commands route preserves success and unknown-project envelopes', async () => {
  const { app, folderPath, commands, commandsCalls } = makeHarness();

  let res = await app.request('/api/projects/known/commands');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, commands });
  assert.deepEqual(commandsCalls, [folderPath]);

  res = await app.request('/api/projects/missing/commands');
  assert.equal(res.status, 404);
  assert.deepEqual(await json(res), { ok: false, error: 'unknown project: missing' });
});

test('memory routes preserve scope validation, unknown-project, read, and write envelopes', async () => {
  const { app, folderPath, memoryReads, memoryWrites } = makeHarness();

  let res = await app.request('/api/projects/missing/memory/bad');
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), { ok: false, error: 'invalid scope: bad' });

  res = await app.request('/api/projects/missing/memory/project');
  assert.equal(res.status, 404);
  assert.deepEqual(await json(res), { ok: false, error: 'unknown project: missing' });

  res = await app.request('/api/projects/known/memory/workspace');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), {
    ok: true,
    file: {
      scope: 'workspace',
      path: resolve(folderPath, 'workspace-CLAUDE.md'),
      content: 'workspace content',
      exists: true,
    },
  });
  assert.deepEqual(memoryReads, [{ scope: 'workspace', folderPath }]);

  res = await app.request('/api/projects/known/memory/project', {
    method: 'PUT',
    body: JSON.stringify({}),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), { ok: false, error: 'content required' });

  res = await app.request('/api/projects/known/memory/project', {
    method: 'PUT',
    body: JSON.stringify({ content: 'new content' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), {
    ok: true,
    file: {
      scope: 'project',
      path: resolve(folderPath, 'project-CLAUDE.md'),
      content: 'new content',
      exists: true,
    },
  });
  assert.deepEqual(memoryWrites, [{ scope: 'project', folderPath, content: 'new content' }]);
});

test('claude-md routes preserve status, validation, write, and broadcast envelopes', async () => {
  const { app, folderPath, broadcasts } = makeHarness();
  const claudeMdPath = resolve(folderPath, 'CLAUDE.md');

  let res = await app.request('/api/projects/missing/claude-md-status');
  assert.equal(res.status, 404);
  assert.deepEqual(await json(res), { ok: false, error: 'unknown project: missing' });

  res = await app.request('/api/projects/known/claude-md-status');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, exists: false, empty: true });

  writeFileSync(claudeMdPath, '   \n', 'utf-8');
  res = await app.request('/api/projects/known/claude-md-status');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, exists: true, empty: true });

  res = await app.request('/api/projects/known/claude-md', {
    method: 'PUT',
    body: JSON.stringify({ content: '   ' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), { ok: false, error: 'content required (non-empty)' });

  res = await app.request('/api/projects/known/claude-md', {
    method: 'PUT',
    body: JSON.stringify({ content: '# Project Memory\n' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true });
  assert.equal(readFileSync(claudeMdPath, 'utf-8'), '# Project Memory\n');
  assert.deepEqual(broadcasts, [
    { projectId: 'known' as ULID, msg: { type: 'project-claude-md-changed' } },
  ]);

  res = await app.request('/api/projects/known/claude-md-status');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, exists: true, empty: false });
});
