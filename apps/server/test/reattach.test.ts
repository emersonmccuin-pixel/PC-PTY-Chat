// Phase-2 reattach + targeted reconcile.
//
// Pure planReconcile decision tests + a DB-backed reconcileWithHost run against
// a fake host client (no sockets, no real PTYs). Verifies: roster rows
// (running/paused) are reattached (row left live, attach issued); everything
// else (queued, spawning, vanished PTY) is failed with server-restart.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Project, Stage, ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-reattach-'));
process.env.PC_DATA_DIR = tmpDir;
process.env.CLAUDE_CONFIG_DIR = join(tmpDir, 'claude-config');

const {
  closeDb,
  createProject: dbCreateProject,
  getAgentRunRow,
  insertAgentRunRow,
  newId,
  runMigrations,
} = await import('@pc/db');
const { planReconcile, reconcileWithHost } = await import('../src/agent-host/reattach.ts');
const { setRunRegistryForTest } = await import('../src/services/agent-run-factory.ts');
const { setActiveRunRegistryForTest, getActiveRunRegistry } = await import(
  '../src/services/agent-active-runs.ts'
);
const { AgentRunRegistry } = await import('@pc/runtime');

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];
let seq = 0;

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeProject(): Project {
  seq += 1;
  const folderPath = join(tmpDir, `project-${seq}`);
  mkdirSync(folderPath, { recursive: true });
  return dbCreateProject({
    slug: `reattach-${Date.now().toString(36)}-${seq}`,
    name: `Reattach ${seq}`,
    stages,
    folderPath,
  });
}

type Status = 'queued' | 'spawning' | 'running' | 'paused';

function row(status: Status, ccSessionId: string) {
  return {
    id: newId() as ULID,
    ccSessionId,
    status,
    podName: 'researcher',
    projectId: 'p' as ULID,
    dispatcherSessionId: 'orch',
    queuedAt: Date.now(),
  } as unknown as Parameters<typeof planReconcile>[0][number];
}

test('planReconcile: only running/paused rows in the roster reattach', () => {
  const rows = [
    row('running', 'cc-run-live'),
    row('running', 'cc-run-dead'),
    row('paused', 'cc-paused-live'),
    row('queued', 'cc-queued'),
    row('spawning', 'cc-spawning-live'),
  ];
  const roster = new Set(['cc-run-live', 'cc-paused-live', 'cc-spawning-live']);
  const plan = planReconcile(rows, roster);

  assert.deepEqual(
    plan.reattach.map((r) => r.ccSessionId).sort(),
    ['cc-paused-live', 'cc-run-live'],
  );
  assert.deepEqual(
    plan.fail.map((r) => r.ccSessionId).sort(),
    ['cc-queued', 'cc-run-dead', 'cc-spawning-live'],
  );
});

// ── Fake host client ────────────────────────────────────────────────────

class FakeAttachSpawn extends EventEmitter {
  state = 'spawning' as const;
  started = false;
  killed = false;
  constructor(public jsonlPath: string | null) {
    super();
  }
  start() {
    this.started = true;
  }
  awaitReady() {
    return Promise.resolve({ handshakeAt: null, composerReadyAt: 0, initCompleteAt: null });
  }
  async send() {
    return 'ok' as const;
  }
  writeRaw() {
    return true;
  }
  interrupt() {}
  resize() {}
  notifyMcpHandshake() {}
  kill() {
    this.killed = true;
  }
  getState() {
    return this.state;
  }
  getJsonlPath() {
    return this.jsonlPath;
  }
}

test('reconcileWithHost: reattaches roster rows, fails the rest', async () => {
  // Isolated registries so reattach-admits don't leak across tests.
  setRunRegistryForTest(new AgentRunRegistry({ maxConcurrent: 5 }));
  setActiveRunRegistryForTest(null);

  const project = makeProject();
  const liveRunning = makeRunRow(project.id, 'running', 'cc-live-running');
  const livePaused = makeRunRow(project.id, 'paused', 'cc-live-paused');
  const deadRunning = makeRunRow(project.id, 'running', 'cc-dead-running');
  const queued = makeRunRow(project.id, 'queued', 'cc-queued');

  const attachStubs: FakeAttachSpawn[] = [];
  const fakeClient = {
    roster: async () => [
      { key: 'cc-live-running', pid: 1, state: 'running', jsonlPath: null },
      { key: 'cc-live-paused', pid: 2, state: 'running', jsonlPath: null },
    ],
    attachSpawn: () => {
      const s = new FakeAttachSpawn(null);
      attachStubs.push(s);
      return s;
    },
  };

  const result = await reconcileWithHost(
    fakeClient as never,
    { channelServer: { emitToSession: () => false } as never },
  );

  assert.equal(result.reattached, 2);
  assert.equal(result.failed, 2);
  assert.equal(attachStubs.length, 2, 'attach issued for each reattach row');

  // Reattached rows stay live (not failed).
  assert.equal(getAgentRunRow(liveRunning.id)?.status, 'running');
  assert.equal(getAgentRunRow(livePaused.id)?.status, 'paused');

  // Non-roster rows failed with server-restart.
  const dead = getAgentRunRow(deadRunning.id);
  assert.equal(dead?.status, 'failed');
  assert.equal(dead?.failureCause, 'server-restart');
  assert.equal(getAgentRunRow(queued.id)?.status, 'failed');

  // Cancel the reattached runs so their wall-clock/idle timers clear and the
  // process can exit (a paused run ignores `exit` by design, so emitting exit
  // wouldn't drain it — cancel handles both).
  for (const entry of getActiveRunRegistry().list()) entry.run.cancel();
  setRunRegistryForTest(null);
  setActiveRunRegistryForTest(null);
});

function makeRunRow(projectId: ULID, status: Status, ccSessionId: string) {
  return insertAgentRunRow({
    id: newId() as ULID,
    projectId,
    podName: 'researcher',
    dispatcherSessionId: 'orch',
    ccSessionId,
    status,
    input: 'input',
    queuedAt: Date.now(),
  });
}
