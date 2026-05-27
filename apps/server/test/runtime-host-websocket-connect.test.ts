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
    startOrchestratorPtyInBackground: (projectId) => starts.push(projectId),
  });

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
