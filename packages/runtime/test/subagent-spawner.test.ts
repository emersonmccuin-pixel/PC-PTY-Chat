// Unit tests for spawnSubagent (Section 4d.1).
//
// The spawner composes a session and resolves a `done` promise based on the
// session's event stream. We mock the session with an EventEmitter that emits
// the same shape PtySession emits — no real claude.exe spawn.
//
// Run via:  pnpm --filter @pc/runtime test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  spawnSubagent,
  type SubagentSessionLike,
  type SubagentSpawnResult,
} from '../src/subagent-spawner.ts';
import type { PtySessionOptions, SessionState } from '../src/pty-session.ts';
import type { JsonlEvent } from '../src/jsonl-tailer.ts';

interface MockSession extends SubagentSessionLike {
  sent: string[];
  killed: boolean;
  setState(state: SessionState): void;
  emitJsonl(ev: JsonlEvent): void;
  emitJsonlPathResolved(path: string): void;
  emitExit(code: number | null, signal: string | null): void;
}

function makeMockSession(): MockSession {
  const emitter = new EventEmitter() as MockSession;
  emitter.sent = [];
  emitter.killed = false;
  emitter.send = (text: string) => {
    emitter.sent.push(text);
  };
  emitter.kill = () => {
    emitter.killed = true;
  };
  emitter.getState = () => 'spawning';
  emitter.setState = (state: SessionState) => emitter.emit('state', state);
  emitter.emitJsonl = (ev: JsonlEvent) => emitter.emit('jsonl-event', ev);
  emitter.emitJsonlPathResolved = (path: string) => emitter.emit('jsonl-path-resolved', path);
  emitter.emitExit = (code, signal) => emitter.emit('exit', code, signal);
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
      return { id, cb, ms };
    },
    clearTimeout(handle) {
      if (!handle || typeof handle !== 'object') return;
      const id = (handle as { id?: number }).id;
      if (typeof id === 'number') map.delete(id);
    },
    fireById(id) {
      const entry = map.get(id);
      if (!entry) throw new Error(`no timer with id ${id}`);
      map.delete(id);
      entry.cb();
    },
    pending() {
      return [...map.entries()].map(([id, { ms }]) => ({ id, ms }));
    },
  };
}

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'pc-spawner-'));
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
}

function baseRequest(dataDir: string): Parameters<typeof spawnSubagent>[0] {
  return {
    agentName: 'writer',
    worktreeDir: join(tmpdir(), 'fake-worktree'),
    initialInput: '[dispatch envelope]',
    sessionDataDir: dataDir,
    pcSessionId: 'sa-test',
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Construction
// ─────────────────────────────────────────────────────────────────────────

test('spawn shape: passes agentName + loadDevChannels=false + sessionDataDir paths', () => {
  const dataDir = freshDataDir();
  let captured: PtySessionOptions | null = null;
  const mock = makeMockSession();
  const timers = makeControllableTimers();
  const handle = spawnSubagent(
    {
      ...baseRequest(dataDir),
      agentName: 'researcher',
      model: 'sonnet',
      extraEnv: { FOO: 'bar' },
      excludeJsonlPaths: ['/a.jsonl'],
    },
    {
      createSession: (opts) => {
        captured = opts;
        return mock;
      },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    },
  );
  assert.ok(captured, 'createSession was called');
  const opts = captured as unknown as PtySessionOptions;
  assert.equal(opts.agentName, 'researcher');
  assert.equal(opts.model, 'sonnet');
  assert.equal(opts.loadDevChannels, false);
  assert.equal(opts.workspaceDir, baseRequest(dataDir).worktreeDir);
  assert.deepEqual(opts.extraEnv, { FOO: 'bar', PC_SESSION_ID: 'sa-test' });
  assert.deepEqual(opts.excludeJsonlPaths, ['/a.jsonl']);
  assert.match(opts.transcriptPath, /transcript\.log$/);
  assert.match(opts.stopMarkerPath, /stop-markers\.txt$/);
  assert.match(opts.eventsPath, /events\.jsonl$/);
  handle.kill('cleanup');
  cleanup(dataDir);
});

// ─────────────────────────────────────────────────────────────────────────
// Happy path — text-only turn end
// ─────────────────────────────────────────────────────────────────────────

test('happy path: ready → send → jsonl-turn-end with text → success', async () => {
  const dataDir = freshDataDir();
  const mock = makeMockSession();
  const handle = spawnSubagent(baseRequest(dataDir), { createSession: () => mock });

  mock.setState('ready');
  assert.deepEqual(mock.sent, ['[dispatch envelope]']);
  mock.emitJsonlPathResolved('/fake/session.jsonl');
  mock.emitJsonl({ kind: 'jsonl-turn-end', text: 'wrote the readme', stopReason: 'end_turn' });

  const result = await handle.done;
  assert.equal(result.kind, 'success');
  if (result.kind === 'success') {
    assert.equal(result.lastAssistantText, 'wrote the readme');
    assert.equal(result.pcCompletePayload, null);
    assert.equal(result.jsonlPath, '/fake/session.jsonl');
    assert.match(result.transcriptPath, /transcript\.log$/);
  }
  assert.equal(mock.killed, true, 'session killed on resolve');
  cleanup(dataDir);
});

test('send error during ready → spawn-error failure', async () => {
  const dataDir = freshDataDir();
  const mock = makeMockSession();
  mock.send = () => {
    throw new Error('pipe broken');
  };
  const handle = spawnSubagent(baseRequest(dataDir), { createSession: () => mock });
  mock.setState('ready');
  const result = await handle.done;
  assert.equal(result.kind, 'failure');
  if (result.kind === 'failure') {
    assert.equal(result.cause, 'spawn-error');
    assert.match(result.message, /pipe broken/);
  }
  cleanup(dataDir);
});

// ─────────────────────────────────────────────────────────────────────────
// pc_complete_node / pc_node_failed handling
// ─────────────────────────────────────────────────────────────────────────

test('pc_complete_node before turn-end → success with payload + text', async () => {
  const dataDir = freshDataDir();
  const mock = makeMockSession();
  const handle = spawnSubagent(baseRequest(dataDir), { createSession: () => mock });
  mock.setState('ready');
  mock.emitJsonl({
    kind: 'jsonl-tool-call',
    toolUseId: 't1',
    name: 'mcp__pc-rig__pc_complete_node',
    input: { workflowRunId: 'r', nodeId: 'n', output: { summary: 'ok' } },
  });
  mock.emitJsonl({ kind: 'jsonl-turn-end', text: 'all done', stopReason: 'end_turn' });
  const result = await handle.done;
  assert.equal(result.kind, 'success');
  if (result.kind === 'success') {
    assert.deepEqual(result.pcCompletePayload, { summary: 'ok' });
    assert.equal(result.lastAssistantText, 'all done');
  }
  cleanup(dataDir);
});

test('pc_node_failed wins even when helper produces text', async () => {
  const dataDir = freshDataDir();
  const mock = makeMockSession();
  const handle = spawnSubagent(baseRequest(dataDir), { createSession: () => mock });
  mock.setState('ready');
  mock.emitJsonl({
    kind: 'jsonl-tool-call',
    toolUseId: 't1',
    name: 'mcp__pc-rig__pc_node_failed',
    input: { workflowRunId: 'r', nodeId: 'n', reason: 'data was malformed' },
  });
  mock.emitJsonl({ kind: 'jsonl-turn-end', text: 'I tried but failed', stopReason: 'end_turn' });
  const result = await handle.done;
  assert.equal(result.kind, 'failure');
  if (result.kind === 'failure') {
    assert.equal(result.cause, 'mcp-tool-error');
    assert.match(result.message, /data was malformed/);
    assert.equal(result.partialAssistantText, 'I tried but failed');
  }
  cleanup(dataDir);
});

test('latest pc_complete_node payload overrides earlier ones', async () => {
  const dataDir = freshDataDir();
  const mock = makeMockSession();
  const handle = spawnSubagent(baseRequest(dataDir), { createSession: () => mock });
  mock.setState('ready');
  mock.emitJsonl({
    kind: 'jsonl-tool-call',
    toolUseId: 't1',
    name: 'mcp__pc-rig__pc_complete_node',
    input: { output: 'first' },
  });
  mock.emitJsonl({
    kind: 'jsonl-tool-call',
    toolUseId: 't2',
    name: 'mcp__pc-rig__pc_complete_node',
    input: { output: 'second' },
  });
  mock.emitJsonl({ kind: 'jsonl-turn-end', text: '', stopReason: 'end_turn' });
  const result = await handle.done;
  assert.equal(result.kind, 'success');
  if (result.kind === 'success') {
    assert.equal(result.pcCompletePayload, 'second');
  }
  cleanup(dataDir);
});

// ─────────────────────────────────────────────────────────────────────────
// Empty turn
// ─────────────────────────────────────────────────────────────────────────

test('empty jsonl-turn-end with no pc_complete_node → empty-turn failure', async () => {
  const dataDir = freshDataDir();
  const mock = makeMockSession();
  const handle = spawnSubagent(baseRequest(dataDir), { createSession: () => mock });
  mock.setState('ready');
  mock.emitJsonl({ kind: 'jsonl-turn-end', text: '', stopReason: 'end_turn' });
  const result = await handle.done;
  assert.equal(result.kind, 'failure');
  if (result.kind === 'failure') {
    assert.equal(result.cause, 'empty-turn');
  }
  cleanup(dataDir);
});

test('empty jsonl-turn-end but pc_complete_node was called → success', async () => {
  const dataDir = freshDataDir();
  const mock = makeMockSession();
  const handle = spawnSubagent(baseRequest(dataDir), { createSession: () => mock });
  mock.setState('ready');
  mock.emitJsonl({
    kind: 'jsonl-tool-call',
    toolUseId: 't1',
    name: 'mcp__pc-rig__pc_complete_node',
    input: { output: { done: true } },
  });
  mock.emitJsonl({ kind: 'jsonl-turn-end', text: '', stopReason: 'end_turn' });
  const result = await handle.done;
  assert.equal(result.kind, 'success');
  if (result.kind === 'success') {
    assert.deepEqual(result.pcCompletePayload, { done: true });
    assert.equal(result.lastAssistantText, '');
  }
  cleanup(dataDir);
});

// ─────────────────────────────────────────────────────────────────────────
// Timeouts (D47)
// ─────────────────────────────────────────────────────────────────────────

test('idle timer fires → idle-timeout failure', async () => {
  const dataDir = freshDataDir();
  const mock = makeMockSession();
  const timers = makeControllableTimers();
  const handle = spawnSubagent(
    { ...baseRequest(dataDir), idleTimeoutMs: 1000, wallClockTimeoutMs: 60_000 },
    {
      createSession: () => mock,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    },
  );
  // Two timers pending: idle (1000ms) + wall-clock (60000ms).
  const pending = timers.pending();
  const idle = pending.find((t) => t.ms === 1000)!;
  assert.ok(idle);
  timers.fireById(idle.id);
  const result = await handle.done;
  assert.equal(result.kind, 'failure');
  if (result.kind === 'failure') {
    assert.equal(result.cause, 'idle-timeout');
  }
  cleanup(dataDir);
});

test('jsonl event resets idle timer', () => {
  const dataDir = freshDataDir();
  const mock = makeMockSession();
  const timers = makeControllableTimers();
  spawnSubagent(
    { ...baseRequest(dataDir), idleTimeoutMs: 1000, wallClockTimeoutMs: 60_000 },
    {
      createSession: () => mock,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    },
  );
  const firstIdle = timers.pending().find((t) => t.ms === 1000)!;
  mock.emitJsonl({ kind: 'jsonl-user', text: 'go' });
  // First idle timer should be gone; a new one with the same duration replaces it.
  const idleTimers = timers.pending().filter((t) => t.ms === 1000);
  assert.equal(idleTimers.length, 1, 'exactly one idle timer remains');
  assert.notEqual(idleTimers[0].id, firstIdle.id, 'a fresh timer replaced the old one');
  cleanup(dataDir);
});

test('wall-clock timer fires → wall-clock-timeout failure', async () => {
  const dataDir = freshDataDir();
  const mock = makeMockSession();
  const timers = makeControllableTimers();
  const handle = spawnSubagent(
    { ...baseRequest(dataDir), idleTimeoutMs: 60_000, wallClockTimeoutMs: 1000 },
    {
      createSession: () => mock,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    },
  );
  const wall = timers.pending().find((t) => t.ms === 1000)!;
  timers.fireById(wall.id);
  const result = await handle.done;
  assert.equal(result.kind, 'failure');
  if (result.kind === 'failure') {
    assert.equal(result.cause, 'wall-clock-timeout');
  }
  cleanup(dataDir);
});

// ─────────────────────────────────────────────────────────────────────────
// Spawn errors
// ─────────────────────────────────────────────────────────────────────────

test('createSession throws → spawn-error failure', async () => {
  const dataDir = freshDataDir();
  const handle = spawnSubagent(baseRequest(dataDir), {
    createSession: () => {
      throw new Error('claude.exe not found');
    },
  });
  const result = await handle.done;
  assert.equal(result.kind, 'failure');
  if (result.kind === 'failure') {
    assert.equal(result.cause, 'spawn-error');
    assert.match(result.message, /claude\.exe not found/);
    assert.equal(result.jsonlPath, null);
  }
  cleanup(dataDir);
});

test('session exits before turn-end → spawn-error failure', async () => {
  const dataDir = freshDataDir();
  const mock = makeMockSession();
  const handle = spawnSubagent(baseRequest(dataDir), { createSession: () => mock });
  mock.emitExit(1, null);
  const result = await handle.done;
  assert.equal(result.kind, 'failure');
  if (result.kind === 'failure') {
    assert.equal(result.cause, 'spawn-error');
    assert.match(result.message, /exited unexpectedly/);
  }
  cleanup(dataDir);
});

// ─────────────────────────────────────────────────────────────────────────
// kill()
// ─────────────────────────────────────────────────────────────────────────

test('kill() before resolve → killed failure', async () => {
  const dataDir = freshDataDir();
  const mock = makeMockSession();
  const handle = spawnSubagent(baseRequest(dataDir), { createSession: () => mock });
  handle.kill('user cancelled');
  const result = await handle.done;
  assert.equal(result.kind, 'failure');
  if (result.kind === 'failure') {
    assert.equal(result.cause, 'killed');
    assert.match(result.message, /user cancelled/);
  }
  cleanup(dataDir);
});

test('kill() after resolve is a no-op', async () => {
  const dataDir = freshDataDir();
  const mock = makeMockSession();
  const handle = spawnSubagent(baseRequest(dataDir), { createSession: () => mock });
  mock.setState('ready');
  mock.emitJsonl({ kind: 'jsonl-turn-end', text: 'ok', stopReason: 'end_turn' });
  const first = await handle.done;
  handle.kill('too late');
  // Race the original promise against a sentinel — the result must remain
  // the success we already saw.
  const sentinel = Symbol('unchanged');
  const second = await Promise.race<SubagentSpawnResult | typeof sentinel>([
    handle.done,
    Promise.resolve(sentinel as unknown as SubagentSpawnResult),
  ]);
  assert.equal(second, first, 'done is stable after first resolve');
  cleanup(dataDir);
});

// ─────────────────────────────────────────────────────────────────────────
// jsonlPath accessor
// ─────────────────────────────────────────────────────────────────────────

test('jsonlPath() returns null before discovery, path after', () => {
  const dataDir = freshDataDir();
  const mock = makeMockSession();
  const timers = makeControllableTimers();
  const handle = spawnSubagent(baseRequest(dataDir), {
    createSession: () => mock,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  assert.equal(handle.jsonlPath(), null);
  mock.emitJsonlPathResolved('/abs/session.jsonl');
  assert.equal(handle.jsonlPath(), '/abs/session.jsonl');
  handle.kill('cleanup');
  cleanup(dataDir);
});
