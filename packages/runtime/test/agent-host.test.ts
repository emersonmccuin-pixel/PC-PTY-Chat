// Pin the out-of-process agent host control plane.
//
// Wires AgentHost (host side) ↔ HostClient (server side) through an in-memory
// loopback channel with a controllable fake spawn, and locks the full
// round-trip: spawn → ready → send → chunk → JSONL tail → exit, plus roster,
// readyFailed, duplicate-spawn rejection, and disconnect. No node-pty, no
// sockets — the transport + JSONL are the only real I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentHost, type HostSpawn } from '../src/host/agent-host.ts';
import { HostClient } from '../src/host/host-client.ts';
import { encodeMsg, decodeMsg } from '../src/host/protocol.ts';
import type {
  HostToServerMsg,
  MessageChannel,
  ServerToHostMsg,
} from '../src/host/protocol.ts';
import type { LowLevelSpawnInput, SpawnState } from '../src/low-level-spawn.ts';
import type { ReadyTimestamps } from '../src/ready-gate.ts';

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

const READY: ReadyTimestamps = {
  composerReadyAt: 100,
  handshakeAt: 200,
  initCompleteAt: 300,
};

class FakeHostSpawn extends EventEmitter implements HostSpawn {
  state: SpawnState = 'spawning';
  started = false;
  sent: string[] = [];
  wrote: string[] = [];
  interrupts = 0;
  resizes: Array<[number, number]> = [];
  handshakes = 0;
  killed = false;
  pid = 4242;
  readyPromise: Promise<ReadyTimestamps>;
  private readyResolve!: (ts: ReadyTimestamps) => void;
  private readyReject!: (err: Error) => void;

  constructor(public jsonlPath: string | null) {
    super();
    this.readyPromise = new Promise<ReadyTimestamps>((res, rej) => {
      this.readyResolve = res;
      this.readyReject = rej;
    });
    this.readyPromise.catch(() => {});
  }

  start(): void {
    this.started = true;
  }
  awaitReady(): Promise<ReadyTimestamps> {
    return this.readyPromise;
  }
  async send(body: string): Promise<'ok' | 'echo-timeout' | 'exited'> {
    this.sent.push(body);
    return 'ok';
  }
  writeRaw(bytes: string): boolean {
    this.wrote.push(bytes);
    return true;
  }
  interrupt(): void {
    this.interrupts++;
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  kill(): void {
    this.killed = true;
    setImmediate(() => {
      this.state = 'exited';
      this.emit('exit', 0, null);
    });
  }
  notifyMcpHandshake(): void {
    this.handshakes++;
  }
  getState(): SpawnState {
    return this.state;
  }
  getJsonlPath(): string | null {
    return this.jsonlPath;
  }
  getPid(): number | null {
    return this.pid;
  }

  fireReady(): void {
    this.state = 'ready';
    this.emit('state', 'ready');
    this.readyResolve(READY);
    this.emit('ready', READY);
  }
  fireReadyFail(reason = 'ready-timeout'): void {
    this.readyReject(new Error(reason));
  }
}

/** Wire AgentHost ↔ HostClient through an in-memory loopback. Returns both
 *  ends + the list of spawns the host created. */
function wire(opts: { jsonlPathFor?: (input: LowLevelSpawnInput) => string | null } = {}) {
  const spawns: FakeHostSpawn[] = [];
  let host!: AgentHost;
  let clientInbound: ((m: HostToServerMsg) => void) | null = null;

  const channel: MessageChannel<ServerToHostMsg, HostToServerMsg> = {
    // server → host
    send: (m) => host.handle(m),
    subscribe: (h) => {
      clientInbound = h;
      return () => {
        clientInbound = null;
      };
    },
  };

  host = new AgentHost({
    // host → server
    send: (m) => clientInbound?.(m),
    spawnFactory: (input) => {
      const s = new FakeHostSpawn(opts.jsonlPathFor ? opts.jsonlPathFor(input) : null);
      spawns.push(s);
      return s;
    },
  });

  const client = new HostClient(channel);
  return { client, host, spawns };
}

function baseInput(overrides: Partial<LowLevelSpawnInput> = {}): LowLevelSpawnInput {
  return {
    podDefinition: { name: 'researcher' },
    worktreePath: 'C:/wt',
    env: {},
    ccProviderSessionId: 'cc-1',
    mode: 'fresh',
    ...overrides,
  };
}

test('spawn → ready round-trip', async () => {
  const { client, host, spawns } = wire();
  const remote = client.createSpawn(baseInput());
  const states: SpawnState[] = [];
  remote.on('state', (s) => states.push(s));

  remote.start();
  await tick();

  assert.equal(host.size(), 1);
  assert.equal(spawns[0].started, true);
  assert.equal(remote.getState(), 'spawning');

  let readyTs: ReadyTimestamps | null = null;
  remote.on('ready', (ts) => (readyTs = ts));
  spawns[0].fireReady();
  await tick();

  assert.deepEqual(readyTs, READY);
  assert.deepEqual(await remote.awaitReady(), READY);
  assert.equal(remote.getState(), 'ready');
  assert.ok(states.includes('ready'));
});

test('send round-trip flips to running', async () => {
  const { client, spawns } = wire();
  const remote = client.createSpawn(baseInput());
  remote.start();
  await tick();
  spawns[0].fireReady();
  await tick();

  const result = await remote.send('first turn');
  assert.equal(result, 'ok');
  assert.deepEqual(spawns[0].sent, ['first turn']);
  assert.equal(remote.getState(), 'running');
});

test('control commands proxy to the host spawn', async () => {
  const { client, spawns } = wire();
  const remote = client.createSpawn(baseInput());
  remote.start();
  await tick();
  const s = spawns[0];

  remote.writeRaw('\x03');
  remote.interrupt();
  remote.resize(80, 24);
  remote.notifyMcpHandshake();
  await tick();

  assert.deepEqual(s.wrote, ['\x03']);
  assert.equal(s.interrupts, 1);
  assert.deepEqual(s.resizes, [[80, 24]]);
  assert.equal(s.handshakes, 1);
});

test('chunk events forward to the server', async () => {
  const { client, spawns } = wire();
  const remote = client.createSpawn(baseInput());
  const chunks: string[] = [];
  remote.on('chunk', (t) => chunks.push(t));
  remote.start();
  await tick();

  spawns[0].emit('chunk', 'hello');
  await tick();
  assert.deepEqual(chunks, ['hello']);
});

test('jsonl-event comes from the server-side disk tailer, not the wire', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-host-'));
  const jsonlPath = join(dir, 'cc-1.jsonl');
  const line =
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    }) + '\n';
  writeFileSync(jsonlPath, line);

  const { client, spawns } = wire({ jsonlPathFor: () => jsonlPath });
  const remote = client.createSpawn(baseInput({ jsonlPath }));
  const events: unknown[] = [];
  remote.on('jsonl-event', (ev) => events.push(ev));
  remote.start();
  await tick(50); // setImmediate attach + tailer initial read

  // Host's fake spawn never wrote JSONL — proves the event is disk-sourced.
  assert.equal(spawns[0].sent.length, 0);
  assert.ok(events.length >= 1, 'expected a jsonl-event from the disk tailer');
  const turnEnd = events.find(
    (e) => (e as { kind?: string }).kind === 'jsonl-turn-end',
  );
  assert.ok(turnEnd, 'expected a turn-end event');

  // An append is picked up by the poller too.
  appendFileSync(
    jsonlPath,
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'more' }], stop_reason: 'end_turn' },
    }) + '\n',
  );
  await tick(300);
  const turnEnds = events.filter(
    (e) => (e as { kind?: string }).kind === 'jsonl-turn-end',
  );
  assert.ok(turnEnds.length >= 2, 'expected the appended turn-end too');
  remote.kill();
});

test('kill → exit propagates and is sticky', async () => {
  const { client, spawns } = wire();
  const remote = client.createSpawn(baseInput());
  const exits: Array<[number | null, number | null]> = [];
  remote.on('exit', (c, s) => exits.push([c, s]));
  remote.start();
  await tick();
  spawns[0].fireReady();
  await tick();

  remote.kill();
  await tick();

  assert.equal(spawns[0].killed, true);
  assert.deepEqual(exits, [[0, null]]);
  assert.equal(remote.getState(), 'exited');

  // Sticky terminal — a late state event can't revive it.
  spawns[0].emit('state', 'running');
  await tick();
  assert.equal(remote.getState(), 'exited');
});

test('readyFailed rejects awaitReady', async () => {
  const { client, spawns } = wire();
  const remote = client.createSpawn(baseInput());
  remote.start();
  await tick();

  spawns[0].fireReadyFail('ready-timeout');
  await tick();

  await assert.rejects(remote.awaitReady(), /ready failed \(ready-timeout\)/);
});

test('roster reflects live spawns', async () => {
  const { client } = wire();
  const a = client.createSpawn(baseInput({ ccProviderSessionId: 'cc-a' }));
  const b = client.createSpawn(baseInput({ ccProviderSessionId: 'cc-b' }));
  a.start();
  b.start();
  await tick();

  const roster = await client.roster();
  const keys = roster.map((r) => r.key).sort();
  assert.deepEqual(keys, ['cc-a', 'cc-b']);
  assert.ok(roster.every((r) => r.pid === 4242));
});

test('duplicate spawn key is rejected without disturbing the first', async () => {
  const { host, spawns } = wire();
  host.handle({ t: 'spawn', key: 'dup', input: baseInput({ ccProviderSessionId: 'dup' }) });
  host.handle({ t: 'spawn', key: 'dup', input: baseInput({ ccProviderSessionId: 'dup' }) });
  await tick();
  assert.equal(spawns.length, 1);
  assert.equal(host.size(), 1);
});

test('shutdown fails all spawns with an exit', async () => {
  const { client, spawns } = wire();
  const remote = client.createSpawn(baseInput());
  let exited = false;
  remote.on('exit', () => (exited = true));
  remote.start();
  await tick();
  spawns[0].fireReady();
  await tick();

  client.shutdown();
  assert.equal(exited, true);
  assert.equal(remote.getState(), 'exited');
  // Post-shutdown sends short-circuit to 'exited'.
  assert.equal(await remote.send('x'), 'exited');
});

test('protocol codec round-trips both directions', () => {
  const out: ServerToHostMsg = { t: 'send', key: 'k', reqId: 'r', body: 'hi', echoTimeoutMs: 5 };
  assert.deepEqual(decodeMsg(encodeMsg(out)), out);
  const inbound: HostToServerMsg = { t: 'ready', key: 'k', ts: READY };
  assert.deepEqual(decodeMsg(encodeMsg(inbound)), inbound);
});

test('attach binds to a live host PTY (attached)', async () => {
  const { client, spawns } = wire();
  const first = client.createSpawn(baseInput({ ccProviderSessionId: 'cc-x' }));
  first.start();
  await tick();
  spawns[0].fireReady();
  await tick();

  // Simulate a restarted server reattaching to the same key.
  const re = client.attachSpawn(baseInput({ ccProviderSessionId: 'cc-x' }));
  let reReady = false;
  re.on('ready', () => (reReady = true));
  re.start();
  await tick();

  assert.equal(reReady, true, 'attach should resolve ready immediately');
  assert.equal(re.getState(), 'ready');
  await re.awaitReady();
  // Only one PTY was ever spawned on the host.
  assert.equal(spawns.length, 1);
});

test('attach to a missing key reports gone → exit', async () => {
  const { client } = wire();
  const re = client.attachSpawn(baseInput({ ccProviderSessionId: 'nope' }));
  let exited = false;
  re.on('exit', () => (exited = true));
  re.start();
  await tick();

  assert.equal(exited, true);
  assert.equal(re.getState(), 'exited');
  await assert.rejects(re.awaitReady(), /no live PTY to attach/);
});
