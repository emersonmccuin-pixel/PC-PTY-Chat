import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { OrchestratorSession, ULID } from '@pc/domain';
import type {
  RuntimeHostMessagePtySession,
  RuntimeHostMessageRuntime,
} from '../src/features/runtime-host/websocket-message.ts';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-runtime-host-ws-message-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createOrchestratorSession,
  createProject,
  getActiveOrchestratorSession,
  getOrchestratorSendQueueRow,
  listQueuedOrchestratorSendsForSession,
  runMigrations,
} = await import('@pc/db');
const { handleRuntimeHostWsMessage } = await import(
  '../src/features/runtime-host/websocket-message.ts'
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

function makeHarness(options: { createActive?: boolean; ptyState?: string } = {}) {
  seq += 1;
  const project = createProject({
    slug: `runtime-host-msg-${Date.now().toString(36)}-${seq}`,
    name: 'Runtime Host Message',
    stages,
    folderPath: join(tmpDir, `project-${seq}`),
  });
  const active = options.createActive === false
    ? null
    : createOrchestratorSession({
      projectId: project.id,
      providerSessionId: `provider-msg-${seq}`,
    });
  const pty: RuntimeHostMessagePtySession & {
    interrupted: boolean;
    resized: Array<{ cols: number; rows: number }>;
    sent: string[];
    state: string;
    terminalBytes: string[];
  } = {
    interrupted: false,
    resized: [],
    sent: [],
    state: options.ptyState ?? 'ready',
    terminalBytes: [],
    getState() {
      return this.state;
    },
    send(text: string) {
      this.sent.push(text);
      return 'ok';
    },
    interrupt() {
      this.interrupted = true;
    },
    writeRaw(bytes: string) {
      this.terminalBytes.push(bytes);
      return true;
    },
  };
  const runtime: RuntimeHostMessageRuntime = {
    ensureActiveSession: (): OrchestratorSession =>
      getActiveOrchestratorSession(project.id) ??
      createOrchestratorSession({
        projectId: project.id,
        providerSessionId: `provider-created-${seq}`,
      }),
    ptySession: () => pty,
    resizeOrchestrator: (cols: number, rows: number) => {
      pty.resized.push({ cols, rows });
    },
    sessionDataPath: (sessionId: string) => {
      const dir = join(tmpDir, 'sessions', sessionId);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
  };
  const broadcasts: Array<{ projectId: ULID; msg: unknown }> = [];
  const queueBroadcasts: Array<{ projectId: ULID; sessionId: ULID }> = [];
  const sent: Array<Record<string, unknown>> = [];
  const asks: Array<{ id: string; answer: string }> = [];
  const handle = (message: unknown) =>
    handleRuntimeHostWsMessage({
      projectId: project.id,
      runtime,
      raw: JSON.stringify(message),
      send: (envelope) => sent.push(envelope),
      broadcastTo: (projectId, msg) => broadcasts.push({ projectId, msg }),
      broadcastSendQueueSnapshot: (projectId, sessionId) => {
        queueBroadcasts.push({ projectId, sessionId });
      },
      ensureOrchestratorPty: () => pty,
      resolvePendingAsk: (id, answer) => asks.push({ id, answer }),
    });
  return { active, asks, broadcasts, handle, project, pty, queueBroadcasts, runtime, sent };
}

test('client ping returns server pong envelope', async () => {
  const { handle, project, sent } = makeHarness();

  await handle({ type: 'client-ping', nonce: 'n1', sentAt: 123 });

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.projectId, project.id);
  assert.equal(sent[0]?.type, 'server-pong');
  assert.equal(sent[0]?.nonce, 'n1');
  assert.equal(sent[0]?.sentAt, 123);
  assert.equal(typeof sent[0]?.serverTime, 'number');
});

test('ready send writes to PTY, records delivery, and acks received', async () => {
  const { active, handle, pty, queueBroadcasts, sent } = makeHarness({ ptyState: 'ready' });
  assert.ok(active);

  await handle({
    type: 'send',
    clientMessageId: 'client-ready',
    text: 'ship it',
  });

  assert.deepEqual(pty.sent, ['ship it']);
  assert.equal(sent[0]?.type, 'send-ack');
  assert.equal(sent[0]?.clientMessageId, 'client-ready');
  assert.equal(sent[0]?.status, 'received');
  const queueItem = sent[0]?.queueItem as { id: ULID; status: string } | undefined;
  assert.equal(queueItem?.status, 'delivered_to_pty');
  assert.equal(getOrchestratorSendQueueRow(queueItem!.id)?.status, 'delivered_to_pty');
  assert.deepEqual(queueBroadcasts.map((item) => item.sessionId), [active.id]);
});

test('busy send queues prompt and acks queued without PTY send', async () => {
  const { active, handle, pty, queueBroadcasts, sent } = makeHarness({ ptyState: 'busy' });
  assert.ok(active);

  await handle({
    type: 'send',
    clientMessageId: 'client-busy',
    text: 'queue it',
  });

  assert.deepEqual(pty.sent, []);
  assert.equal(sent[0]?.type, 'send-ack');
  assert.equal(sent[0]?.status, 'queued');
  const queued = listQueuedOrchestratorSendsForSession(active.id);
  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.clientMessageId, 'client-busy');
  assert.equal(queued[0]?.text, 'queue it');
  assert.deepEqual(queueBroadcasts.map((item) => item.sessionId), [active.id]);
});

test('send with no active session creates session and broadcasts replay checkpoint surfaces', async () => {
  const { broadcasts, handle, project, queueBroadcasts, sent } = makeHarness({
    createActive: false,
    ptyState: 'busy',
  });

  await handle({
    type: 'send',
    clientMessageId: 'client-new-session',
    text: 'first prompt',
  });

  const active = getActiveOrchestratorSession(project.id);
  assert.ok(active);
  assert.equal(sent[0]?.type, 'send-ack');
  assert.equal(sent[0]?.status, 'queued');
  assert.deepEqual(broadcasts.map(({ msg }) => (msg as { type?: string }).type), [
    'session-changed',
    'session-replay',
  ]);
  assert.deepEqual(queueBroadcasts.map((item) => item.sessionId), [active.id, active.id]);
});

test('terminal input, resize, interrupt, and ask replies dispatch to runtime collaborators', async () => {
  const { asks, handle, pty } = makeHarness();

  await handle({ type: 'terminal-input', data: 'abc' });
  await handle({ type: 'resize', cols: 120, rows: 32 });
  await handle({ type: 'interrupt' });
  await handle({ type: 'ask-reply', toolUseId: 'tool-1', answer: 'yes' });

  assert.deepEqual(pty.terminalBytes, ['abc']);
  assert.deepEqual(pty.resized, [{ cols: 120, rows: 32 }]);
  assert.equal(pty.interrupted, true);
  assert.deepEqual(asks, [{ id: 'tool-1', answer: 'yes' }]);
});
