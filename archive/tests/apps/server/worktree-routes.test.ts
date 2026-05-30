import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Hono } from 'hono';
import type { ULID } from '@pc/domain';
import type { WorktreeEntry } from '@pc/runtime';

import {
  registerWorktreeRoutes,
  type WorktreeRegistry,
  type WorktreeRouteService,
} from '../src/features/project-worktrees/routes.ts';

async function json<T>(res: Response): Promise<T> {
  return await res.json() as T;
}

function makeHarness(servicePatch: Partial<WorktreeRouteService> = {}) {
  const registry: WorktreeRegistry = {
    updatedAt: '2026-05-27T00:00:00.000Z',
    worktrees: [{ path: 'E:/repo', branch: 'main', head: 'abc123' }],
  };
  const createdNames: string[] = [];
  const destroyedTargets: Array<{ target: string; force?: boolean }> = [];
  const entry: WorktreeEntry = { path: 'E:/worktrees/feature-a', branch: 'feature-a', head: 'def456' };
  const service: WorktreeRouteService = {
    readCached: () => registry,
    create: async (name) => {
      createdNames.push(name);
      return entry;
    },
    destroy: async (target, force) => {
      destroyedTargets.push({ target, force });
    },
    ...servicePatch,
  };
  const app = new Hono();
  registerWorktreeRoutes(app, {
    resolveProject: (projectId) =>
      projectId === 'known'
        ? {
            project: { id: 'known' as ULID },
            worktrees: () => service,
          }
        : null,
  });
  return { app, registry, entry, createdNames, destroyedTargets };
}

test('worktree list route preserves cached registry and unknown-project envelope', async () => {
  const { app, registry } = makeHarness();

  let res = await app.request('/api/projects/known/worktrees');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), registry);

  res = await app.request('/api/projects/missing/worktrees');
  assert.equal(res.status, 404);
  assert.deepEqual(await json(res), {
    ok: false,
    error: 'unknown project: missing',
  });
});

test('worktree create route trims input, validates name, and preserves success envelope', async () => {
  const { app, entry, createdNames } = makeHarness();

  let res = await app.request('/api/projects/known/worktrees/create', {
    method: 'POST',
    body: JSON.stringify({ name: '   ' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), { ok: false, error: 'name required' });

  res = await app.request('/api/projects/known/worktrees/create', {
    method: 'POST',
    body: JSON.stringify({ name: '  feature-a  ' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, entry });
  assert.deepEqual(createdNames, ['feature-a']);
});

test('worktree destroy route trims target, coerces force, and preserves success envelope', async () => {
  const { app, destroyedTargets } = makeHarness();

  let res = await app.request('/api/projects/known/worktrees/destroy', {
    method: 'POST',
    body: JSON.stringify({ target: '' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), { ok: false, error: 'target required' });

  res = await app.request('/api/projects/known/worktrees/destroy', {
    method: 'POST',
    body: JSON.stringify({ target: '  feature-a  ', force: 'yes' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true });
  assert.deepEqual(destroyedTargets, [{ target: 'feature-a', force: false }]);
});

test('worktree create and destroy routes preserve service error envelopes', async () => {
  const { app } = makeHarness({
    create: async () => {
      throw new Error('git create failed');
    },
    destroy: async () => {
      throw new Error('git destroy failed');
    },
  });

  let res = await app.request('/api/projects/known/worktrees/create', {
    method: 'POST',
    body: JSON.stringify({ name: 'feature-a' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 500);
  assert.deepEqual(await json(res), { ok: false, error: 'git create failed' });

  res = await app.request('/api/projects/known/worktrees/destroy', {
    method: 'POST',
    body: JSON.stringify({ target: 'feature-a', force: true }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 500);
  assert.deepEqual(await json(res), { ok: false, error: 'git destroy failed' });
});
