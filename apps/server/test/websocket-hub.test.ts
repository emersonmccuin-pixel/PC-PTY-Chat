import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ProjectWebSocketHub, type WebSocketLike } from '../src/services/websocket-hub.ts';

class FakeSocket implements WebSocketLike {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = this.OPEN;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = this.CLOSED;
  }
}

test('broadcast fans out to every open subscriber for a project', () => {
  const hub = new ProjectWebSocketHub<string>();
  const a = new FakeSocket();
  const b = new FakeSocket();
  hub.subscribe('p1', a);
  hub.subscribe('p1', b);

  const sent = hub.broadcast('p1', { type: 'state', state: 'ready' });

  assert.equal(sent, 2);
  assert.deepEqual(JSON.parse(a.sent[0]!), { projectId: 'p1', type: 'state', state: 'ready' });
  assert.deepEqual(JSON.parse(b.sent[0]!), { projectId: 'p1', type: 'state', state: 'ready' });
});

test('detaching one subscriber does not detach the surviving project client', () => {
  const hub = new ProjectWebSocketHub<string>();
  const a = new FakeSocket();
  const b = new FakeSocket();
  const detachA = hub.subscribe('p1', a);
  hub.subscribe('p1', b);

  detachA();
  const sent = hub.broadcast('p1', { type: 'session-title-updated' });

  assert.equal(sent, 1);
  assert.equal(a.sent.length, 0);
  assert.deepEqual(JSON.parse(b.sent[0]!), { projectId: 'p1', type: 'session-title-updated' });
  assert.equal(hub.count('p1'), 1);
});

test('broadcast prunes closed sockets but still delivers to survivors', () => {
  const hub = new ProjectWebSocketHub<string>();
  const a = new FakeSocket();
  const b = new FakeSocket();
  hub.subscribe('p1', a);
  hub.subscribe('p1', b);
  a.close();

  const sent = hub.broadcast('p1', { type: 'runtime-state' });

  assert.equal(sent, 1);
  assert.equal(a.sent.length, 0);
  assert.equal(b.sent.length, 1);
  assert.equal(hub.count('p1'), 1);
});

test('explicit projectId in object payload wins for compatibility', () => {
  const hub = new ProjectWebSocketHub<string>();
  const socket = new FakeSocket();
  hub.subscribe('p1', socket);

  hub.broadcast('p1', { projectId: 'custom', type: 'global-ish' });

  assert.deepEqual(JSON.parse(socket.sent[0]!), { projectId: 'custom', type: 'global-ish' });
});

test('broadcastAll sends the original payload to all open subscribers', () => {
  const hub = new ProjectWebSocketHub<string>();
  const a = new FakeSocket();
  const b = new FakeSocket();
  hub.subscribe('p1', a);
  hub.subscribe('p2', b);

  const sent = hub.broadcastAll({ type: 'pods-changed' });

  assert.equal(sent, 2);
  assert.deepEqual(JSON.parse(a.sent[0]!), { type: 'pods-changed' });
  assert.deepEqual(JSON.parse(b.sent[0]!), { type: 'pods-changed' });
});
