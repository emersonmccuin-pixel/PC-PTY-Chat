// Section 16b.3.1 / 18.5a — exercises ChannelServer.emitToSession end-to-end
// through a real WS registrant. Pins the contract the agent comms HTTP
// endpoints depend on: programmatic emit targets a specific
// (projectId, sessionId) registrant + broadcasts via onEvent to UI
// subscribers. 18.5a re-key by sessionId test added: a second registrant on
// the same project but a different sessionId no longer kicks the first off
// the channel.

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

import { ChannelServer, type ChannelEvent } from '../src/services/channel-server.ts';
import type { ULID } from '@pc/domain';

const PORT = 0; // 0 ⇒ let the OS pick a free port
const SLUG = 'test-emit-slug';
const PROJECT_ID = '01TESTEMITPROJECT0000000000' as ULID;
const SESSION_A = 'sess-a-orchestrator';
const SESSION_B = 'sess-b-orchestrator';

interface Captured {
  events: Array<{ projectId: ULID; payload: ChannelEvent }>;
  wsMessages: unknown[];
}

let server: ChannelServer;
let actualPort = 0;
const captured: Captured = { events: [], wsMessages: [] };

before(async () => {
  server = new ChannelServer({
    port: PORT,
    allowedSenders: new Set(),
    onEvent: (projectId, payload) => {
      captured.events.push({ projectId, payload });
    },
  });
  server.start();
  // Hono/Node's `serve` callback fires after bind — we wait for the
  // dynamically-assigned port via a brief probe loop.
  for (let i = 0; i < 50; i++) {
    const addr = (server as unknown as { httpServer: { address(): { port: number } | null } })
      .httpServer?.address();
    if (addr && typeof addr === 'object' && 'port' in addr && addr.port > 0) {
      actualPort = addr.port;
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(actualPort > 0, 'channel server did not bind a port');
});

after(() => {
  server.shutdown();
});

async function registerFakeChild(
  sessionId: string,
  buf: unknown[] = captured.wsMessages,
): Promise<WebSocket> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${actualPort}/channel-register?projectId=${PROJECT_ID}&sessionId=${encodeURIComponent(sessionId)}&slug=${SLUG}`,
  );
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  ws.on('message', (data) => {
    buf.push(JSON.parse(data.toString()));
  });
  // Give the server a tick to register the WS in its map.
  await new Promise((r) => setTimeout(r, 30));
  return ws;
}

test('emitToSession delivers envelope to registered child + invokes onEvent', async () => {
  captured.events.length = 0;
  captured.wsMessages.length = 0;

  const ws = await registerFakeChild(SESSION_A);
  try {
    const delivered = server.emitToSession({
      projectId: PROJECT_ID,
      recipientSessionId: SESSION_A,
      slug: SLUG,
      source: 'agent',
      body: 'hello agent',
      sender: 'pc',
    });
    assert.equal(delivered, true);

    // Give the WS a tick to receive.
    for (let i = 0; i < 25; i++) {
      if (captured.wsMessages.length > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.equal(captured.events.length, 1);
    assert.equal(captured.events[0]!.projectId, PROJECT_ID);
    assert.equal(captured.events[0]!.payload.body, 'hello agent');
    assert.equal(captured.events[0]!.payload.source, 'agent');
    assert.equal(captured.events[0]!.payload.sender, 'pc');

    assert.equal(captured.wsMessages.length, 1);
    const env = captured.wsMessages[0] as Record<string, unknown>;
    assert.equal(env.type, 'channel-event');
    assert.equal(env.content, 'hello agent');
    assert.equal(env.source, 'agent');
    assert.equal(env.path, `/channel/${SLUG}/agent`);
    assert.equal(env.method, 'POST');
  } finally {
    ws.close();
    await new Promise((r) => setTimeout(r, 30));
  }
});

test('emitToSession returns false when no child registered (UI broadcast still fires)', async () => {
  captured.events.length = 0;
  captured.wsMessages.length = 0;

  const delivered = server.emitToSession({
    projectId: PROJECT_ID,
    recipientSessionId: SESSION_A,
    slug: SLUG,
    source: 'agent',
    body: 'unregistered',
    sender: 'pc',
  });
  assert.equal(delivered, false);
  assert.equal(captured.events.length, 1, 'onEvent fired despite missing child');
  assert.equal(captured.events[0]!.payload.body, 'unregistered');
});

test('18.5a — two registrants for same project but different sessions coexist; emit routes by sessionId', async () => {
  captured.events.length = 0;
  captured.wsMessages.length = 0;
  const bufA: unknown[] = [];
  const bufB: unknown[] = [];

  const wsA = await registerFakeChild(SESSION_A, bufA);
  const wsB = await registerFakeChild(SESSION_B, bufB);
  try {
    const aDelivered = server.emitToSession({
      projectId: PROJECT_ID,
      recipientSessionId: SESSION_A,
      slug: SLUG,
      source: 'agent',
      body: 'for A',
      sender: 'pc',
    });
    const bDelivered = server.emitToSession({
      projectId: PROJECT_ID,
      recipientSessionId: SESSION_B,
      slug: SLUG,
      source: 'agent',
      body: 'for B',
      sender: 'pc',
    });
    assert.equal(aDelivered, true);
    assert.equal(bDelivered, true);

    for (let i = 0; i < 25; i++) {
      if (bufA.length > 0 && bufB.length > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.equal(bufA.length, 1, 'session A received exactly its own envelope');
    assert.equal((bufA[0] as Record<string, unknown>).content, 'for A');
    assert.equal(bufB.length, 1, 'session B received exactly its own envelope');
    assert.equal((bufB[0] as Record<string, unknown>).content, 'for B');
  } finally {
    wsA.close();
    wsB.close();
    await new Promise((r) => setTimeout(r, 30));
  }
});

test('register without sessionId is rejected', async () => {
  const ws = new WebSocket(
    `ws://127.0.0.1:${actualPort}/channel-register?projectId=${PROJECT_ID}&slug=${SLUG}`,
  );
  const closeCode = await new Promise<number>((res) => {
    ws.once('close', (code) => res(code));
    ws.once('error', () => res(-1));
  });
  assert.equal(closeCode, 1008, 'missing sessionId must close with 1008');
});
