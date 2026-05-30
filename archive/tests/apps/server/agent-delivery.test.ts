// Section 25 Session 7 — v2 delivery primitive contract.
//
// Mirrors v1's agent-inbox-emit.test.ts against the v2 surface. Exercises
// `enqueueAndPush` + `drainPendingForSession` against a real
// ChannelServer + real @pc/db (temp data dir).
//
// Run via:  pnpm --filter @pc/server test
// Or:       pnpm test:unit  (from repo root)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-server-v2-delivery-'));
process.env.PC_DATA_DIR = tmpDir;
delete process.env.PC_DELIVERY_TRANSPORT;

const {
  closeDb,
  runMigrations,
  createProject,
  getInboxRow,
  getAuditForInbox,
  listPendingForSession,
} = await import('@pc/db');
const { ChannelServer } = await import('../src/services/channel-server.ts');
const { drainPendingForSession, enqueueAndPush, readTransportMode } = await import(
  '../src/services/agent-delivery.ts'
);

import type { ChannelEvent } from '../src/services/channel-server.ts';
import type { Stage, ULID } from '@pc/domain';

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

const PORT = 0;
const SESSION_ORCH = 'sess-v2-orch';

interface Captured {
  events: Array<{ projectId: ULID; payload: ChannelEvent }>;
}

let server: InstanceType<typeof ChannelServer>;
let actualPort = 0;
let projectId: ULID;
let slug: string;
const captured: Captured = { events: [] };

before(async () => {
  runMigrations();
  const p = createProject({
    slug: 'v2-delivery',
    name: 'V2 Delivery',
    stages,
    folderPath: tmpDir,
  });
  projectId = p.id as ULID;
  slug = p.slug;

  server = new ChannelServer({
    port: PORT,
    allowedSenders: new Set(),
    onEvent: (pid, payload) => {
      captured.events.push({ projectId: pid, payload });
    },
  });
  server.start();
  for (let i = 0; i < 50; i++) {
    const addr = (
      server as unknown as { httpServer: { address(): { port: number } | null } }
    ).httpServer?.address();
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
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function registerFakeChild(sessionId: string, buf: unknown[]): Promise<WebSocket> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${actualPort}/channel-register?projectId=${projectId}&sessionId=${encodeURIComponent(sessionId)}&slug=${slug}`,
  );
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  ws.on('message', (data) => {
    buf.push(JSON.parse(data.toString()));
  });
  await new Promise((r) => setTimeout(r, 30));
  return ws;
}

test('readTransportMode defaults to hybrid + honors env override', () => {
  delete process.env.PC_DELIVERY_TRANSPORT;
  assert.equal(readTransportMode(), 'hybrid');
  process.env.PC_DELIVERY_TRANSPORT = 'inbox-only';
  assert.equal(readTransportMode(), 'inbox-only');
  process.env.PC_DELIVERY_TRANSPORT = 'channel-only';
  assert.equal(readTransportMode(), 'channel-only');
  process.env.PC_DELIVERY_TRANSPORT = 'bogus';
  assert.equal(readTransportMode(), 'hybrid');
  delete process.env.PC_DELIVERY_TRANSPORT;
});

test('hybrid + live registrant: row written, pushed, flipped delivered, audit recorded with driver=channel', async () => {
  captured.events.length = 0;
  const buf: unknown[] = [];
  const ws = await registerFakeChild(SESSION_ORCH, buf);
  try {
    const result = enqueueAndPush(server, {
      projectId,
      pcSessionId: SESSION_ORCH,
      kind: 'agent-completed',
      slug,
      source: 'agent',
      body: '<channel>completed</channel>',
      sender: 'pc',
    });
    assert.ok(result.inboxId);
    assert.equal(result.channelDelivered, true);

    for (let i = 0; i < 25; i++) {
      if (buf.length > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(buf.length, 1, 'envelope reached the registrant');

    const row = getInboxRow(result.inboxId!);
    assert.ok(row);
    assert.equal(row!.status, 'delivered');
    assert.equal(row!.driver, 'channel');
    assert.ok(row!.deliveredAt);

    const audit = getAuditForInbox(result.inboxId!);
    assert.ok(audit);
    assert.equal(audit!.driver, 'channel');
    // Latency is the wall-clock delta. With clock skew on Windows this can
    // be 0 ms for instantaneous flips — accept >= 0.
    assert.ok(audit!.latencyMs >= 0);
  } finally {
    ws.close();
    await new Promise((r) => setTimeout(r, 30));
  }
});

test('hybrid + no registrant: row written, push fails, row stays pending for hook drain', () => {
  const result = enqueueAndPush(server, {
    projectId,
    pcSessionId: 'sess-v2-no-bridge',
    kind: 'agent-failed',
    slug,
    source: 'agent',
    body: '<channel>failed</channel>',
    sender: 'pc',
  });
  assert.ok(result.inboxId);
  assert.equal(result.channelDelivered, false);

  const row = getInboxRow(result.inboxId!);
  assert.ok(row);
  assert.equal(row!.status, 'pending', 'row stays pending — UserPromptSubmit hook will drain');
  assert.equal(row!.driver, null);
  assert.equal(row!.deliveredAt, null);

  // No audit row should exist yet — v2 writes audit only on successful delivery.
  const audit = getAuditForInbox(result.inboxId!);
  assert.equal(audit, null);
});

test('inbox-only mode: row written, channel push skipped, no audit', () => {
  process.env.PC_DELIVERY_TRANSPORT = 'inbox-only';
  try {
    const result = enqueueAndPush(server, {
      projectId,
      pcSessionId: 'sess-v2-inbox-only',
      kind: 'agent-queued-started',
      slug,
      source: 'agent',
      body: '<channel>queued-started</channel>',
      sender: 'pc',
    });
    assert.ok(result.inboxId);
    assert.equal(result.channelDelivered, false);

    const row = getInboxRow(result.inboxId!);
    assert.equal(row!.status, 'pending');
    assert.equal(getAuditForInbox(result.inboxId!), null);
  } finally {
    delete process.env.PC_DELIVERY_TRANSPORT;
  }
});

test('channel-only mode: inbox skipped, only channel push attempted', async () => {
  process.env.PC_DELIVERY_TRANSPORT = 'channel-only';
  const buf: unknown[] = [];
  const session = 'sess-v2-channel-only';
  const ws = await registerFakeChild(session, buf);
  try {
    const result = enqueueAndPush(server, {
      projectId,
      pcSessionId: session,
      kind: 'agent-completed',
      slug,
      source: 'agent',
      body: '<channel>channel-only</channel>',
      sender: 'pc',
    });
    assert.equal(result.inboxId, null, 'no inbox row written in channel-only mode');
    assert.equal(result.channelDelivered, true);

    for (let i = 0; i < 25; i++) {
      if (buf.length > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(buf.length, 1, 'envelope reached the registrant');
  } finally {
    delete process.env.PC_DELIVERY_TRANSPORT;
    ws.close();
    await new Promise((r) => setTimeout(r, 30));
  }
});

test('drainPendingForSession: registers bridge → drains all pending rows for that session', async () => {
  // Enqueue 3 rows for a target session with no registrant yet. Then connect
  // the bridge + call drain manually.
  const session = 'sess-v2-drain';
  const enq = (body: string) =>
    enqueueAndPush(server, {
      projectId,
      pcSessionId: session,
      kind: 'agent-completed',
      slug,
      source: 'agent',
      body,
      sender: 'pc',
    });
  enq('<channel>a</channel>');
  enq('<channel>b</channel>');
  enq('<channel>c</channel>');

  const pendingBefore = listPendingForSession(session);
  assert.equal(pendingBefore.length, 3);

  const buf: unknown[] = [];
  const ws = await registerFakeChild(session, buf);
  try {
    const drain = drainPendingForSession(server, projectId, session, slug);
    assert.equal(drain.attempted, 3);
    assert.equal(drain.drained, 3);

    for (let i = 0; i < 25; i++) {
      if (buf.length >= 3) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(buf.length, 3, 'all three envelopes reached the registrant');

    const pendingAfter = listPendingForSession(session);
    assert.equal(pendingAfter.length, 0);
  } finally {
    ws.close();
    await new Promise((r) => setTimeout(r, 30));
  }
});

test('drainPendingForSession in channel-only mode is a no-op', () => {
  process.env.PC_DELIVERY_TRANSPORT = 'channel-only';
  try {
    const drain = drainPendingForSession(server, projectId, 'whatever', slug);
    assert.equal(drain.attempted, 0);
    assert.equal(drain.drained, 0);
  } finally {
    delete process.env.PC_DELIVERY_TRANSPORT;
  }
});
