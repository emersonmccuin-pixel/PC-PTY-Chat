import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ULID } from '@pc/domain';
import type {
  RuntimeHostPtyLifecycleSnapshots,
  RuntimeHostPtyRuntime,
  RuntimeHostPtySession,
} from '../src/features/runtime-host/pty-handlers.ts';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-runtime-host-pty-handlers-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createOrchestratorSession,
  createProject,
  enqueueOrchestratorSend,
  getActiveOrchestratorSession,
  getOrchestratorSendQueueRow,
  getOrchestratorSession,
  recordDeliveredOrchestratorSend,
  runMigrations,
  setOrchestratorSessionJsonlCursor,
  setOrchestratorSessionJsonlPath,
} = await import('@pc/db');
const {
  deliverNextQueuedPrompt,
  maybeAdvanceSendQueueConfirmation,
} = await import('../src/services/orchestrator-send-queue-delivery.ts');
const {
  createRuntimeHostPtyController,
} = await import('../src/features/runtime-host/pty-handlers.ts');

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

class FakePty extends EventEmitter implements RuntimeHostPtySession {
  state = 'ready';
  jsonlPath: string | null = null;
  sent: string[] = [];

  getState(): string {
    return this.state;
  }

  getJsonlPath(): string | null {
    return this.jsonlPath;
  }

  send(text: string): string {
    this.sent.push(text);
    return 'ok';
  }
}

class FakeSnapshots implements RuntimeHostPtyLifecycleSnapshots {
  calls: Array<{
    name: string;
    projectId: ULID;
    code?: number;
    signal?: string;
    err?: unknown;
  }> = [];

  noteActivity(projectId: ULID): void {
    this.calls.push({ name: 'noteActivity', projectId });
  }

  noteJsonl(projectId: ULID): void {
    this.calls.push({ name: 'noteJsonl', projectId });
  }

  clearFailure(projectId: ULID): void {
    this.calls.push({ name: 'clearFailure', projectId });
  }

  clearExit(projectId: ULID): void {
    this.calls.push({ name: 'clearExit', projectId });
  }

  noteFailure(projectId: ULID, err: unknown): void {
    this.calls.push({ name: 'noteFailure', projectId, err });
  }

  noteExit(projectId: ULID, code: number | undefined, signal: string | undefined): void {
    this.calls.push({ name: 'noteExit', projectId, code, signal });
  }
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(label);
}

function makeHarness() {
  seq += 1;
  const project = createProject({
    slug: `runtime-host-pty-${Date.now().toString(36)}-${seq}`,
    name: 'Runtime Host PTY',
    stages,
    folderPath: join(tmpDir, `project-${seq}`),
  });
  const session = createOrchestratorSession({
    projectId: project.id,
    providerSessionId: `provider-pty-${seq}`,
  });
  const pty = new FakePty();
  const runtime = {
    folderPath: project.folderPath,
    sessionDataPath: (sessionId: ULID) => {
      const dir = join(tmpDir, 'sessions', sessionId);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    orchestratorPtyState: () =>
      pty.state as ReturnType<RuntimeHostPtyRuntime<FakePty>['orchestratorPtyState']>,
    orchestratorRuntimeSnapshot: () => ({
      spawnAttemptId: 'spawn-1',
      spawnAttempt: 1,
      lastReadyAt: 1_000,
      nextRetryAt: null,
      runtimeFailureReason: null,
    }),
    ensurePty: () => pty,
    ptySession: () => pty,
  } satisfies RuntimeHostPtyRuntime<FakePty>;
  const snapshots = new FakeSnapshots();
  const broadcasts: Array<{ projectId: ULID; msg: unknown }> = [];
  const runtimeBroadcasts: Array<{ projectId: ULID; runtime: typeof runtime }> = [];
  const queueBroadcasts: Array<{ projectId: ULID; sessionId: ULID }> = [];
  const titleEvents: unknown[] = [];
  const aiTitleEvents: unknown[] = [];
  const summaryEvents: unknown[] = [];
  const logs: string[] = [];
  const controller = createRuntimeHostPtyController<FakePty, typeof runtime>({
    runtimeSnapshots: snapshots,
    getActiveOrchestratorSession,
    setOrchestratorSessionJsonlCursor,
    setOrchestratorSessionJsonlPath,
    broadcastTo: (projectId, msg) => broadcasts.push({ projectId, msg }),
    broadcastRuntimeSnapshot: (projectId, targetRuntime) => {
      runtimeBroadcasts.push({ projectId, runtime: targetRuntime });
    },
    broadcastSendQueueSnapshot: (projectId, sessionId) => {
      queueBroadcasts.push({ projectId, sessionId });
    },
    deliverNextQueuedPrompt,
    maybeAdvanceSendQueueConfirmation,
    maybeSetSessionTitle: (_projectId, event) => titleEvents.push(event),
    maybeApplyAiTitle: (_projectId, event) => aiTitleEvents.push(event),
    maybePersistPostTurnSummary: (_projectId, event) => summaryEvents.push(event),
    logger: {
      error: (message?: unknown) => logs.push(String(message)),
      log: (message?: unknown) => logs.push(String(message)),
    },
  });
  controller.attachPtyHandlers(project.id, runtime, pty);
  return {
    aiTitleEvents,
    broadcasts,
    controller,
    logs,
    project,
    pty,
    queueBroadcasts,
    runtime,
    runtimeBroadcasts,
    session,
    snapshots,
    summaryEvents,
    titleEvents,
  };
}

test('ready state clears failure/exit, broadcasts state/runtime snapshot, and drains queued prompt', async () => {
  const { broadcasts, controller, project, pty, runtime, runtimeBroadcasts, session, snapshots } =
    makeHarness();
  const queued = enqueueOrchestratorSend({
    projectId: project.id,
    sessionId: session.id,
    clientMessageId: 'client-ready-drain',
    text: 'queued prompt',
    status: 'queued_busy',
  });

  controller.attachPtyHandlers(project.id, runtime, pty);
  pty.emit('state', 'ready');

  await waitFor(
    () => getOrchestratorSendQueueRow(queued.id)?.status === 'delivered_to_pty',
    'queued prompt was not delivered after ready state',
  );

  assert.deepEqual(pty.sent, ['queued prompt']);
  assert.deepEqual(
    snapshots.calls.map((call) => call.name),
    ['noteActivity', 'clearFailure', 'clearExit'],
  );
  assert.deepEqual(
    broadcasts.map(({ msg }) => msg),
    [{ type: 'state', state: 'ready' }],
  );
  assert.deepEqual(runtimeBroadcasts.map(({ projectId }) => projectId), [project.id]);
});

test('jsonl-event broadcasts replay metadata, updates cursor, advances queue confirmation, and broadcasts runtime snapshot', async () => {
  const {
    aiTitleEvents,
    broadcasts,
    project,
    pty,
    queueBroadcasts,
    runtimeBroadcasts,
    session,
    snapshots,
    summaryEvents,
    titleEvents,
  } = makeHarness();
  const delivered = recordDeliveredOrchestratorSend({
    projectId: project.id,
    sessionId: session.id,
    clientMessageId: 'client-observed',
    text: 'observed prompt',
  });
  const event = { kind: 'jsonl-user', text: 'observed prompt' };
  const replay = {
    id: `${session.id}:4`,
    sessionId: session.id,
    seq: 4,
    kind: 'jsonl-user' as const,
    source: { kind: 'claude-jsonl' as const, cursor: 42 },
  };

  pty.emit('jsonl-event', event, replay);

  // Stage 1: the matched send's clientMessageId is stamped onto the canonical
  // jsonl-user envelope so the client can reconcile its placeholder by id.
  assert.deepEqual(broadcasts[0]?.msg, {
    type: 'jsonl',
    event,
    ...replay,
    clientMessageId: 'client-observed',
  });
  assert.equal(getOrchestratorSession(session.id)?.jsonlLineCursor, 42);
  assert.equal(getOrchestratorSendQueueRow(delivered.id)?.status, 'observed_in_jsonl');
  assert.equal(queueBroadcasts.some((item) => item.sessionId === session.id), true);
  assert.deepEqual(runtimeBroadcasts.map(({ projectId }) => projectId), [project.id]);
  assert.deepEqual(snapshots.calls.map((call) => call.name), ['noteJsonl']);
  assert.deepEqual(summaryEvents, [event]);
  assert.deepEqual(titleEvents, [event]);
  assert.deepEqual(aiTitleEvents, [event]);
});

test('jsonl-event without a matching delivered send broadcasts no clientMessageId', () => {
  const { broadcasts, pty } = makeHarness();
  const event = { kind: 'jsonl-user', text: 'no matching queued send' };
  const replay = {
    id: 'sess:9',
    sessionId: 'sess',
    seq: 9,
    kind: 'jsonl-user' as const,
    source: { kind: 'claude-jsonl' as const, cursor: 9 },
  };

  pty.emit('jsonl-event', event, replay);

  assert.deepEqual(broadcasts[0]?.msg, { type: 'jsonl', event, ...replay });
  assert.equal(
    Object.prototype.hasOwnProperty.call(broadcasts[0]?.msg as object, 'clientMessageId'),
    false,
  );
});

test('jsonl-path-resolved persists path and broadcasts runtime snapshot', () => {
  const { project, pty, runtimeBroadcasts, session, snapshots } = makeHarness();
  const jsonlPath = join(tmpDir, 'raw-jsonl', `${session.id}.jsonl`);

  pty.emit('jsonl-path-resolved', jsonlPath);

  assert.equal(getOrchestratorSession(session.id)?.jsonlPath, jsonlPath);
  assert.deepEqual(snapshots.calls.map((call) => call.name), ['noteActivity']);
  assert.deepEqual(runtimeBroadcasts.map(({ projectId }) => projectId), [project.id]);
});

test('exit records lifecycle and broadcasts exit/runtime snapshot', () => {
  const { broadcasts, logs, project, pty, runtimeBroadcasts, snapshots } = makeHarness();

  pty.emit('exit', 7, 'SIGTERM');

  assert.deepEqual(snapshots.calls, [
    { name: 'noteExit', projectId: project.id, code: 7, signal: 'SIGTERM' },
  ]);
  assert.deepEqual(broadcasts.map(({ msg }) => msg), [
    { type: 'exit', code: 7, signal: 'SIGTERM' },
  ]);
  assert.deepEqual(runtimeBroadcasts.map(({ projectId }) => projectId), [project.id]);
  assert.match(logs[0] ?? '', new RegExp(`${project.id} session exited code=7 signal=SIGTERM`));
});
