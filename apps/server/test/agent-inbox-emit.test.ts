// Section 18.3 — hybrid emit primitive + auto-flush on registration.
// Exercises `enqueueAndPush` + `drainPendingForSession` against a real
// `ChannelServer` (registered fake WS) and a real `@pc/db` (temp data dir).
//
// Run via:  pnpm --filter @pc/server test
// Or:       pnpm test:unit  (from repo root)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-server-inbox-emit-'));
process.env.PC_DATA_DIR = tmpDir;
// Make sure we run in hybrid mode regardless of the shell env. Per-test
// overrides set this explicitly for the kill-switch coverage.
delete process.env.PC_DELIVERY_TRANSPORT;

// Dynamic-import so PC_DATA_DIR is in place before @pc/db opens the file.
const {
  closeDb,
  runMigrations,
  createProject,
  listPendingForSession,
  getInboxRow,
  getAuditForInbox,
} = await import('@pc/db');
const { ChannelServer } = await import('../src/services/channel-server.ts');
const { drainPendingForSession, enqueueAndPush, readTransportMode } = await import(
  '../src/services/agent-inbox-emit.ts'
);

import type { ChannelEvent } from '../src/services/channel-server.ts';
import type { Stage, ULID } from '@pc/domain';

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

const PORT = 0;
const SESSION_ORCH = 'sess-emit-orchestrator';

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
    slug: 'inbox-emit',
    name: 'Inbox Emit',
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

test('readTransportMode defaults to hybrid', () => {
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

test('hybrid + live registrant: row written, pushed, flipped delivered, audit recorded', async () => {
  captured.events.length = 0;
  const buf: unknown[] = [];
  const ws = await registerFakeChild(SESSION_ORCH, buf);
  try {
    const result = enqueueAndPush(server, {
      projectId,
      recipientSessionId: SESSION_ORCH,
      eventKind: 'agent-completed',
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
    assert.ok(row!.deliveredAt);

    const audit = getAuditForInbox(result.inboxId!);
    assert.ok(audit);
    assert.equal(audit!.driver, 'autonomous');
    assert.equal(audit!.channelPushSucceeded, true);
    assert.ok(audit!.channelPushAttemptedAt);
    assert.equal(audit!.hookDrainedAt, null);
  } finally {
    ws.close();
    await new Promise((r) => setTimeout(r, 30));
  }
});

test('hybrid + no registrant: row written, push fails, row stays pending for hook drain', () => {
  const result = enqueueAndPush(server, {
    projectId,
    recipientSessionId: 'sess-no-bridge',
    eventKind: 'agent-failed',
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
  assert.equal(row!.deliveredAt, null);

  const audit = getAuditForInbox(result.inboxId!);
  assert.ok(audit);
  assert.equal(audit!.driver, 'unknown', 'driver stays unknown until drain path lands');
  assert.equal(audit!.channelPushSucceeded, false);
  assert.ok(audit!.channelPushAttemptedAt);
});

test('inbox-only mode: row written, channel push skipped', () => {
  process.env.PC_DELIVERY_TRANSPORT = 'inbox-only';
  try {
    const result = enqueueAndPush(server, {
      projectId,
      recipientSessionId: 'sess-inbox-only',
      eventKind: 'agent-acked',
      slug,
      source: 'agent',
      body: '<channel>acked</channel>',
      sender: 'pc',
    });
    assert.ok(result.inboxId);
    assert.equal(result.channelDelivered, false);

    const row = getInboxRow(result.inboxId!);
    assert.equal(row!.status, 'pending');

    const audit = getAuditForInbox(result.inboxId!);
    // channel-push attempt never happened.
    assert.equal(audit!.channelPushAttemptedAt, null);
    assert.equal(audit!.channelPushSucceeded, null);
    assert.equal(audit!.driver, 'unknown');
  } finally {
    delete process.env.PC_DELIVERY_TRANSPORT;
  }
});

test('channel-only mode: inbox skipped, raw emit only', async () => {
  process.env.PC_DELIVERY_TRANSPORT = 'channel-only';
  const buf: unknown[] = [];
  const ws = await registerFakeChild('sess-channel-only', buf);
  try {
    const result = enqueueAndPush(server, {
      projectId,
      recipientSessionId: 'sess-channel-only',
      eventKind: 'agent-completed',
      slug,
      source: 'agent',
      body: '<channel>raw</channel>',
      sender: 'pc',
    });
    assert.equal(result.inboxId, null, 'no inbox row written in channel-only mode');
    assert.equal(result.channelDelivered, true);

    for (let i = 0; i < 25; i++) {
      if (buf.length > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(buf.length, 1);

    const pending = listPendingForSession('sess-channel-only');
    assert.equal(pending.length, 0, 'inbox stays empty');
  } finally {
    ws.close();
    await new Promise((r) => setTimeout(r, 30));
    delete process.env.PC_DELIVERY_TRANSPORT;
  }
});

test('drainPendingForSession flushes pending rows to a freshly registered bridge', async () => {
  const SESSION = 'sess-flush-target';
  // Pre-stage two pending rows (no registrant yet — channel push fails).
  const r1 = enqueueAndPush(server, {
    projectId,
    recipientSessionId: SESSION,
    eventKind: 'agent-completed',
    slug,
    source: 'agent',
    body: '<channel>flush row 1</channel>',
    sender: 'pc',
  });
  const r2 = enqueueAndPush(server, {
    projectId,
    recipientSessionId: SESSION,
    eventKind: 'agent-failed',
    slug,
    source: 'agent',
    body: '<channel>flush row 2</channel>',
    sender: 'pc',
  });
  assert.equal(r1.channelDelivered, false);
  assert.equal(r2.channelDelivered, false);

  // Bridge comes up; auto-flush drains via the helper.
  const buf: unknown[] = [];
  const ws = await registerFakeChild(SESSION, buf);
  try {
    const result = drainPendingForSession(server, projectId, SESSION, slug);
    assert.equal(result.attempted, 2);
    assert.equal(result.drained, 2);

    for (let i = 0; i < 25; i++) {
      if (buf.length >= 2) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(buf.length, 2, 'both envelopes received in order');
    assert.equal((buf[0] as Record<string, unknown>).content, '<channel>flush row 1</channel>');
    assert.equal((buf[1] as Record<string, unknown>).content, '<channel>flush row 2</channel>');

    // Both rows now delivered + audit reflects autonomous driver.
    const row1 = getInboxRow(r1.inboxId!);
    const row2 = getInboxRow(r2.inboxId!);
    assert.equal(row1!.status, 'delivered');
    assert.equal(row2!.status, 'delivered');
    const audit1 = getAuditForInbox(r1.inboxId!);
    const audit2 = getAuditForInbox(r2.inboxId!);
    assert.equal(audit1!.driver, 'autonomous');
    assert.equal(audit2!.driver, 'autonomous');

    // Re-running drain is a no-op (rows already delivered).
    const again = drainPendingForSession(server, projectId, SESSION, slug);
    assert.equal(again.attempted, 0);
    assert.equal(again.drained, 0);
  } finally {
    ws.close();
    await new Promise((r) => setTimeout(r, 30));
  }
});

test('channel-server fires onRegister callback on fresh WS register', async () => {
  const calls: Array<{ projectId: string; sessionId: string; slug: string }> = [];
  const local = new ChannelServer({
    port: 0,
    allowedSenders: new Set(),
    onEvent: () => {},
    onRegister: (args) => {
      calls.push(args);
    },
  });
  local.start();
  let port = 0;
  for (let i = 0; i < 50; i++) {
    const addr = (local as unknown as { httpServer: { address(): { port: number } | null } })
      .httpServer?.address();
    if (addr && typeof addr === 'object' && 'port' in addr && addr.port > 0) {
      port = addr.port;
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(port > 0);

  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/channel-register?projectId=${projectId}&sessionId=cb-test&slug=${slug}`,
  );
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  // setImmediate defers onRegister; wait a couple ticks.
  for (let i = 0; i < 10; i++) {
    if (calls.length > 0) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.projectId, projectId);
  assert.equal(calls[0]!.sessionId, 'cb-test');
  assert.equal(calls[0]!.slug, slug);

  ws.close();
  await new Promise((r) => setTimeout(r, 30));
  local.shutdown();
});
