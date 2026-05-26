// Pin the AgentRun state machine.
//
// Real-CC validation lives in labs scenarios + Session 9's user-test gate.
// This suite locks every state-transition path in the wrapper against a
// stub SpawnLike so the contract can't drift without a fast local signal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  AgentRun,
  type AgentRunInput,
  type SpawnLike,
} from '../src/agent-run.ts';
import { AgentRunRegistry } from '../src/agent-run-registry.ts';
import type { ReadyTimestamps } from '../src/ready-gate.ts';
import type { SpawnState } from '../src/low-level-spawn.ts';
import type { SendResult } from '../src/send-protocol.ts';
import type { JsonlEvent } from '../src/jsonl-tailer.ts';

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

class StubSpawn extends EventEmitter implements SpawnLike {
  state: SpawnState = 'spawning';
  started = false;
  killed = false;
  killCount = 0;
  interrupts = 0;
  sent: string[] = [];
  sendResult: SendResult = 'ok';
  sendThrows: Error | null = null;
  readyPromise: Promise<ReadyTimestamps>;
  private readyResolve!: (ts: ReadyTimestamps) => void;
  private readyReject!: (err: Error) => void;

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
    if (this.sendThrows) throw this.sendThrows;
    return this.sendResult;
  }
  notifyMcpHandshake(): void {}
  interrupt(): void {
    this.interrupts++;
  }
  kill(): void {
    this.killed = true;
    this.killCount++;
    // node-pty fires exit; we simulate it on the next tick so callers can
    // observe both the kill() call and the exit event in sequence.
    setImmediate(() => this.emit('exit', null, null));
  }
  getState(): SpawnState {
    return this.state;
  }
  getJsonlPath(): string | null {
    return '/fake/path.jsonl';
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
    this.emit('state', this.state);
    this.readyReject(new Error(reason));
  }
  fireAssistantTurnEnd(text = 'all done'): void {
    this.emit('jsonl-event', {
      row: {
        type: 'assistant',
        message: { content: [{ type: 'text', text }], stop_reason: 'end_turn' },
      },
    } as unknown as JsonlEvent);
  }
  fireAssistantToolUse(): void {
    this.emit('jsonl-event', {
      row: {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'pc_ask_orchestrator', input: {} }],
          stop_reason: 'tool_use',
        },
      },
    } as unknown as JsonlEvent);
  }
  fireExit(): void {
    this.emit('exit', null, null);
  }
}

function makeInput(over: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    agentRunId: 'run-1',
    ccProviderSessionId: '00000000-0000-0000-0000-000000000001',
    podDefinition: { name: 'researcher' },
    worktreePath: 'C:\\fake\\worktree',
    env: {},
    initialInput: 'Hello, world',
    // Short timeouts so tests can fire them quickly without waiting minutes.
    spawnStuckMs: 100,
    idleMs: 100,
    wallClockMs: 500,
    handshakeTimeoutMs: 60_000,
    readyTimeoutMs: 60_000,
    cancelGraceMs: 20,
    ...over,
  };
}

function makeRun(
  inputOver: Partial<AgentRunInput> = {},
  opts: { cap?: number; stub?: StubSpawn } = {},
): { run: AgentRun; stub: StubSpawn; registry: AgentRunRegistry } {
  const registry = new AgentRunRegistry({ maxConcurrent: opts.cap ?? 5 });
  const stub = opts.stub ?? new StubSpawn();
  const run = new AgentRun(makeInput(inputOver), {
    registry,
    spawnFactory: () => stub,
  });
  return { run, stub, registry };
}

function collectStates(run: AgentRun): string[] {
  const states: string[] = [];
  run.on('state', (next: string) => states.push(next));
  return states;
}

function awaitTerminal(run: AgentRun): Promise<{ status: string; cause?: string; result?: string }> {
  return new Promise((resolve) => {
    run.once('terminal', resolve);
  });
}

test('happy path: queued → spawning → running → completed on turn-end', async () => {
  const { run, stub } = makeRun();
  const states = collectStates(run);
  const terminalP = awaitTerminal(run);

  run.start();
  await tick();
  // ticket admitted immediately under cap=5 — state should be spawning.
  assert.equal(run.getState(), 'spawning');
  assert.equal(stub.started, true);

  stub.fireReady();
  await tick();
  assert.equal(run.getState(), 'running');
  assert.deepEqual(stub.sent, ['Hello, world']);

  stub.fireAssistantTurnEnd('all done');
  const t = await terminalP;
  assert.equal(t.status, 'completed');
  assert.equal(t.result, 'all done');
  assert.equal(run.getState(), 'completed');
  assert.equal(stub.killed, true);
  assert.equal(stub.killCount, 1);
  assert.deepEqual(states, ['spawning', 'running', 'completed']);
});

test('queued blocks when cap full; admits when prior run releases', async () => {
  const registry = new AgentRunRegistry({ maxConcurrent: 1 });
  const stubA = new StubSpawn();
  const stubB = new StubSpawn();
  const runA = new AgentRun(makeInput({ agentRunId: 'A' }), {
    registry,
    spawnFactory: () => stubA,
  });
  const runB = new AgentRun(makeInput({ agentRunId: 'B' }), {
    registry,
    spawnFactory: () => stubB,
  });

  runA.start();
  runB.start();
  await tick();
  assert.equal(runA.getState(), 'spawning');
  assert.equal(runB.getState(), 'queued');
  assert.equal(stubB.started, false);

  // Complete A — should admit B.
  stubA.fireReady();
  await tick();
  stubA.fireAssistantTurnEnd();
  await tick();
  assert.equal(runA.getState(), 'completed');
  assert.equal(runB.getState(), 'spawning');
  assert.equal(stubB.started, true);
});

test('queued-started fires once on transition to spawning', async () => {
  const { run } = makeRun();
  let queuedStartedCount = 0;
  run.on('queued-started', () => queuedStartedCount++);
  run.start();
  await tick();
  assert.equal(queuedStartedCount, 1);
});

test('cancel while queued: aborts ticket, terminal=cancelled with cause=cancel-while-queued', async () => {
  const registry = new AgentRunRegistry({ maxConcurrent: 1 });
  const stubA = new StubSpawn();
  const stubB = new StubSpawn();
  const runA = new AgentRun(makeInput({ agentRunId: 'A' }), {
    registry,
    spawnFactory: () => stubA,
  });
  const runB = new AgentRun(makeInput({ agentRunId: 'B' }), {
    registry,
    spawnFactory: () => stubB,
  });
  runA.start();
  runB.start();
  await tick();
  assert.equal(runB.getState(), 'queued');

  const terminalP = awaitTerminal(runB);
  runB.cancel();
  const t = await terminalP;
  assert.equal(t.status, 'cancelled');
  assert.equal(t.cause, 'cancel-while-queued');
  // B was never spawned.
  assert.equal(stubB.started, false);
});

test('cancel during running: kills spawn; grace expires → cancelled', async () => {
  const { run, stub } = makeRun({
    // Idle would fire during cancel-grace if cancellation did not own timers.
    idleMs: 1_000,
    cancelGraceMs: 1_500,
  });
  const terminalP = awaitTerminal(run);
  run.start();
  await tick();
  stub.fireReady();
  await tick();
  assert.equal(run.getState(), 'running');

  run.cancel();
  assert.equal(stub.killed, true);
  // Grace must elapse before terminal fires.
  await tick(1_800);
  const t = await terminalP;
  assert.equal(t.status, 'cancelled');
  assert.equal(t.cause, 'cancelled');
});

test('cancel during running with late-success: turn-end during grace → completed', async () => {
  const { run, stub } = makeRun({ cancelGraceMs: 100 });
  const terminalP = awaitTerminal(run);
  run.start();
  await tick();
  stub.fireReady();
  await tick();
  assert.equal(run.getState(), 'running');

  run.cancel();
  assert.equal(stub.killed, true);
  // Within the grace window, a late turn-end lands. (Section 18 V-4 lesson.)
  stub.fireAssistantTurnEnd('finished after kill');
  const t = await terminalP;
  assert.equal(t.status, 'completed');
  assert.equal(t.result, 'finished after kill');
});

test('spawning → failed when ready gate rejects', async () => {
  const { run, stub } = makeRun();
  const terminalP = awaitTerminal(run);
  run.start();
  await tick();
  stub.fireReadyFail('handshake-timeout');
  const t = await terminalP;
  assert.equal(t.status, 'failed');
  assert.equal(t.cause, 'ready-timeout');
});

test('spawn-stuck timer fires if gate never opens', async () => {
  // spawnStuckMs is 100 in makeInput defaults.
  const { run, stub } = makeRun({ spawnStuckMs: 30 });
  const terminalP = awaitTerminal(run);
  run.start();
  await tick();
  assert.equal(run.getState(), 'spawning');
  // Don't fire ready. Wait past spawn-stuck threshold.
  await tick(80);
  const t = await terminalP;
  assert.equal(t.status, 'failed');
  assert.equal(t.cause, 'spawn-stuck');
  assert.equal(stub.killed, true);
});

test('idle timer fires if no jsonl events arrive in running', async () => {
  const { run, stub } = makeRun({ idleMs: 100 });
  const terminalP = awaitTerminal(run);
  run.start();
  await tick();
  stub.fireReady();
  await tick();
  assert.equal(run.getState(), 'running');
  // Don't fire any JSONL events.
  await tick(250);
  const t = await terminalP;
  assert.equal(t.status, 'failed');
  assert.equal(t.cause, 'idle-timeout');
});

test('idle timer resets on every jsonl event', async () => {
  const { run, stub } = makeRun({ idleMs: 1_000, wallClockMs: 10_000 });
  let terminal: { status: string; cause?: string } | null = null;
  run.on('terminal', (t: { status: string; cause?: string }) => {
    terminal = t;
  });
  run.start();
  await tick();
  stub.fireReady();
  await tick();
  // Send jsonl events well inside the idle window. The total elapsed time is
  // longer than one idle window, but each event resets it.
  for (let i = 0; i < 4; i++) {
    await tick(300);
    stub.emit('jsonl-event', { row: { type: 'user' } } as unknown as JsonlEvent);
  }
  assert.equal(terminal, null);
  assert.equal(run.getState(), 'running');
});

test('wall-clock timer fires from spawning, persists through running', async () => {
  const { run, stub } = makeRun({
    wallClockMs: 50,
    idleMs: 10_000,
    spawnStuckMs: 10_000,
  });
  const terminalP = awaitTerminal(run);
  run.start();
  await tick();
  stub.fireReady();
  await tick();
  assert.equal(run.getState(), 'running');
  // Even though jsonl events would reset idle, wall-clock is independent.
  stub.emit('jsonl-event', { row: { type: 'user' } } as unknown as JsonlEvent);
  await tick(80);
  const t = await terminalP;
  assert.equal(t.status, 'failed');
  assert.equal(t.cause, 'wall-clock-timeout');
});

test('unexpected spawn exit during running → failed', async () => {
  const { run, stub } = makeRun({ idleMs: 10_000, wallClockMs: 10_000 });
  const terminalP = awaitTerminal(run);
  run.start();
  await tick();
  stub.fireReady();
  await tick();
  stub.fireExit();
  const t = await terminalP;
  assert.equal(t.status, 'failed');
  assert.equal(t.cause, 'unexpected-exit');
});

test('_markPaused: running → paused; idle cleared; pendingAskId recorded', async () => {
  const { run, stub } = makeRun({ idleMs: 10_000 });
  run.start();
  await tick();
  stub.fireReady();
  await tick();
  let pausedAsk: string | null = null;
  run.on('paused', (askId: string) => {
    pausedAsk = askId;
  });
  run._markPaused('ask-42');
  assert.equal(run.getState(), 'paused');
  assert.equal(pausedAsk, 'ask-42');
  assert.equal(run.getRecord().pendingAskId, 'ask-42');
});

test('paused: clean spawn exit does NOT transition to failed', async () => {
  const { run, stub } = makeRun({ idleMs: 10_000 });
  run.start();
  await tick();
  stub.fireReady();
  await tick();
  run._markPaused('ask-1');
  let terminal: unknown = null;
  run.on('terminal', (t: unknown) => {
    terminal = t;
  });
  stub.fireExit();
  await tick();
  assert.equal(run.getState(), 'paused');
  assert.equal(terminal, null);
});

test('_resumeWithAnswer: paused → spawning → running with answer as send body', async () => {
  // First spawn lands in paused. Second spawn (factory call #2) is the resume.
  const stub1 = new StubSpawn();
  const stub2 = new StubSpawn();
  const registry = new AgentRunRegistry({ maxConcurrent: 1 });
  const stubs = [stub1, stub2];
  const factory = () => stubs.shift()!;
  const run = new AgentRun(makeInput({ idleMs: 10_000 }), {
    registry,
    spawnFactory: factory,
  });
  run.start();
  await tick();
  stub1.fireReady();
  await tick();
  run._markPaused('ask-x');

  run._resumeWithAnswer('your answer');
  assert.equal(run.getState(), 'spawning');
  assert.equal(stub2.started, true);

  stub2.fireReady();
  await tick();
  assert.equal(run.getState(), 'running');
  assert.deepEqual(stub2.sent, ['your answer']);
  assert.equal(run.getRecord().pendingAskId, undefined);
});

test('terminal release frees registry slot for the next queued run', async () => {
  const registry = new AgentRunRegistry({ maxConcurrent: 1 });
  const stubA = new StubSpawn();
  const stubB = new StubSpawn();
  const runA = new AgentRun(makeInput({ agentRunId: 'A' }), {
    registry,
    spawnFactory: () => stubA,
  });
  const runB = new AgentRun(makeInput({ agentRunId: 'B' }), {
    registry,
    spawnFactory: () => stubB,
  });
  runA.start();
  runB.start();
  await tick();
  // Fail A via ready-fail → terminal=failed, slot released.
  stubA.fireReadyFail();
  await tick();
  assert.equal(runA.getState(), 'failed');
  assert.equal(runB.getState(), 'spawning');
});

test('start() twice throws', () => {
  const { run } = makeRun();
  run.start();
  assert.throws(() => run.start(), /start\(\) called twice/);
});

test('cancel after terminal is a no-op', async () => {
  const { run, stub } = makeRun();
  const terminalP = awaitTerminal(run);
  run.start();
  await tick();
  stub.fireReady();
  await tick();
  stub.fireAssistantTurnEnd();
  await terminalP;
  assert.equal(run.getState(), 'completed');
  // No throw, no state change.
  run.cancel();
  assert.equal(run.getState(), 'completed');
  assert.equal(stub.killCount, 1);
});

test('getRecord captures terminalAt / readyAt / runningAt timestamps', async () => {
  let nowVal = 1000;
  const registry = new AgentRunRegistry({ maxConcurrent: 5 });
  const stub = new StubSpawn();
  const run = new AgentRun(makeInput(), {
    registry,
    spawnFactory: () => stub,
    now: () => nowVal,
  });
  run.start();
  await tick();
  // queued at 1000, spawning at 1000 (same tick), advance for ready.
  nowVal = 1100;
  stub.fireReady();
  await tick();
  // running at 1100. Advance for terminal.
  nowVal = 1300;
  stub.fireAssistantTurnEnd();
  await tick();
  const rec = run.getRecord();
  assert.equal(rec.state, 'completed');
  assert.equal(rec.queuedAt, 1000);
  assert.equal(rec.readyAt, 1100);
  assert.equal(rec.runningAt, 1100);
  assert.equal(rec.terminalAt, 1300);
});

test('cap of 5 is the documented default when no override', () => {
  const registry = new AgentRunRegistry();
  assert.equal(registry.getMaxConcurrent(), 5);
});

test('handshake passthrough: notifyMcpHandshake delegates to spawn', async () => {
  const { run, stub } = makeRun();
  let calls = 0;
  stub.notifyMcpHandshake = () => {
    calls++;
  };
  run.start();
  await tick();
  run.notifyMcpHandshake();
  assert.equal(calls, 1);
});

test('jsonl-event with tool_use does NOT count as turn-end', async () => {
  const { run, stub } = makeRun({ idleMs: 10_000 });
  let terminal: unknown = null;
  run.on('terminal', (t: unknown) => {
    terminal = t;
  });
  run.start();
  await tick();
  stub.fireReady();
  await tick();
  stub.fireAssistantToolUse();
  await tick();
  // tool_use is mid-turn; we must still be running.
  assert.equal(run.getState(), 'running');
  assert.equal(terminal, null);
});
