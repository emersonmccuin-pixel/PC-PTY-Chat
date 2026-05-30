// Section 36+ — pod-drift detection + reset-all endpoint smoke tests.
//
// Two surfaces:
//   - GET /api/agents/pods augments each row with `driftedFields`.
//   - POST /api/agents/pods/reset-all-stock-to-default walks the canonical
//     roster, resets each drifted pod, returns a summary.
//
// Run via:  pnpm --filter @pc/server test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDataDir = mkdtempSync(join(tmpdir(), 'pc-pod-drift-db-'));
process.env.PC_DATA_DIR = tmpDataDir;

const { closeDb, createAgent, runMigrations, updateAgent } = await import('@pc/db');
const { Hono } = await import('hono');
const { registerPodRoutes } = await import('../src/routes/pod-routes.ts');
import type { PodAgentRow } from '@pc/domain';

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

interface BroadcastEnv {
  type: string;
  change?: string;
}

function freshApp(opts?: {
  driftFn?: (pod: PodAgentRow) => string[] | null;
  canonicalNames?: () => string[];
  resetFn?: (
    name: string,
    reason: string,
  ) => { agent: PodAgentRow | null; resetFields: string[] };
}) {
  const broadcasts: BroadcastEnv[] = [];
  const changed: Array<{ name: string; change: string }> = [];
  const app = new Hono();
  registerPodRoutes(app, {
    broadcastAll: (m) => broadcasts.push(m as BroadcastEnv),
    onPodChanged: (n, c) => changed.push({ name: n, change: c }),
    detectStockPodDrift: opts?.driftFn,
    listCanonicalStockPodNames: opts?.canonicalNames,
    resetStockPodToDefault: opts?.resetFn,
  });
  return { app, broadcasts, changed };
}

async function fetchJson(
  app: InstanceType<typeof Hono>,
  method: string,
  path: string,
  body?: unknown,
) {
  const init: RequestInit =
    body !== undefined
      ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { method };
  const res = await app.fetch(new Request(`http://test${path}`, init));
  const data = (await res.json()) as Record<string, unknown>;
  return { status: res.status, data };
}

test('GET /api/agents/pods annotates each row with driftedFields', async () => {
  // Plant a stock pod that we'll claim is drifted on `prompt`, and a
  // user-created pod which should always come back driftedFields: null.
  const stockPod = createAgent(
    { name: 'drift-test-stock', scope: 'global', origin: 'stock', prompt: 'orig' },
    { actor: 'orchestrator', reason: 'test-fixture' },
  );
  const userPod = createAgent(
    { name: 'drift-test-user', scope: 'global', prompt: 'user' },
    { actor: 'user', reason: 'test-fixture' },
  );

  const { app } = freshApp({
    driftFn: (pod) => {
      if (pod.origin !== 'stock') return null;
      if (pod.name === 'drift-test-stock') return ['prompt'];
      return [];
    },
  });
  const { status, data } = await fetchJson(app, 'GET', '/api/agents/pods');
  assert.equal(status, 200);
  const pods = data.pods as Array<{ id: string; driftedFields: string[] | null }>;
  const stockRow = pods.find((p) => p.id === stockPod.id)!;
  const userRow = pods.find((p) => p.id === userPod.id)!;
  assert.deepEqual(stockRow.driftedFields, ['prompt']);
  assert.equal(userRow.driftedFields, null);
});

test('GET /api/agents/pods returns driftedFields: null on every row when no drift detector is wired', async () => {
  const { app } = freshApp(); // no driftFn
  const { status, data } = await fetchJson(app, 'GET', '/api/agents/pods');
  assert.equal(status, 200);
  const pods = data.pods as Array<{ driftedFields: string[] | null }>;
  for (const p of pods) {
    assert.equal(p.driftedFields, null);
  }
});

test('POST /api/agents/pods/reset-all-stock-to-default 500s when the deps aren\'t wired', async () => {
  const { app } = freshApp();
  const { status, data } = await fetchJson(
    app,
    'POST',
    '/api/agents/pods/reset-all-stock-to-default',
    {},
  );
  assert.equal(status, 500);
  assert.equal(data.ok, false);
});

test('POST /api/agents/pods/reset-all-stock-to-default walks drifted pods and skips pristine ones', async () => {
  // Seed two stock pods: one drifted, one pristine. The reset fn closes
  // over a counter so the test can verify it's called only on the drifted
  // pod's name.
  const driftedPod = createAgent(
    { name: 'reset-all-drifted', scope: 'global', origin: 'stock', prompt: 'live' },
    { actor: 'orchestrator', reason: 'test-fixture' },
  );
  const pristinePod = createAgent(
    { name: 'reset-all-pristine', scope: 'global', origin: 'stock', prompt: 'live' },
    { actor: 'orchestrator', reason: 'test-fixture' },
  );

  const resetCalls: string[] = [];
  const { app, broadcasts, changed } = freshApp({
    driftFn: (pod) => {
      if (pod.origin !== 'stock') return null;
      if (pod.name === 'reset-all-drifted') return ['prompt'];
      return [];
    },
    canonicalNames: () => ['reset-all-drifted', 'reset-all-pristine'],
    resetFn: (name, reason) => {
      resetCalls.push(`${name}:${reason}`);
      // Pretend the reset wrote a new prompt back.
      const updated = updateAgent(
        name === 'reset-all-drifted' ? driftedPod.id : pristinePod.id,
        { prompt: 'reset-prompt' },
        { actor: 'user', reason: 'ui-reset-all' },
      );
      return { agent: updated, resetFields: ['prompt'] };
    },
  });

  const { status, data } = await fetchJson(
    app,
    'POST',
    '/api/agents/pods/reset-all-stock-to-default',
    {},
  );
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.deepEqual(resetCalls, ['reset-all-drifted:ui-reset-all']);

  const reset = data.reset as Array<{ name: string; resetFields: string[] }>;
  const unchanged = data.unchanged as string[];
  assert.deepEqual(
    reset.map((r) => r.name),
    ['reset-all-drifted'],
  );
  assert.deepEqual(reset[0]!.resetFields, ['prompt']);
  assert.deepEqual(unchanged, ['reset-all-pristine']);

  // One broadcast + one onPodChanged hook call for the single reset row.
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0]!.type, 'pod-changed');
  assert.equal(broadcasts[0]!.change, 'updated');
  assert.equal(changed.length, 1);
  assert.equal(changed[0]!.name, 'reset-all-drifted');
});

test('POST /api/agents/pods/reset-all-stock-to-default reports names with no live row in `missing`', async () => {
  const { app } = freshApp({
    driftFn: () => null,
    canonicalNames: () => ['no-such-pod'], // present in the roster, absent from the DB
    resetFn: () => ({ agent: null, resetFields: [] }),
  });
  const { status, data } = await fetchJson(
    app,
    'POST',
    '/api/agents/pods/reset-all-stock-to-default',
    {},
  );
  assert.equal(status, 200);
  assert.deepEqual(data.missing, ['no-such-pod']);
  assert.deepEqual(data.reset, []);
  assert.deepEqual(data.unchanged, []);
});
