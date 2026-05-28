import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { OrchestratorSession, ULID } from '@pc/domain';
import type { PublicRuntimeSnapshot } from '../src/services/orchestrator-runtime-snapshot.ts';
import type {
  RuntimeHostMessagePtySession,
} from '../src/features/runtime-host/websocket-message.ts';
import {
  handleRuntimeHostWsConnection,
  runWsKeepaliveSweep,
  type KeepaliveClient,
  type RuntimeHostWebSocketLike,
  type RuntimeHostWebSocketRuntime,
} from '../src/features/runtime-host/websocket-server.ts';

class FakeWs extends EventEmitter implements RuntimeHostWebSocketLike {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = this.OPEN;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = this.CLOSED;
    this.closed = { code, reason };
  }
}

const projectId = '01HWSRUNTIMEHOSTWS0000000000' as ULID;
const session = {
  id: '01HWSRUNTIMEHOSTSESSION00000' as ULID,
  projectId,
  provider: 'claude',
  providerSessionId: 'provider-ws-server',
  model: null,
  title: null,
  status: 'active',
  endedReason: null,
  startedAt: 1,
  endedAt: null,
  deletedAt: null,
  jsonlPath: null,
  jsonlLineCursor: 0,
} satisfies OrchestratorSession;

function makeRuntime() {
  const pty: RuntimeHostMessagePtySession = {
    getState: () => 'ready',
    send: () => 'ok',
    interrupt: () => undefined,
    writeRaw: () => true,
  };
  return {
    ensureActiveSession: () => session,
    ptySession: () => pty,
    resizeOrchestrator: () => undefined,
    sessionDataPath: () => '',
  } satisfies RuntimeHostWebSocketRuntime<RuntimeHostMessagePtySession>;
}

function makeDeps(options: { runtime?: ReturnType<typeof makeRuntime> | null } = {}) {
  const runtime = options.runtime === undefined ? makeRuntime() : options.runtime;
  const order: string[] = [];
  const detached: ULID[] = [];
  const connectSnapshots: Array<{ projectId: ULID; runtime: unknown }> = [];
  const pendingReplies: Array<{ id: string; answer: string }> = [];
  return {
    attachPtyHandlers: () => undefined,
    broadcastSendQueueSnapshot: () => undefined,
    broadcastTo: () => undefined,
    connectSnapshots,
    detached,
    ensureOrchestratorPty: () => {
      const live = runtime?.ptySession();
      if (!live) throw new Error('no pty');
      return live;
    },
    order,
    pendingReplies,
    resolvePendingAsk: (id: string, answer: string) => pendingReplies.push({ id, answer }),
    resolveProject: (id: string) => (id === projectId ? runtime : null),
    runtime,
    runtimeSnapshotPayload: (): PublicRuntimeSnapshot => ({
      type: 'runtime-state',
      sessionId: session.id,
      provider: 'claude',
      providerSessionId: session.providerSessionId,
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
      replayExists: false,
      replayLineCount: 0,
      replayHighWaterSeq: 0,
      queueDepth: 0,
      queue: [],
    }),
    sendConnectSnapshot: (input: {
      projectId: ULID;
      runtime: RuntimeHostWebSocketRuntime<RuntimeHostMessagePtySession>;
      send(envelope: Record<string, unknown>): void;
    }): OrchestratorSession => {
      order.push('connect');
      connectSnapshots.push({ projectId: input.projectId, runtime: input.runtime });
      input.send({ projectId: input.projectId, type: 'connect-snapshot' });
      return session;
    },
    startOrchestratorPtyInBackground: () => undefined,
    subscribe: (id: ULID, ws: RuntimeHostWebSocketLike) => {
      order.push('subscribe');
      assert.equal(id, projectId);
      assert.equal(ws.readyState, ws.OPEN);
      return () => detached.push(id);
    },
  };
}

test('connection without projectId closes with policy violation', () => {
  const ws = new FakeWs();
  const deps = makeDeps();

  const accepted = handleRuntimeHostWsConnection({
    ...deps,
    ws,
    request: { url: '/ws' },
    handleWsMessage: () => undefined,
  });

  assert.equal(accepted, false);
  assert.deepEqual(ws.closed, {
    code: 1008,
    reason: 'projectId query param required',
  });
  assert.deepEqual(deps.order, []);
});

test('connection for unknown project closes with policy violation', () => {
  const ws = new FakeWs();
  const deps = makeDeps({ runtime: null });

  const accepted = handleRuntimeHostWsConnection({
    ...deps,
    ws,
    request: { url: `/ws?projectId=${projectId}` },
    handleWsMessage: () => undefined,
  });

  assert.equal(accepted, false);
  assert.deepEqual(ws.closed, {
    code: 1008,
    reason: `unknown project: ${projectId}`,
  });
  assert.deepEqual(deps.order, []);
});

test('accepted connection subscribes, sends connect snapshot, delegates messages, and detaches on close', () => {
  const ws = new FakeWs();
  const deps = makeDeps();
  const messageInputs: Array<{ projectId: ULID; raw: string; runtime: unknown }> = [];

  const accepted = handleRuntimeHostWsConnection({
    ...deps,
    ws,
    request: { url: `/ws?projectId=${projectId}` },
    handleWsMessage: (input) => {
      messageInputs.push({
        projectId: input.projectId,
        raw: input.raw,
        runtime: input.runtime,
      });
      input.resolvePendingAsk('ask-1', 'yes');
      input.send({ projectId: input.projectId, type: 'message-ack' });
    },
  });

  assert.equal(accepted, true);
  assert.deepEqual(deps.order, ['subscribe', 'connect']);
  assert.deepEqual(deps.connectSnapshots, [{ projectId, runtime: deps.runtime }]);
  assert.deepEqual(JSON.parse(ws.sent[0] ?? '{}'), {
    projectId,
    type: 'connect-snapshot',
  });

  ws.emit('message', Buffer.from('{"type":"client-ping"}'));

  assert.deepEqual(messageInputs, [
    {
      projectId,
      raw: '{"type":"client-ping"}',
      runtime: deps.runtime,
    },
  ]);
  assert.deepEqual(deps.pendingReplies, [{ id: 'ask-1', answer: 'yes' }]);
  assert.deepEqual(JSON.parse(ws.sent[1] ?? '{}'), {
    projectId,
    type: 'message-ack',
  });

  ws.emit('close');

  assert.deepEqual(deps.detached, [projectId]);
});

class FakeKeepaliveClient implements KeepaliveClient {
  isAlive?: boolean;
  pings = 0;
  terminated = 0;
  constructor(isAlive?: boolean) {
    this.isAlive = isAlive;
  }
  ping(): void {
    this.pings++;
  }
  terminate(): void {
    this.terminated++;
  }
}

test('keepalive sweep pings live clients and marks them pending', () => {
  const fresh = new FakeKeepaliveClient(true);
  runWsKeepaliveSweep([fresh]);
  assert.equal(fresh.pings, 1);
  assert.equal(fresh.terminated, 0);
  // Marked not-alive so the next sweep terminates it unless a pong arrives.
  assert.equal(fresh.isAlive, false);
});

test('keepalive sweep terminates clients that missed a pong', () => {
  const stale = new FakeKeepaliveClient(false);
  runWsKeepaliveSweep([stale]);
  assert.equal(stale.terminated, 1);
  assert.equal(stale.pings, 0);
});

test('keepalive sweep terminates a client that stays unresponsive across two passes', () => {
  const client = new FakeKeepaliveClient(true);
  runWsKeepaliveSweep([client]); // ping, mark not-alive
  runWsKeepaliveSweep([client]); // no pong arrived → terminate
  assert.equal(client.pings, 1);
  assert.equal(client.terminated, 1);
});

test('keepalive sweep keeps a client alive when its pong flips isAlive back', () => {
  const client = new FakeKeepaliveClient(true);
  runWsKeepaliveSweep([client]); // ping, mark not-alive
  client.isAlive = true; // simulate pong listener firing
  runWsKeepaliveSweep([client]); // still alive → ping again, not terminate
  assert.equal(client.pings, 2);
  assert.equal(client.terminated, 0);
});

test('message send callback does not write when socket is no longer open', () => {
  const ws = new FakeWs();
  const deps = makeDeps();

  handleRuntimeHostWsConnection({
    ...deps,
    ws,
    request: { url: `/ws?projectId=${projectId}` },
    handleWsMessage: (input) => {
      input.send({ projectId: input.projectId, type: 'late-ack' });
    },
  });
  ws.sent = [];
  ws.readyState = ws.CLOSED;

  ws.emit('message', Buffer.from('{"type":"client-ping"}'));

  assert.deepEqual(ws.sent, []);
});
