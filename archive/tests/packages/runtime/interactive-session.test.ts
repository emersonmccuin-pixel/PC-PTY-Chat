// Pin the InteractiveSession state machine.
//
// Simpler than AgentRun (no queue, no cap, no pause). The interesting
// transitions are: stopped → spawning → ready (gate opens) → busy
// (user send) → ready (normalized turn-end JSONL) → ... → exited/failed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InteractiveSession,
  type InteractiveSessionInput,
} from '../src/interactive-session.ts';
import type { SpawnLike } from '../src/agent-run.ts';
import type { ReadyTimestamps } from '../src/ready-gate.ts';
import type { SpawnState } from '../src/low-level-spawn.ts';
import type { SendResult } from '../src/send-protocol.ts';
import type { JsonlEvent } from '../src/jsonl-tailer.ts';

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

class StubSpawn extends EventEmitter implements SpawnLike {
  state: SpawnState = 'spawning';
  started = false;
  killed = false;
  interrupts = 0;
  resizes: Array<{ cols: number; rows: number }> = [];
  sent: string[] = [];
  rawWrites: string[] = [];
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
  writeRaw(bytes: string): boolean {
    this.rawWrites.push(bytes);
    return true;
  }
  notifyMcpHandshake(): void {}
  interrupt(): void {
    this.interrupts++;
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
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
      kind: 'jsonl-turn-end',
      text: 'reply',
      stopReason: 'end_turn',
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

test('happy path: stopped → spawning → ready on gate, no initialInput leaves state ready', async () => {
  const { session, stub } = makeSession();
  const states: string[] = [];
  session.on('state', (s: string) => states.push(s));
  assert.equal(session.getState(), 'stopped');
  session.start();
  await tick();
  assert.equal(session.getState(), 'spawning');
  assert.equal(stub.started, true);
  stub.fireReady();
  await tick();
  assert.equal(session.getState(), 'ready');
  assert.deepEqual(states, ['spawning', 'ready']);
  assert.deepEqual(stub.sent, []);
});

test('initialInput is sent on ready and transitions to busy', async () => {
  const { session, stub } = makeSession({ initialInput: 'Hi orchestrator' });
  session.start();
  await tick();
  stub.fireReady();
  await tick();
  assert.deepEqual(stub.sent, ['Hi orchestrator']);
  assert.equal(session.getState(), 'busy');
});

test('user send (post-ready) transitions ready → busy', async () => {
  const { session, stub } = makeSession();
  session.start();
  await tick();
  stub.fireReady();
  await tick();
  await session.send('what is up');
  assert.equal(session.getState(), 'busy');
  assert.deepEqual(stub.sent, ['what is up']);
});

test('normalized turn-end JSONL while busy transitions back to ready', async () => {
  const { session, stub } = makeSession();
  session.start();
  await tick();
  stub.fireReady();
  await tick();
  await session.send('a question');
  assert.equal(session.getState(), 'busy');
  stub.fireTurnEnd();
  await tick();
  assert.equal(session.getState(), 'ready');
});

test('ready ⇌ busy cycle across multiple turns', async () => {
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
    'busy',
    'ready',
    'busy',
    'ready',
    'busy',
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

test('ready-gate failure → failed + error event', async () => {
  const { session, stub } = makeSession();
  session.start();
  await tick();
  let failedFired = 0;
  let errFired = 0;
  session.on('failed', () => failedFired++);
  session.on('error', () => errFired++);
  stub.fireReadyFail();
  await tick();
  assert.equal(session.getState(), 'failed');
  assert.equal(failedFired, 1);
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

test('resize() forwards to spawn', async () => {
  const { session, stub } = makeSession();
  session.start();
  await tick();
  stub.fireReady();
  await tick();
  session.resize(140, 38);
  assert.deepEqual(stub.resizes, [{ cols: 140, rows: 38 }]);
});

test('writeRaw() forwards exact bytes without changing ready/busy state', async () => {
  const { session, stub } = makeSession();
  session.start();
  await tick();
  stub.fireReady();
  await tick();
  assert.equal(session.getState(), 'ready');
  assert.equal(session.writeRaw('/help\r'), true);
  assert.equal(session.writeRaw('\x1b[A\x03'), true);
  assert.equal(session.getState(), 'ready');
  assert.deepEqual(stub.rawWrites, ['/help\r', '\x1b[A\x03']);
  assert.deepEqual(stub.sent, []);
});

test('writeRaw() returns false before start and after close', async () => {
  const { session, stub } = makeSession();
  assert.equal(session.writeRaw('before'), false);
  session.start();
  await tick();
  stub.fireReady();
  await tick();
  session.close();
  await tick();
  assert.equal(session.writeRaw('after'), false);
  assert.deepEqual(stub.rawWrites, []);
});

test('start() twice throws', () => {
  const { session } = makeSession();
  session.start();
  assert.throws(() => session.start(), /start\(\) called twice/);
});

test('mode, env overrides, and readiness options pass through to spawn factory', async () => {
  let factoryInput: {
    mode?: string;
    envOverrides?: Record<string, string | undefined>;
    remoteControl?: boolean;
    requireReadySignal?: boolean;
  } | null = null;
  const stub = new StubSpawn();
  const session = new InteractiveSession(
    makeInput({
      mode: 'resume',
      envOverrides: { TERM: 'xterm-256color', FORCE_COLOR: '3' },
      remoteControl: false,
      requireReadySignal: true,
    }),
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
  assert.deepEqual(factoryInput!.envOverrides, { TERM: 'xterm-256color', FORCE_COLOR: '3' });
  assert.equal(factoryInput!.remoteControl, false);
  assert.equal(factoryInput!.requireReadySignal, true);
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

test('jsonl path and source cursor diagnostics are emitted', async () => {
  const { session, stub } = makeSession();
  const paths: string[] = [];
  const cursorTicks: Array<{ path: string; cursor: number }> = [];
  session.on('jsonl-path-resolved', (path: string) => paths.push(path));
  session.on('jsonl-cursor-tick', (path: string, cursor: number) => {
    cursorTicks.push({ path, cursor });
  });
  session.start();
  await tick();
  stub.emit('jsonl-event', {
    kind: 'jsonl-user',
    text: 'hello',
  } satisfies JsonlEvent, { sourceCursor: 7 });
  await tick();

  assert.deepEqual(paths, ['/fake/jsonl.jsonl']);
  assert.deepEqual(cursorTicks, [{ path: '/fake/jsonl.jsonl', cursor: 7 }]);
});

test('legacy assistant-shaped event does not drive turn-end state', async () => {
  const { session, stub } = makeSession();
  session.start();
  await tick();
  stub.fireReady();
  await tick();
  await session.send('a question');
  assert.equal(session.getState(), 'busy');
  stub.emit('jsonl-event', {
    row: {
      type: 'assistant',
      message: { stop_reason: 'end_turn' },
    },
  } as unknown as JsonlEvent);
  await tick();
  assert.equal(session.getState(), 'busy');
});

test('ready failure retries with a new spawn attempt before failing', async () => {
  const first = new StubSpawn();
  const second = new StubSpawn();
  const stubs = [first, second];
  const attempts: string[] = [];
  const session = new InteractiveSession(makeInput({
    maxSpawnAttempts: 2,
    retryBackoffMs: 0,
  }), {
    now: () => 42,
    attemptIdFactory: (attempt) => `attempt-${attempt}`,
    spawnFactory: () => stubs.shift()!,
  });
  session.on('state', (state: string) => attempts.push(state));
  session.on('error', () => {});
  session.start();
  await tick();
  first.fireReadyFail();
  await tick();
  await tick();
  assert.equal(first.killed, true);
  assert.equal(second.started, true);
  second.fireReady();
  await tick();
  assert.equal(session.getState(), 'ready');
  assert.deepEqual(attempts, ['spawning', 'ready']);
  assert.deepEqual(session.getSnapshot(), {
    state: 'ready',
    spawnAttempt: 2,
    spawnAttemptId: 'attempt-2',
    lastReadyAt: 42,
    nextRetryAt: null,
    failureReason: null,
  });
});

test('replayEventsPath persists sequenced JSONL events before re-emitting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-interactive-replay-'));
  try {
    const replayEventsPath = join(dir, 'jsonl-events.jsonl');
    const { session, stub } = makeSession({ replayEventsPath });
    session.start();
    await tick();
    stub.fireReady();
    await tick();
    const replayMetas: unknown[] = [];
    session.on('jsonl-event', (_event: JsonlEvent, replay: unknown) => replayMetas.push(replay));
    stub.emit('jsonl-event', {
      kind: 'jsonl-user',
      text: 'hello',
    } satisfies JsonlEvent, { sourceCursor: 3 });
    await tick();
    const rows = readFileSync(replayEventsPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        id: string;
        sessionId: string;
        seq: number;
        kind: string;
        source: { cursor: number | null };
        event: JsonlEvent;
      });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, 'sess-1:1');
    assert.equal(rows[0]!.sessionId, 'sess-1');
    assert.equal(rows[0]!.seq, 1);
    assert.equal(rows[0]!.kind, 'jsonl-user');
    assert.equal(rows[0]!.source.cursor, 3);
    assert.deepEqual(replayMetas[0], {
      id: 'sess-1:1',
      sessionId: 'sess-1',
      seq: 1,
      kind: 'jsonl-user',
      source: { kind: 'claude-jsonl', cursor: 3 },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
