// Section 25 Session 10 — unit tests for spawnSubagent.
//
// Mirrors v1's coverage (subagent-spawner.test.ts) on the new LowLevelSpawn-
// backed implementation: happy path, pc_complete_node / pc_node_failed,
// idle timeout, kill, spawn error. The underlying LowLevelSpawn is faked via
// the `createLowLevelSpawn` deps seam so no real claude.exe spawns.
//
// Run via:  pnpm --filter @pc/runtime test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnSubagent } from '../src/subagent-spawner.ts';
import type { SubagentSpawnRequest } from '../src/subagent-spawner.ts';
import type { SpawnLike } from '../src/agent-run.ts';
import type { SpawnState } from '../src/low-level-spawn.ts';
import type { ReadyTimestamps } from '../src/ready-gate.ts';
import type { SendResult } from '../src/send-protocol.ts';
import type { JsonlEvent } from '../src/jsonl-tailer.ts';

interface MockSpawn extends SpawnLike {
  sent: string[];
  killed: boolean;
  handshakeFired: boolean;
  started: boolean;
  resolveReady(ts?: Partial<ReadyTimestamps>): void;
  rejectReady(err: Error): void;
  setSendResult(result: SendResult): void;
  emitJsonl(ev: JsonlEvent): void;
  emitExit(code: number | null, signal: number | null): void;
  setJsonlPath(path: string | null): void;
}

function makeMockSpawn(): MockSpawn {
  const emitter = new EventEmitter() as MockSpawn;
  emitter.sent = [];
  emitter.killed = false;
  emitter.handshakeFired = false;
  emitter.started = false;
  let state: SpawnState = 'spawning';
  let jsonlPath: string | null = null;
  let sendResult: SendResult = 'ok';

  let resolveReady!: (ts: ReadyTimestamps) => void;
  let rejectReady!: (err: Error) => void;
  const readyPromise = new Promise<ReadyTimestamps>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  emitter.start = () => {
    emitter.started = true;
  };
  emitter.awaitReady = () => readyPromise;
  emitter.send = async (body: string) => {
    emitter.sent.push(body);
    if (sendResult === 'ok') state = 'running';
    return sendResult;
  };
  emitter.notifyMcpHandshake = () => {
    emitter.handshakeFired = true;
  };
  emitter.interrupt = () => {};
  emitter.kill = () => {
    emitter.killed = true;
    state = 'exited';
  };
  emitter.getState = () => state;
  emitter.getJsonlPath = () => jsonlPath;

  emitter.resolveReady = (ts) => {
    const now = Date.now();
    resolveReady({
      handshakeAt: ts?.handshakeAt ?? now,
      composerReadyAt: ts?.composerReadyAt ?? now,
      initCompleteAt: ts?.initCompleteAt ?? now,
    });
  };
  emitter.rejectReady = (err) => rejectReady(err);
  emitter.setSendResult = (r) => {
    sendResult = r;
  };
  emitter.emitJsonl = (ev) => emitter.emit('jsonl-event', ev);
  emitter.emitExit = (code, signal) => emitter.emit('exit', code, signal);
  emitter.setJsonlPath = (p) => {
    jsonlPath = p;
  };

  return emitter;
}

interface ControllableTimers {
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  fireById(id: number): void;
  pending(): Array<{ id: number; ms: number }>;
}

function makeControllableTimers(): ControllableTimers {
  let next = 1;
  const map = new Map<number, { cb: () => void; ms: number }>();
  return {
    setTimeout(cb, ms) {
      const id = next++;
      map.set(id, { cb, ms });
      return { id };
    },
    clearTimeout(handle) {
      if (!handle || typeof handle !== 'object') return;
      const id = (handle as { id?: number }).id;
      if (typeof id === 'number') map.delete(id);
    },
    fireById(id) {
      const entry = map.get(id);
      if (!entry) throw new Error(`no timer ${id}`);
      map.delete(id);
      entry.cb();
    },
    pending() {
      return [...map.entries()].map(([id, { ms }]) => ({ id, ms }));
    },
  };
}

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'pc-spawner-v2-'));
}
function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
}
function baseRequest(dataDir: string): SubagentSpawnRequest {
  return {
    agentName: 'writer',
    worktreeDir: join(tmpdir(), 'fake-worktree'),
    initialInput: '[dispatch envelope]',
    sessionDataDir: dataDir,
    pcSessionId: 'sa-test',
  };
}

// ──────────────────────────── construction ────────────────────────────

test('createLowLevelSpawn receives LowLevelSpawnInput shaped correctly', () => {
  const dataDir = freshDataDir();
  interface Captured {
    agentName: string;
    worktreePath: string;
    mode: string;
    env: Record<string, string>;
    ccProviderSessionId: string;
  }
  const captured: Captured[] = [];
  const mock = makeMockSpawn();
  const timers = makeControllableTimers();

  spawnSubagent(
    {
      ...baseRequest(dataDir),
      agentName: 'researcher',
      extraEnv: { FOO: 'bar' },
      mcpConfigPath: '/tmp/test.mcp.json',
    },
    {
      createLowLevelSpawn: (input) => {
        captured.push({
          agentName: input.podDefinition.name,
          worktreePath: input.worktreePath,
          mode: input.mode,
          env: input.env as Record<string, string>,
          ccProviderSessionId: input.ccProviderSessionId,
        });
        return mock;
      },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    },
  );

  assert.equal(captured.length, 1, 'createLowLevelSpawn called exactly once');
  assert.equal(captured[0]!.agentName, 'researcher');
  assert.equal(captured[0]!.mode, 'fresh');
  assert.ok(mock.started, 'start() must be called');
  cleanup(dataDir);
});

test('Section 19.14 / D39 — spawn env sets PC_AGENT_SESSION_ID = ccProviderSessionId so pc-rig handshake fires', () => {
  // Without this env var, packages/mcp/src/server.ts's `oninitialized` POST
  // to /api/internal/mcp-handshake short-circuits (the handler guards on
  // PC_PROJECT_ID + PC_AGENT_SESSION_ID being set). Three-signal ready gate
  // then never gets the handshake signal → hangs the full ready-timeout
  // window (default 60s) → workflow node fails with `spawn-error: ready
  // failed`. Section 22 fixed this for the dispatched-agent path (agent-run-
  // factory sets the var); the workflow-subagent path missed it until the
  // 19.14 live-fire smoke surfaced the regression.
  const dataDir = freshDataDir();
  let capturedEnv: Record<string, string> = {};
  let capturedCcSessionId = '';
  const mock = makeMockSpawn();
  const timers = makeControllableTimers();

  spawnSubagent(
    {
      ...baseRequest(dataDir),
      agentName: 'researcher',
      extraEnv: { FOO: 'bar' },
    },
    {
      createLowLevelSpawn: (input) => {
        capturedEnv = input.env as Record<string, string>;
        capturedCcSessionId = input.ccProviderSessionId;
        return mock;
      },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    },
  );

  assert.ok(capturedCcSessionId, 'ccProviderSessionId minted');
  assert.equal(
    capturedEnv.PC_AGENT_SESSION_ID,
    capturedCcSessionId,
    'PC_AGENT_SESSION_ID must equal ccProviderSessionId (matches what registerHandshake registers)',
  );
  assert.equal(capturedEnv.PC_SESSION_ID, 'sa-test', 'PC_SESSION_ID survives unchanged');
  assert.equal(capturedEnv.FOO, 'bar', 'extraEnv survives');
  cleanup(dataDir);
});

test('jsonlPath() returns LowLevelSpawn.getJsonlPath() value synchronously', () => {
  const dataDir = freshDataDir();
  const mock = makeMockSpawn();
  mock.setJsonlPath('/fake/abc-123.jsonl');
  const handle = spawnSubagent(baseRequest(dataDir), {
    createLowLevelSpawn: () => mock,
  });
  assert.equal(handle.jsonlPath(), '/fake/abc-123.jsonl');
  handle.kill('cleanup');
  cleanup(dataDir);
});

// ──────────────────────────── happy path ────────────────────────────

test('happy path: ready → send → turn-end → success', async () => {
  const dataDir = freshDataDir();
  const mock = makeMockSpawn();
  mock.setJsonlPath('/fake/session.jsonl');
  const handle = spawnSubagent(baseRequest(dataDir), {
    createLowLevelSpawn: () => mock,
  });

  mock.resolveReady();
  // Wait a microtask cycle for the awaitReady().then() chain to run.
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(mock.sent, ['[dispatch envelope]']);

  mock.emitJsonl({
    kind: 'jsonl-turn-end',
    text: 'wrote the readme',
    stopReason: 'end_turn',
  });

  const result = await handle.done;
  assert.equal(result.kind, 'success');
  if (result.kind === 'success') {
    assert.equal(result.lastAssistantText, 'wrote the readme');
    assert.equal(result.pcCompletePayload, null);
    assert.equal(result.jsonlPath, '/fake/session.jsonl');
    assert.match(result.transcriptPath, /transcript\.log$/);
  }
  assert.ok(mock.killed, 'spawn killed on terminal');
  cleanup(dataDir);
});

// ──────────────────────────── pc_complete_node / pc_node_failed ────────────────────────────

test('pc_complete_node before turn-end → success with payload', async () => {
  const dataDir = freshDataDir();
  const mock = makeMockSpawn();
  const handle = spawnSubagent(baseRequest(dataDir), {
    createLowLevelSpawn: () => mock,
  });

  mock.resolveReady();
  await new Promise((res) => setImmediate(res));
  mock.emitJsonl({
    kind: 'jsonl-tool-call',
    toolUseId: 't1',
    name: 'mcp__pc-rig__pc_complete_node',
    input: { workflowRunId: 'r', nodeId: 'n', output: { summary: 'ok' } },
  });
  mock.emitJsonl({
    kind: 'jsonl-turn-end',
    text: 'done',
    stopReason: 'end_turn',
  });

  const result = await handle.done;
  assert.equal(result.kind, 'success');
  if (result.kind === 'success') {
    assert.deepEqual(result.pcCompletePayload, { summary: 'ok' });
    assert.equal(result.lastAssistantText, 'done');
  }
  cleanup(dataDir);
});

test('pc_node_failed wins over text turn-end', async () => {
  const dataDir = freshDataDir();
  const mock = makeMockSpawn();
  const handle = spawnSubagent(baseRequest(dataDir), {
    createLowLevelSpawn: () => mock,
  });

  mock.resolveReady();
  await new Promise((res) => setImmediate(res));
  mock.emitJsonl({
    kind: 'jsonl-tool-call',
    toolUseId: 't1',
    name: 'mcp__pc-rig__pc_node_failed',
    input: { workflowRunId: 'r', nodeId: 'n', reason: 'data was malformed' },
  });
  mock.emitJsonl({
    kind: 'jsonl-turn-end',
    text: 'I tried but failed',
    stopReason: 'end_turn',
  });

  const result = await handle.done;
  assert.equal(result.kind, 'failure');
  if (result.kind === 'failure') {
    assert.equal(result.cause, 'mcp-tool-error');
    assert.match(result.message, /data was malformed/);
    assert.equal(result.partialAssistantText, 'I tried but failed');
  }
  cleanup(dataDir);
});

test('empty-turn fails when no text + no pc_complete_node payload', async () => {
  const dataDir = freshDataDir();
  const mock = makeMockSpawn();
  const handle = spawnSubagent(baseRequest(dataDir), {
    createLowLevelSpawn: () => mock,
  });

  mock.resolveReady();
  await new Promise((res) => setImmediate(res));
  mock.emitJsonl({ kind: 'jsonl-turn-end', text: '', stopReason: 'end_turn' });

  const result = await handle.done;
  assert.equal(result.kind, 'failure');
  if (result.kind === 'failure') {
    assert.equal(result.cause, 'empty-turn');
  }
  cleanup(dataDir);
});

// ──────────────────────────── lifecycle: kill, idle, exit ────────────────────────────

test('kill() before terminal → failure with cause=killed', async () => {
  const dataDir = freshDataDir();
  const mock = makeMockSpawn();
  const handle = spawnSubagent(baseRequest(dataDir), {
    createLowLevelSpawn: () => mock,
  });

  handle.kill('cancelled by user');
  const result = await handle.done;
  assert.equal(result.kind, 'failure');
  if (result.kind === 'failure') {
    assert.equal(result.cause, 'killed');
    assert.match(result.message, /cancelled by user/);
  }
  cleanup(dataDir);
});

test('idle timer fires → failure with cause=idle-timeout', async () => {
  const dataDir = freshDataDir();
  const mock = makeMockSpawn();
  const timers = makeControllableTimers();
  const handle = spawnSubagent(
    { ...baseRequest(dataDir), idleTimeoutMs: 1000 },
    {
      createLowLevelSpawn: () => mock,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    },
  );

  // After construction we have two pending timers: wall-clock (1st) +
  // idle (2nd). Fire the idle one directly.
  const idle = timers.pending().find((t) => t.ms === 1000);
  assert.ok(idle, 'idle timer scheduled');
  timers.fireById(idle!.id);

  const result = await handle.done;
  assert.equal(result.kind, 'failure');
  if (result.kind === 'failure') {
    assert.equal(result.cause, 'idle-timeout');
  }
  cleanup(dataDir);
});

test('wall-clock timer fires → failure with cause=wall-clock-timeout', async () => {
  const dataDir = freshDataDir();
  const mock = makeMockSpawn();
  const timers = makeControllableTimers();
  const handle = spawnSubagent(
    { ...baseRequest(dataDir), wallClockTimeoutMs: 50_000 },
    {
      createLowLevelSpawn: () => mock,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    },
  );

  const wall = timers.pending().find((t) => t.ms === 50_000);
  assert.ok(wall, 'wall-clock timer scheduled');
  timers.fireById(wall!.id);

  const result = await handle.done;
  assert.equal(result.kind, 'failure');
  if (result.kind === 'failure') {
    assert.equal(result.cause, 'wall-clock-timeout');
  }
  cleanup(dataDir);
});

test('unexpected exit before turn-end → failure with cause=spawn-error', async () => {
  const dataDir = freshDataDir();
  const mock = makeMockSpawn();
  const handle = spawnSubagent(baseRequest(dataDir), {
    createLowLevelSpawn: () => mock,
  });

  mock.resolveReady();
  await new Promise((res) => setImmediate(res));
  mock.emitExit(1, null);

  const result = await handle.done;
  assert.equal(result.kind, 'failure');
  if (result.kind === 'failure') {
    assert.equal(result.cause, 'spawn-error');
    assert.match(result.message, /helper exited unexpectedly/);
  }
  cleanup(dataDir);
});

test('createLowLevelSpawn throws → failure with cause=spawn-error', async () => {
  const dataDir = freshDataDir();
  const handle = spawnSubagent(baseRequest(dataDir), {
    createLowLevelSpawn: () => {
      throw new Error('pty failed to spawn');
    },
  });

  const result = await handle.done;
  assert.equal(result.kind, 'failure');
  if (result.kind === 'failure') {
    assert.equal(result.cause, 'spawn-error');
    assert.match(result.message, /pty failed to spawn/);
  }
  cleanup(dataDir);
});

// ──────────────────────────── handshake routing ────────────────────────────

test('registerHandshakeListener is wired with ccSessionId + invokes notifyMcpHandshake', () => {
  const dataDir = freshDataDir();
  const mock = makeMockSpawn();
  let registeredCcSession: string | null = null;
  let registeredNotify: (() => void) | null = null;
  let unregisterCalled = false;

  const handle = spawnSubagent(baseRequest(dataDir), {
    createLowLevelSpawn: () => mock,
    registerHandshakeListener: (ccSessionId, notify) => {
      registeredCcSession = ccSessionId;
      registeredNotify = notify;
      return () => {
        unregisterCalled = true;
      };
    },
  });

  assert.ok(registeredCcSession, 'handshake listener registered');
  assert.match(registeredCcSession!, /^[0-9a-f-]{36}$/, 'ccSessionId is a UUID');

  registeredNotify!();
  assert.ok(mock.handshakeFired, 'spawn.notifyMcpHandshake invoked');

  handle.kill('cleanup');
  assert.ok(unregisterCalled, 'unregister fires on terminal');
  cleanup(dataDir);
});

// ──────────────────────────── handle API stays v1-compatible ────────────────────────────

test('SubagentSpawnHandle surface matches v1 (done, kill, transcriptPath, jsonlPath)', async () => {
  const dataDir = freshDataDir();
  const mock = makeMockSpawn();
  const handle = spawnSubagent(baseRequest(dataDir), {
    createLowLevelSpawn: () => mock,
  });

  assert.equal(typeof handle.done.then, 'function');
  assert.equal(typeof handle.kill, 'function');
  assert.equal(typeof handle.transcriptPath, 'function');
  assert.equal(typeof handle.jsonlPath, 'function');

  handle.kill('cleanup');
  await handle.done;
  cleanup(dataDir);
});
