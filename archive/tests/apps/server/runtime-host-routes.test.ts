import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import type { OrchestratorSession, ULID } from '@pc/domain';
import type {
  RuntimeHostPtySession,
  RuntimeHostRuntime,
} from '../src/features/runtime-host/routes.ts';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-runtime-host-routes-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createOrchestratorSession,
  createProject,
  endOrchestratorSession,
  enqueueOrchestratorSend,
  getActiveOrchestratorSession,
  getOrchestratorSendQueueRow,
  getOrchestratorSession,
  markOrchestratorSendFailed,
  reactivateOrchestratorSession,
  runMigrations,
} = await import('@pc/db');
const { registerRuntimeHostRoutes } = await import('../src/features/runtime-host/routes.ts');

const stages = [
  { id: 'todo', name: 'Todo', order: 0 },
  { id: 'done', name: 'Done', order: 1 },
];
let seq = 0;

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeSession(projectId: ULID, label: string): OrchestratorSession {
  return createOrchestratorSession({
    projectId,
    providerSessionId: `provider-${label}-${Date.now().toString(36)}-${seq}`,
  });
}

function makeHarness(options: { slugPrefix?: string } = {}) {
  seq += 1;
  const project = createProject({
    slug: `${options.slugPrefix ?? 'runtime-host'}-${Date.now().toString(36)}-${seq}`,
    name: 'Runtime Host',
    stages,
    folderPath: join(tmpDir, `project-${seq}`),
  });
  const pty: RuntimeHostPtySession & { state: string; sent: string[] } = {
    state: 'ready',
    sent: [],
    getState() {
      return this.state;
    },
    send(text: string) {
      this.sent.push(text);
      return 'ok';
    },
  };
  const runtime: RuntimeHostRuntime = {
    project: { id: project.id, slug: project.slug },
    dataPath: tmpDir,
    folderPath: project.folderPath,
    sessionDataPath: (sessionId: string) => {
      const dir = join(tmpDir, 'sessions', sessionId);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    orchestratorPtyState: () => pty.state as ReturnType<RuntimeHostRuntime['orchestratorPtyState']>,
    orchestratorRuntimeSnapshot: () => ({
      spawnAttemptId: 'spawn-1',
      spawnAttempt: 1,
      lastReadyAt: 1_000,
      nextRetryAt: null,
      runtimeFailureReason: null,
    }),
    startNewSession: () => {
      const active = getActiveOrchestratorSession(project.id);
      if (active) endOrchestratorSession(active.id, 'user_ended');
      return makeSession(project.id, 'new');
    },
    resumeSession: (targetId: ULID) => {
      const target = getOrchestratorSession(targetId);
      if (!target || target.projectId !== project.id) throw new Error(`unknown session: ${targetId}`);
      const active = getActiveOrchestratorSession(project.id);
      if (active && active.id !== targetId) endOrchestratorSession(active.id, 'user_ended');
      const resumed = reactivateOrchestratorSession(targetId);
      if (!resumed) throw new Error(`unknown session: ${targetId}`);
      return resumed;
    },
    closeSession: () => {
      const active = getActiveOrchestratorSession(project.id);
      if (!active) return false;
      endOrchestratorSession(active.id, 'user_ended');
      return true;
    },
    killOrchestratorForSmoke: () => true,
    ptySession: () => pty,
    hasLiveTransientSession: () => false,
  };
  const broadcasts: Array<{ projectId: ULID; msg: unknown }> = [];
  const queueBroadcasts: Array<{ projectId: ULID; sessionId: ULID }> = [];
  const runtimeBroadcasts: ULID[] = [];
  const starts: Array<{ projectId: ULID; sessionId: ULID | null }> = [];
  const app = new Hono();
  registerRuntimeHostRoutes(app, {
    resolveProject: (projectId) => (projectId === project.id ? runtime : null),
    runtimeSnapshotPayload: (projectId) => ({
      type: 'runtime-state',
      sessionId: getActiveOrchestratorSession(projectId)?.id ?? null,
      provider: 'claude',
      providerSessionId: getActiveOrchestratorSession(projectId)?.providerSessionId ?? null,
      health: pty.state === 'ready' ? 'ready' : 'busy',
      waitPoint: 'none',
      ptyState: pty.state,
      exitCode: null,
      exitSignal: null,
      spawnAttemptId: 'spawn-1',
      spawnAttempt: 1,
      lastReadyAt: 1_000,
      nextRetryAt: null,
      lastExitAt: null,
      lastJsonlAt: null,
      lastActivityAt: null,
      failureReason: null,
      rawJsonlPath: null,
      rawJsonlExists: false,
      rawJsonlCursor: null,
      replayPath: null,
      replayExists: false,
      replayLineCount: 0,
      replayHighWaterSeq: 0,
      queueDepth: 0,
      queue: [],
    }),
    broadcastTo: (projectId, msg) => broadcasts.push({ projectId, msg }),
    broadcastRuntimeSnapshot: (projectId) => runtimeBroadcasts.push(projectId),
    broadcastSendQueueSnapshot: (projectId, sessionId) => {
      queueBroadcasts.push({ projectId, sessionId });
    },
    ensureOrchestratorPty: () => pty,
    startOrchestratorPtyInBackground: (projectId) => {
      starts.push({
        projectId,
        sessionId: getActiveOrchestratorSession(projectId)?.id ?? null,
      });
    },
  });

  return { app, broadcasts, project, pty, queueBroadcasts, runtime, runtimeBroadcasts, starts };
}

test('runtime snapshot route reports current state without starting the PTY', async () => {
  const { app, project, starts } = makeHarness();
  const session = makeSession(project.id, 'active');

  const res = await app.request(`/api/projects/${project.id}/orchestrator/runtime`);
  const body = await res.json() as { ok: boolean; runtime: { sessionId: string | null } };

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.runtime.sessionId, session.id);
  assert.deepEqual(starts, []);
});

test('new session route cancels prior queue, broadcasts replay surfaces, and starts runtime', async () => {
  const { app, broadcasts, project, queueBroadcasts, starts } = makeHarness();
  const previous = makeSession(project.id, 'previous');
  const queued = enqueueOrchestratorSend({
    projectId: project.id,
    sessionId: previous.id,
    clientMessageId: 'client-old',
    text: 'old queued prompt',
    status: 'queued_busy',
  });

  const res = await app.request(`/api/projects/${project.id}/sessions/new`, { method: 'POST' });
  const body = await res.json() as {
    ok: boolean;
    transition: string;
    session: OrchestratorSession;
    highWaterSeq: number;
  };

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.transition, 'new-session');
  assert.notEqual(body.session.id, previous.id);
  assert.equal(body.highWaterSeq, 0);
  assert.equal(getOrchestratorSendQueueRow(queued.id)?.status, 'cancelled');
  assert.deepEqual(queueBroadcasts.map((item) => item.sessionId), [previous.id, body.session.id]);
  assert.equal(starts.length, 1);
  assert.equal(starts[0]?.sessionId, body.session.id);
  assert.equal(
    broadcasts.some(({ msg }) =>
      typeof msg === 'object' &&
      msg !== null &&
      (msg as { type?: string; transition?: string }).type === 'session-changed' &&
      (msg as { transition?: string }).transition === 'new-session',
    ),
    true,
  );
  assert.equal(
    broadcasts.some(({ msg }) =>
      typeof msg === 'object' &&
      msg !== null &&
      (msg as { type?: string; sessionId?: string }).type === 'session-replay' &&
      (msg as { sessionId?: string }).sessionId === body.session.id,
    ),
    true,
  );
});

test('close route ends the active session, broadcasts session:null, and starts no runtime', async () => {
  const { app, broadcasts, project, starts } = makeHarness();
  const active = makeSession(project.id, 'live');

  const res = await app.request(`/api/projects/${project.id}/sessions/close`, { method: 'POST' });
  const body = await res.json() as { ok: boolean; transition: string; closed: boolean };

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.transition, 'close-session');
  assert.equal(body.closed, true);
  // No active session remains → the UI falls back to the launcher.
  assert.equal(getActiveOrchestratorSession(project.id), null);
  // Closing never spawns.
  assert.equal(starts.length, 0);
  assert.equal(
    broadcasts.some(({ msg }) =>
      typeof msg === 'object' &&
      msg !== null &&
      (msg as { type?: string; transition?: string }).type === 'session-changed' &&
      (msg as { transition?: string }).transition === 'close-session' &&
      (msg as { session?: unknown }).session === null,
    ),
    true,
  );
  void active;
});

test('resume route returns persisted replay high-water and cancels replaced session queue', async () => {
  const { app, broadcasts, project, queueBroadcasts, runtime, starts } = makeHarness();
  const target = makeSession(project.id, 'target');
  endOrchestratorSession(target.id, 'user_ended');
  const current = makeSession(project.id, 'current');
  const queued = enqueueOrchestratorSend({
    projectId: project.id,
    sessionId: current.id,
    clientMessageId: 'client-current',
    text: 'current queued prompt',
    status: 'queued_busy',
  });
  appendFileSync(
    join(runtime.sessionDataPath(target.id), 'jsonl-events.jsonl'),
    JSON.stringify({
      id: `${target.id}:3`,
      sessionId: target.id,
      seq: 3,
      type: 'jsonl',
      kind: 'jsonl-user',
      event: { kind: 'jsonl-user', text: 'persisted target prompt' },
      source: { kind: 'claude-jsonl', cursor: 9 },
    }) + '\n',
  );

  const res = await app.request(`/api/projects/${project.id}/sessions/${target.id}/resume`, {
    method: 'POST',
  });
  const body = await res.json() as {
    ok: boolean;
    transition: string;
    session: OrchestratorSession;
    highWaterSeq: number;
  };

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.transition, 'resume-session');
  assert.equal(body.session.id, target.id);
  assert.equal(body.highWaterSeq, 3);
  assert.equal(getOrchestratorSendQueueRow(queued.id)?.status, 'cancelled');
  assert.deepEqual(queueBroadcasts.map((item) => item.sessionId), [current.id, target.id]);
  assert.equal(starts.length, 1);
  assert.equal(starts[0]?.sessionId, target.id);
  assert.equal(
    broadcasts.some(({ msg }) =>
      typeof msg === 'object' &&
      msg !== null &&
      (msg as { type?: string; transition?: string }).type === 'session-changed' &&
      (msg as { transition?: string }).transition === 'resume-session',
    ),
    true,
  );
  assert.equal(
    broadcasts.some(({ msg }) =>
      typeof msg === 'object' &&
      msg !== null &&
      (msg as { type?: string; highWaterSeq?: number }).type === 'session-replay' &&
      (msg as { highWaterSeq?: number }).highWaterSeq === 3,
    ),
    true,
  );
});

test('send-queue retry route requeues failed prompts against the active session', async () => {
  const { app, project, pty, queueBroadcasts } = makeHarness();
  const session = makeSession(project.id, 'retry');
  pty.state = 'busy';
  const failed = enqueueOrchestratorSend({
    projectId: project.id,
    sessionId: session.id,
    clientMessageId: 'client-failed',
    text: 'retry me',
    status: 'queued_busy',
  });
  markOrchestratorSendFailed(failed.id, 'boom');

  const res = await app.request(
    `/api/projects/${project.id}/send-queue/${failed.id}/retry`,
    { method: 'POST' },
  );
  const body = await res.json() as {
    ok: boolean;
    item: { id: string; status: string; failureReason: string | null };
  };

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.item.id, failed.id);
  assert.equal(body.item.status, 'queued_busy');
  assert.equal(body.item.failureReason, null);
  assert.equal(getOrchestratorSendQueueRow(failed.id)?.status, 'queued_busy');
  assert.deepEqual(queueBroadcasts.map((item) => item.sessionId), [session.id]);
});
