// Pin the InteractiveSession state machine.
//
// Simpler than AgentRun (no queue, no cap, no pause). The interesting
// transitions are: spawning → ready (gate opens) → running (user send) →
// ready (turn-end JSONL) → ... → exited (close or spawn exit).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  InteractiveSession,
  type InteractiveSessionInput,
} from '../../src/v2/interactive-session.ts';
import type { SpawnLike } from '../../src/v2/agent-run.ts';
import type { ReadyTimestamps } from '../../src/v2/ready-gate.ts';
import type { SpawnState } from '../../src/v2/low-level-spawn.ts';
import type { SendResult } from '../../src/v2/send-protocol.ts';
import type { JsonlEvent } from '../../src/jsonl-tailer.ts';

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

class StubSpawn extends EventEmitter implements SpawnLike {
  state: SpawnState = 'spawning';
  started = false;
  killed = false;
  interrupts = 0;
  sent: string[] = [];
  sendResult: SendResult = 'ok';
  private readyResolve!: (ts: ReadyTimestamps) => void;
  private readyReject!: (err: Error) => void;
  readyPromise: Promise<ReadyTimestamps>;

  constructor() {
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
  async send(body: string): Promise<SendResult> {
    this.sent.push(body);
    return this.sendResult;
  }
  notifyMcpHandshake(): void {}
  interrupt(): void {
    this.interrupts++;
  }
  kill(): void {
    this.killed = true;
    setImmediate(() => this.emit('exit', null, null));
  }
  getState(): SpawnState {
    return this.state;
  }
  getJsonlPath(): string | null {
    return '/fake/jsonl.jsonl';
  }

  // Test helpers
  fireReady(
    ts: ReadyTimestamps = {
      composerReadyAt: 100,
      handshakeAt: 200,
      initCompleteAt: 300,
    },
  ): void {
    this.state = 'ready';
    this.emit('state', this.state);
    this.readyResolve(ts);
    this.emit('ready', ts);
  }
  fireReadyFail(reason = 'ready-timeout'): void {
    this.state = 'exited';
    this.readyReject(new Error(reason));
  }
  fireTurnEnd(): void {
    this.emit('jsonl-event', {
      row: {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'reply' }],
          stop_reason: 'end_turn',
        },
      },
    } as unknown as JsonlEvent);
  }
  fireExit(): void {
    this.emit('exit', null, null);
  }
}

function makeInput(over: Partial<InteractiveSessionInput> = {}): InteractiveSessionInput {
  return {
    pcSessionId: 'sess-1',
    ccProviderSessionId: '00000000-0000-0000-0000-000000000001',
    podDefinition: { name: 'orchestrator' },
    worktreePath: 'C:\\fake\\worktree',
    env: {},
    handshakeTimeoutMs: 60_000,
    readyTimeoutMs: 60_000,
    ...over,
  };
}

function makeSession(
  inputOver: Partial<InteractiveSessionInput> = {},
  stub: StubSpawn = new StubSpawn(),
): { session: InteractiveSession; stub: StubSpawn } {
  const session = new InteractiveSession(makeInput(inputOver), {
    spawnFactory: () => stub,
  });
  return { session, stub };
}

test('happy path: spawning → ready on gate, no initialInput leaves state ready', async () => {
  const { session, stub } = makeSession();
  const states: string[] = [];
  session.on('state', (s: string) => states.push(s));
  session.start();
  await tick();
  assert.equal(session.getState(), 'spawning');
  assert.equal(stub.started, true);
  stub.fireReady();
  await tick();
  assert.equal(session.getState(), 'ready');
  assert.deepEqual(states, ['ready']);
  assert.deepEqual(stub.sent, []);
});

test('initialInput is sent on ready and transitions to running', async () => {
  const { session, stub } = makeSession({ initialInput: 'Hi orchestrator' });
  session.start();
  await tick();
  stub.fireReady();
  await tick();
  assert.deepEqual(stub.sent, ['Hi orchestrator']);
  assert.equal(session.getState(), 'running');
});

test('user send (post-ready) transitions ready → running', async () => {
  const { session, stub } = makeSession();
  session.start();
  await tick();
  stub.fireReady();
  await tick();
  await session.send('what is up');
  assert.equal(session.getState(), 'running');
  assert.deepEqual(stub.sent, ['what is up']);
});

test('turn-end JSONL while running transitions back to ready', async () => {
  const { session, stub } = makeSession();
  session.start();
  await tick();
  stub.fireReady();
  await tick();
  await session.send('a question');
  assert.equal(session.getState(), 'running');
  stub.fireTurnEnd();
  await tick();
  assert.equal(session.getState(), 'ready');
});

test('ready ⇌ running cycle across multiple turns', async () => {
  const { session, stub } = makeSession();
  session.start();
  await tick();
  stub.fireReady();
  await tick();
  const stateLog: string[] = [];
  session.on('state', (s: string) => stateLog.push(s));

  await session.send('turn 1');
  stub.fireTurnEnd();
  await tick();
  await session.send('turn 2');
  stub.fireTurnEnd();
  await tick();
  await session.send('turn 3');
  stub.fireTurnEnd();
  await tick();
  assert.deepEqual(stateLog, [
    'running',
    'ready',
    'running',
    'ready',
    'running',
    'ready',
  ]);
});

test('send before ready throws', async () => {
  const { session } = makeSession();
  session.start();
  await tick();
  await assert.rejects(() => session.send('too early'), /send before ready/);
});

test('send before start throws', async () => {
  const { session } = makeSession();
  await assert.rejects(() => session.send('before start'), /send before start/);
});

test('close() transitions to exited and kills spawn', async () => {
  const { session, stub } = makeSession();
  session.start();
  await tick();
  stub.fireReady();
  await tick();
  let exitedFired = 0;
  session.on('exited', () => exitedFired++);
  session.close();
  await tick();
  assert.equal(stub.killed, true);
  assert.equal(session.getState(), 'exited');
  assert.equal(exitedFired, 1);
});

test('close() is idempotent', async () => {
  const { session, stub } = makeSession();
  session.start();
  await tick();
  stub.fireReady();
  await tick();
  session.close();
  session.close();
  session.close();
  await tick();
  assert.equal(session.getState(), 'exited');
  assert.equal(stub.killed, true);
});

test('send after exited returns "exited" status', async () => {
  const { session, stub } = makeSession();
  session.start();
  await tick();
  stub.fireReady();
  await tick();
  session.close();
  await tick();
  const result = await session.send('post-close');
  assert.equal(result, 'exited');
});

test('unexpected spawn exit transitions to exited', async () => {
  const { session, stub } = makeSession();
  session.start();
  await tick();
  stub.fireReady();
  await tick();
  let exitedFired = 0;
  session.on('exited', () => exitedFired++);
  stub.fireExit();
  await tick();
  assert.equal(session.getState(), 'exited');
  assert.equal(exitedFired, 1);
});

test('ready-gate failure → exited + error event', async () => {
  const { session, stub } = makeSession();
  session.start();
  await tick();
  let exitedFired = 0;
  let errFired = 0;
  session.on('exited', () => exitedFired++);
  session.on('error', () => errFired++);
  stub.fireReadyFail();
  await tick();
  assert.equal(session.getState(), 'exited');
  assert.equal(exitedFired, 1);
  assert.equal(errFired, 1);
});

test('interrupt() forwards to spawn', async () => {
  const { session, stub } = makeSession();
  session.start();
  await tick();
  stub.fireReady();
  await tick();
  session.interrupt();
  session.interrupt();
  assert.equal(stub.interrupts, 2);
});

test('start() twice throws', () => {
  const { session } = makeSession();
  session.start();
  assert.throws(() => session.start(), /start\(\) called twice/);
});

test('mode=resume passes through to spawn factory', async () => {
  let factoryInput: { mode?: string } | null = null;
  const stub = new StubSpawn();
  const session = new InteractiveSession(
    makeInput({ mode: 'resume' }),
    {
      spawnFactory: (input) => {
        factoryInput = input;
        return stub;
      },
    },
  );
  session.start();
  await tick();
  assert.equal(factoryInput!.mode, 'resume');
});

test('notifyMcpHandshake forwards to spawn', async () => {
  const stub = new StubSpawn();
  let calls = 0;
  stub.notifyMcpHandshake = () => {
    calls++;
  };
  const { session } = makeSession({}, stub);
  session.start();
  await tick();
  session.notifyMcpHandshake();
  assert.equal(calls, 1);
});

test('jsonl-event is re-emitted on the session', async () => {
  const { session, stub } = makeSession();
  session.start();
  await tick();
  stub.fireReady();
  await tick();
  const events: JsonlEvent[] = [];
  session.on('jsonl-event', (e: JsonlEvent) => events.push(e));
  stub.fireTurnEnd();
  assert.equal(events.length, 1);
});
