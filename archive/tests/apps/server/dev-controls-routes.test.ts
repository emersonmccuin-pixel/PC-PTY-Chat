import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { Hono } from 'hono';

import { DEV_RESTART_EXIT_CODE } from '../src/features/dev-controls/constants.ts';
import { registerDevControlRoutes } from '../src/features/dev-controls/routes.ts';

const originalPcRoot = process.env.PC_ROOT;

afterEach(() => {
  if (originalPcRoot === undefined) delete process.env.PC_ROOT;
  else process.env.PC_ROOT = originalPcRoot;
});

async function json<T>(res: Response): Promise<T> {
  return await res.json() as T;
}

function devApp(deps: Parameters<typeof registerDevControlRoutes>[1]) {
  delete process.env.PC_ROOT;
  const app = new Hono();
  registerDevControlRoutes(app, deps);
  return app;
}

test('dev control routes do not register in packaged mode', async () => {
  process.env.PC_ROOT = '/packaged/pcserver';
  const app = new Hono();
  registerDevControlRoutes(app, { gracefulShutdown: () => {} });

  const res = await app.request('/api/dev/status');

  assert.equal(res.status, 404);
});

test('dev status reports active-agent count and restart safety', async () => {
  const app = devApp({
    gracefulShutdown: () => {},
    activeRunCount: () => 2,
  });

  const res = await app.request('/api/dev/status');

  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { activeAgents: 2, canRestart: false });
});

test('dev restart rejects active agents without force', async () => {
  let shutdowns = 0;
  let scheduled = false;
  const app = devApp({
    gracefulShutdown: () => { shutdowns += 1; },
    activeRunCount: () => 2,
    scheduleRestart: () => { scheduled = true; },
  });

  const res = await app.request('/api/dev/restart', {
    method: 'POST',
    body: JSON.stringify({}),
    headers: { 'content-type': 'application/json' },
  });

  const body = await json<{ ok: boolean; error: string }>(res);
  assert.equal(res.status, 409);
  assert.equal(body.ok, false);
  assert.match(body.error, /2 agent\(s\) active/);
  assert.equal(shutdowns, 0);
  assert.equal(scheduled, false);
});

test('dev restart schedules graceful shutdown and sentinel exit when safe', async () => {
  let shutdowns = 0;
  let exitCode: number | null = null;
  let scheduled = false;
  const app = devApp({
    gracefulShutdown: () => { shutdowns += 1; },
    activeRunCount: () => 0,
    scheduleRestart: (fn) => {
      scheduled = true;
      fn();
    },
    exitProcess: (code) => { exitCode = code; },
  });

  const res = await app.request('/api/dev/restart', {
    method: 'POST',
    body: JSON.stringify({}),
    headers: { 'content-type': 'application/json' },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true });
  assert.equal(scheduled, true);
  assert.equal(shutdowns, 1);
  assert.equal(exitCode, DEV_RESTART_EXIT_CODE);
});

test('dev restart allows forced restart with active agents', async () => {
  let shutdowns = 0;
  let exitCode: number | null = null;
  const app = devApp({
    gracefulShutdown: () => { shutdowns += 1; },
    activeRunCount: () => 3,
    scheduleRestart: (fn) => { fn(); },
    exitProcess: (code) => { exitCode = code; },
  });

  const res = await app.request('/api/dev/restart', {
    method: 'POST',
    body: JSON.stringify({ force: true }),
    headers: { 'content-type': 'application/json' },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true });
  assert.equal(shutdowns, 1);
  assert.equal(exitCode, DEV_RESTART_EXIT_CODE);
});
