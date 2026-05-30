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

import type { OrchestratorSession, ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-runtime-host-ws-connect-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createOrchestratorSession,
  createProject,
  enqueueOrchestratorSend,
  getActiveOrchestratorSession,
  runMigrations,
} = await import('@pc/db');
const { sendRuntimeHostConnectSnapshot } = await import(
  '../src/features/runtime-host/websocket-connect.ts'
);

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

test('connect snapshot sends session, state, runtime, replay, and queue before background start', () => {
  seq += 1;
  const project = createProject({
    slug: `runtime-host-ws-${Date.now().toString(36)}-${seq}`,
    name: 'Runtime Host WS',
    stages,
    folderPath: join(tmpDir, `project-${seq}`),
  });
  const active = createOrchestratorSession({
    projectId: project.id,
    providerSessionId: `provider-ws-${seq}`,
  });
  const sessionDataPath = (sessionId: string) => {
    const dir = join(tmpDir, 'sessions', sessionId);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  appendFileSync(
    join(sessionDataPath(active.id), 'jsonl-events.jsonl'),
    JSON.stringify({
      id: `${active.id}:4`,
      sessionId: active.id,
      seq: 4,
      type: 'jsonl',
      kind: 'jsonl-user',
      event: { kind: 'jsonl-user', text: 'persisted ws prompt' },
      source: { kind: 'claude-jsonl', cursor: 11 },
    }) + '\n',
  );
  const queued = enqueueOrchestratorSend({
    projectId: project.id,
    sessionId: active.id,
    clientMessageId: 'client-ws',
    text: 'queued on reconnect',
    status: 'queued_busy',
  });
  const pty = {
    getState: () => 'ready',
  };
  const runtime = {
    activeSession: (): OrchestratorSession | null =>
      getActiveOrchestratorSession(project.id),
    ensureActiveSession: (): OrchestratorSession =>
      getActiveOrchestratorSession(project.id) ?? active,
    ptySession: () => pty,
    sessionDataPath,
  };
  const envelopes: Array<Record<string, unknown>> = [];
  const attached: Array<{ projectId: ULID; state: string }> = [];
  const starts: ULID[] = [];

  const returned = sendRuntimeHostConnectSnapshot({
    projectId: project.id,
    runtime,
    send: (envelope) => envelopes.push(envelope),
    attachPtyHandlers: (projectId, _runtime, session) => {
      attached.push({ projectId, state: session.getState() });
    },
    runtimeSnapshotPayload: () => ({
      type: 'runtime-state',
      sessionId: active.id,
      provider: 'claude',
      providerSessionId: active.providerSessionId,
      health: 'ready',
      waitPoint: 'none',
      ptyState: 'ready',
      exitCode: null,
      exitSignal: null,
      spawnAttemptId: null,
      spawnAttempt: 0,
      lastReadyAt: null,
      nextRetryAt: null,
      lastExitAt: null,
      lastJsonlAt: null,
      lastActivityAt: null,
      failureReason: null,
      rawJsonlPath: null,
      rawJsonlExists: false,
      rawJsonlCursor: null,
      replayPath: null,
      replayExists: true,
      replayLineCount: 1,
      replayHighWaterSeq: 4,
      queueDepth: 1,
      queue: [],
    }),
    chatIntent: true,
    startOrchestratorPtyInBackground: (projectId) => starts.push(projectId),
  });

  assert.ok(returned);
  assert.equal(returned.id, active.id);
  assert.deepEqual(envelopes.map((envelope) => envelope.type), [
    'session-changed',
    'state',
    'runtime-state',
    'session-replay',
    'send-queue-snapshot',
  ]);
  assert.deepEqual(attached, [{ projectId: project.id, state: 'ready' }]);
  assert.deepEqual(starts, [project.id]);
  assert.equal(envelopes.every((envelope) => envelope.projectId === project.id), true);
  assert.equal((envelopes[3] as { highWaterSeq?: number }).highWaterSeq, 4);
  assert.deepEqual(
    ((envelopes[4] as { items?: Array<{ id: string }> }).items ?? []).map((item) => item.id),
    [queued.id],
  );
});

test('activity-intent connect (chatIntent=false) never spawns, attaches, or mints a session', () => {
  seq += 1;
  const project = createProject({
    slug: `runtime-host-ws-activity-${Date.now().toString(36)}-${seq}`,
    name: 'Runtime Host WS Activity',
    stages,
    folderPath: join(tmpDir, `project-activity-${seq}`),
  });
  // No session created — a brand-new project the activity fan-out connects to.
  let ensureCalled = false;
  const runtime = {
    activeSession: (): OrchestratorSession | null =>
      getActiveOrchestratorSession(project.id),
    ensureActiveSession: (): OrchestratorSession => {
      ensureCalled = true;
      throw new Error('activity connect must not mint a session');
    },
    ptySession: () => ({ getState: () => 'ready' }),
    sessionDataPath: (sessionId: string) => join(tmpDir, 'sessions', sessionId),
  };
  const envelopes: Array<Record<string, unknown>> = [];
  const attached: ULID[] = [];
  const starts: ULID[] = [];

  const returned = sendRuntimeHostConnectSnapshot({
    projectId: project.id,
    runtime,
    chatIntent: false,
    send: (envelope) => envelopes.push(envelope),
    attachPtyHandlers: (projectId) => attached.push(projectId),
    runtimeSnapshotPayload: () => ({ type: 'runtime-state' }) as never,
    startOrchestratorPtyInBackground: (projectId) => starts.push(projectId),
  });

  assert.equal(returned, null, 'no session minted');
  assert.equal(ensureCalled, false, 'ensureActiveSession never called');
  assert.deepEqual(starts, [], 'no orchestrator spawn');
  assert.deepEqual(attached, [], 'no pty handlers attached');
  // Still emits the read-only snapshot so activity/unread can reconcile.
  assert.deepEqual(envelopes.map((e) => e.type), ['session-changed', 'runtime-state']);
  assert.equal((envelopes[0] as { session: unknown }).session, null);
  // No active session → no replay/queue envelopes.
  assert.equal(getActiveOrchestratorSession(project.id), null);
});
