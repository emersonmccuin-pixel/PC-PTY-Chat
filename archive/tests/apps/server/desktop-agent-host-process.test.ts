import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const {
  buildPackagedAgentHostSpawnSpec,
  packagedAgentHostLockFilePath,
  requestPackagedAgentHostShutdown,
  waitForPackagedAgentHostLock,
} = require('../../desktop/src/agent-host-process.ts') as typeof import('../../desktop/src/agent-host-process.ts');

test('packaged desktop agent host spawn spec runs Electron as Node sibling', () => {
  const pcRoot = resolve('E:/resources/pcserver');
  const dataDir = resolve('E:/user-data/Caisson');
  const execPath = resolve('E:/Caisson/Caisson.exe');
  const spec = buildPackagedAgentHostSpawnSpec({
    pcRoot,
    dataDir,
    execPath,
    env: { PATH: 'test-path' },
  });
  const lockFilePath = resolve(dataDir, 'agent-host', 'host.lock.json');

  assert.equal(spec.command, execPath);
  assert.deepEqual(spec.args, [
    resolve(pcRoot, 'agent-host.mjs'),
    '--http-lock-file',
    lockFilePath,
  ]);
  assert.equal(spec.cwd, pcRoot);
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(spec.env.PC_ROOT, pcRoot);
  assert.equal(spec.env.PC_DATA_DIR, dataDir);
  assert.equal(spec.env.PC_AGENT_HOST_LOCK_FILE, lockFilePath);
  assert.equal(spec.env.PATH, 'test-path');
});

test('packaged desktop waits only for a fresh agent host lock file', async () => {
  const lockFilePath = resolve('E:/user-data/Caisson/agent-host/host.lock.json');
  let mtimeMs = 100;
  let now = 0;
  const sleeps: number[] = [];

  const first = await waitForPackagedAgentHostLock({
    lockFilePath,
    startedAt: 200,
    timeoutMs: 3,
    pollIntervalMs: 1,
    statFile: () => ({ mtimeMs }),
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    now: () => now,
  });
  assert.equal(first, false);
  assert.deepEqual(sleeps, [1, 1, 1]);

  mtimeMs = 250;
  const second = await waitForPackagedAgentHostLock({
    lockFilePath,
    startedAt: 200,
    timeoutMs: 3,
    statFile: () => ({ mtimeMs }),
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(second, true);
});

test('packaged desktop sends host-exit shutdown to lock-file endpoint', async () => {
  const dataDir = join(tmpdir(), `pc-packaged-host-${process.pid}-${Date.now()}`);
  const lockFilePath = packagedAgentHostLockFilePath(dataDir);
  mkdirSync(dirname(lockFilePath), { recursive: true });
  writeFileSync(
    lockFilePath,
    JSON.stringify({
      pid: 4321,
      hostId: 'packaged-host-1',
      port: 45678,
      startedAt: 1_700_000_000_000,
      protocolVersion: 1,
    }),
  );

  let request: { url: string; body: unknown } | null = null;
  const ok = await requestPackagedAgentHostShutdown({
    lockFilePath,
    fetchImpl: async (input, init) => {
      request = {
        url: String(input),
        body: JSON.parse(String(init?.body)),
      };
      return new Response('{}', { status: 200 });
    },
  });

  assert.equal(ok, true);
  assert.deepEqual(request, {
    url: 'http://127.0.0.1:45678/command',
    body: {
      command: { type: 'shutdown', mode: 'host-exit' },
    },
  });
});
