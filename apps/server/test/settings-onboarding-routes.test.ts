import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-settings-onboarding-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, runMigrations } = await import('@pc/db');
const { registerSettingsOnboardingRoutes } = await import(
  '../src/features/settings-onboarding/routes.ts'
);

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function json<T>(res: Response): Promise<T> {
  return await res.json() as T;
}

function fakePreflight() {
  return {
    ok: true,
    claude: {
      status: 'ok',
      path: 'claude',
      source: 'path',
      version: '2.1.0',
      minVersion: '2.0.0',
    },
    auth: { status: 'authed', note: 'Signed in.' },
    git: { name: 'git', present: true, version: '2.50.0', severity: 'hard' },
    soft: [],
  };
}

test('settings routes preserve effective dataDir and patch normalization', async () => {
  const app = new Hono();
  registerSettingsOnboardingRoutes(app, {
    runPreflight: async () => fakePreflight() as any,
  });

  let res = await app.request('/api/settings');
  const initial = await json<{ ok: boolean; settings: { dataDir: string } }>(res);
  assert.equal(res.status, 200);
  assert.equal(initial.ok, true);
  assert.equal(initial.settings.dataDir, tmpDir);

  res = await app.request('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      dataDir: 'ignored',
      claudeExe: '   ',
      telemetryOptIn: true,
      activityPanel: { open: false, showAllProjects: true },
      jsonl: { retentionDays: 'never' },
    }),
    headers: { 'content-type': 'application/json' },
  });
  const patched = await json<{
    ok: boolean;
    restartRequired: boolean;
    settings: {
      dataDir: string;
      claudeExe: string | null;
      telemetryOptIn: boolean;
      activityPanel: { open: boolean; showAllProjects: boolean };
      jsonl: { retentionDays: number | 'never' };
    };
  }>(res);

  assert.equal(res.status, 200);
  assert.equal(patched.ok, true);
  assert.equal(patched.restartRequired, false);
  assert.equal(patched.settings.dataDir, tmpDir);
  assert.equal(patched.settings.claudeExe, null);
  assert.equal(patched.settings.telemetryOptIn, true);
  assert.deepEqual(patched.settings.activityPanel, { open: false, showAllProjects: true });
  assert.deepEqual(patched.settings.jsonl, { retentionDays: 'never' });
});

test('claude profile route reports stored override source', async () => {
  const app = new Hono();
  registerSettingsOnboardingRoutes(app);
  const profileDir = join(tmpDir, 'claude-profile');

  await app.request('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ claudeConfigDir: profileDir }),
    headers: { 'content-type': 'application/json' },
  });

  const res = await app.request('/api/settings/claude-profile');
  const body = await json<{
    ok: boolean;
    override: string | null;
    effective: string;
    source: string;
  }>(res);

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.override, profileDir);
  assert.equal(body.effective, profileDir);
  assert.equal(body.source, 'override');
});

test('preflight and onboarding routes use injected services and keep envelopes', async () => {
  const app = new Hono();
  let cancelled = false;
  registerSettingsOnboardingRoutes(app, {
    runPreflight: async () => fakePreflight() as any,
    installClaude: async () => ({ preflight: fakePreflight(), log: 'claude installed' }) as any,
    installGit: async () => {
      throw new Error('git install failed');
    },
    startLogin: () => ({
      running: true,
      url: 'https://example.invalid/login',
      exited: false,
      exitCode: null,
      tail: '',
    }),
    getLoginState: () => ({
      running: false,
      url: null,
      exited: true,
      exitCode: 0,
      tail: 'done',
    }),
    probeAuth: async () => ({ status: 'authed', note: 'Signed in.' }),
    cancelLogin: () => {
      cancelled = true;
    },
  });

  let res = await app.request('/api/preflight');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, preflight: fakePreflight() });

  res = await app.request('/api/onboarding/install/claude', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), {
    ok: true,
    preflight: fakePreflight(),
    log: 'claude installed',
  });

  res = await app.request('/api/onboarding/install/git', { method: 'POST' });
  assert.equal(res.status, 500);
  assert.deepEqual(await json(res), { ok: false, error: 'git install failed' });

  res = await app.request('/api/onboarding/auth/login', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), {
    ok: true,
    login: {
      running: true,
      url: 'https://example.invalid/login',
      exited: false,
      exitCode: null,
      tail: '',
    },
  });

  res = await app.request('/api/onboarding/auth/state');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), {
    ok: true,
    login: {
      running: false,
      url: null,
      exited: true,
      exitCode: 0,
      tail: 'done',
    },
    authed: true,
    auth: { status: 'authed', note: 'Signed in.' },
  });

  res = await app.request('/api/onboarding/auth/cancel', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true });
  assert.equal(cancelled, true);
});
