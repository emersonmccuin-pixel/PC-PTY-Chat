// Section 16b.4.1 unit tests — agent-run lifecycle manager.
//
// Exercises spawn → ready → turn-end → completed (no pause), pause via a
// waiting pending-ask, resume via attachResumedSession, cancel, idle
// timeout, spawn-exit-before-terminal. Real PtySession isn't booted —
// fake session factory emits the same events. End-to-end smoke (real
// claude.exe + JSONL + HTTP path) lands in 16b.13.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDataDir = mkdtempSync(join(tmpdir(), 'pc-agent-run-manager-'));
process.env.PC_DATA_DIR = tmpDataDir;

const {
  closeDb,
  newId,
  runMigrations,
  createProject,
  createPendingAsk,
  markPendingAskAnswered,
} = await import('@pc/db');
import type { Stage, ULID } from '@pc/domain';

import {
  AgentRunManager,
  type AgentSessionLike,
} from '../src/services/agent-run-manager.ts';
import type { PtySessionOptions, SessionState, JsonlEvent } from '@pc/runtime';

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

class FakeSession extends EventEmitter implements AgentSessionLike {
  sent: string[] = [];
  killed = false;
  state: SessionState = 'spawning';
  lastOpts: PtySessionOptions;
  constructor(opts: PtySessionOptions) {
    super();
    this.lastOpts = opts;
  }
  send(text: string): void {
    this.sent.push(text);
  }
  kill(): void {
    this.killed = true;
    this.state = 'exited';
    // Emit exit so the manager's handler runs. Defer so callers can sequence
    // assertions before the exit handler fires.
    setImmediate(() => this.emit('exit', 0, null));
  }
  getState(): SessionState {
    return this.state;
  }
  /** Emit ready synchronously after defer so the manager's listener (wired
   *  AFTER the constructor returns) is in place. */
  becomeReady(): void {
    this.state = 'ready';
    this.emit('state', 'ready');
  }
  emitTurnEnd(text: string): void {
    const ev: JsonlEvent = { kind: 'jsonl-turn-end', text, stopReason: 'end_turn' };
    this.emit('jsonl-event', ev);
  }
  emitToolCall(name: string, input: unknown): void {
    const ev: JsonlEvent = { kind: 'jsonl-tool-call', toolUseId: 'tu-1', name, input };
    this.emit('jsonl-event', ev);
  }
}

function makeFactory() {
  const sessions: FakeSession[] = [];
  const factory = (opts: PtySessionOptions): AgentSessionLike => {
    const s = new FakeSession(opts);
    sessions.push(s);
    return s;
  };
  return { factory, sessions };
}

/** Yield to the event loop so setImmediate-deferred emits (e.g. from
 *  session.kill → exit) land before assertions. */
async function tick(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

test('spawn → ready → turn-end with no pending-ask → completed', async () => {
  const p = createProject({
    slug: 'arm-happy',
    name: 'ARM Happy',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { runId, completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'find a lib for date math',
    wait: true,
    projectId: p.id as ULID,
    worktreeDir: tmpDataDir,
  });

  // One session created with the right env-var threading.
  assert.equal(sessions.length, 1);
  const s = sessions[0]!;
  assert.equal(s.lastOpts.agentName, 'researcher');
  assert.equal(s.lastOpts.resume, false);
  assert.equal(typeof s.lastOpts.claudeSessionId, 'string');
  assert.equal(s.lastOpts.extraEnv?.PC_AGENT_NAME, 'researcher');
  assert.equal(s.lastOpts.extraEnv?.PC_AGENT_RUN_ID, runId);
  assert.equal(s.lastOpts.extraEnv?.PC_PROJECT_ID, p.id);

  // Drive: ready → manager sends input → turn-end.
  s.becomeReady();
  assert.deepEqual(s.sent, ['find a lib for date math']);

  s.emitTurnEnd('use date-fns');
  const result = await completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'use date-fns');
  assert.equal(result.failureCause, null);
  assert.equal(result.runId, runId);
  await tick(); // let kill→exit fire
  assert.equal(s.killed, true);
});

test('turn-end with a waiting pending-ask → paused (no terminal yet); resume → completed', async () => {
  const p = createProject({
    slug: 'arm-pause',
    name: 'ARM Pause',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-pause', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { runId, sessionId, completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'find a lib',
    wait: true,
    projectId: p.id as ULID,
    worktreeDir: tmpDataDir,
  });

  const s = sessions[0]!;
  s.becomeReady();

  // Simulate the pc_ask_orchestrator flow: row created BEFORE the agent's
  // turn-end fires.
  const pendingAskId = newId();
  createPendingAsk({
    id: pendingAskId,
    sessionId,
    agentName: 'researcher',
    projectId: p.id as ULID,
    kind: 'ask-orchestrator',
    question: 'which one?',
    now: Date.now(),
  });

  s.emitTurnEnd('asking the orchestrator now');

  // Status should be 'paused', completion should NOT have resolved.
  const rec = mgr.get(runId)!;
  assert.equal(rec.status, 'paused');
  // Session was killed (process exits after natural turn-end on pause).
  await tick();
  assert.equal(s.killed, true);

  // The completion Promise must still be pending. Race a marker against it.
  const racePending = await Promise.race([
    completion.then(() => 'resolved' as const),
    new Promise<'pending'>((r) => setImmediate(() => r('pending'))),
  ]);
  assert.equal(racePending, 'pending');

  // Orchestrator answers via the resume primitive's path: flip the row,
  // then attach a freshly-spawned session.
  markPendingAskAnswered({
    id: pendingAskId,
    answer: 'use date-fns',
    answeredBy: 'orchestrator',
    now: Date.now(),
  });

  const resumed = new FakeSession({
    workspaceDir: tmpDataDir,
    stopMarkerPath: '/tmp/x',
    eventsPath: '/tmp/y',
    transcriptPath: '/tmp/z',
    claudeSessionId: sessionId,
    resume: true,
  });
  const attached = mgr.attachResumedSession(runId, resumed);
  assert.equal(attached, true);

  // Resumed session reaches ready (no initial-input send — respawn already
  // wrote the answer as the next user message).
  resumed.becomeReady();
  assert.deepEqual(resumed.sent, [], 'manager does not double-send on resume');

  // Now the agent finishes for real. No new pending-ask in waiting state →
  // terminal complete.
  resumed.emitTurnEnd('final answer: use date-fns');
  const result = await completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'final answer: use date-fns');
});

test('cancel before terminal → status=cancelled, completion resolves', async () => {
  const p = createProject({
    slug: 'arm-cancel',
    name: 'ARM Cancel',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-cancel', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { runId, completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'go',
    wait: true,
    projectId: p.id as ULID,
    worktreeDir: tmpDataDir,
  });

  const s = sessions[0]!;
  s.becomeReady();

  const cancelled = mgr.cancel(runId, 'user clicked cancel');
  assert.equal(cancelled, true);
  const result = await completion;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.failureCause, 'cancelled');
  assert.equal(result.failureReason, 'user clicked cancel');
  await tick();
  assert.equal(s.killed, true);

  // Second cancel is a no-op.
  assert.equal(mgr.cancel(runId, 'again'), false);
});

test('idle-timeout → failed with cause=idle-timeout', async () => {
  const p = createProject({
    slug: 'arm-idle',
    name: 'ARM Idle',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();

  // Stub timers so we can trigger idle synchronously.
  const idleFires: Array<{ cb: () => void; ms: number }> = [];
  const handles = new Map<unknown, { cb: () => void }>();
  let nextHandle = 1;
  const mgr = new AgentRunManager({
    createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-idle', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
    setTimeout: (cb, ms) => {
      const h = nextHandle++;
      const entry = { cb };
      handles.set(h, entry);
      idleFires.push({ cb, ms });
      return h;
    },
    clearTimeout: (h) => {
      handles.delete(h);
    },
  });

  const { runId, completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'go',
    wait: true,
    projectId: p.id as ULID,
    worktreeDir: tmpDataDir,
    idleTimeoutMs: 1000,
    wallClockTimeoutMs: 60_000,
  });

  const s = sessions[0]!;
  s.becomeReady();

  // Find the most-recently armed idle timer (last entry, since wall-clock
  // was armed first then idle).
  const idleEntry = idleFires[idleFires.length - 1]!;
  assert.equal(idleEntry.ms, 1000);
  // Fire it.
  idleEntry.cb();

  const result = await completion;
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCause, 'idle-timeout');
  assert.equal(result.runId, runId);
});

test('session exit before turn-end → failed with cause=spawn-exit', async () => {
  const p = createProject({
    slug: 'arm-exit',
    name: 'ARM Exit',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-exit', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'go',
    wait: true,
    projectId: p.id as ULID,
    worktreeDir: tmpDataDir,
  });

  const s = sessions[0]!;
  s.becomeReady();
  // Process dies unexpectedly mid-turn.
  s.emit('exit', 1, null);

  const result = await completion;
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCause, 'spawn-exit');
});

test('findRunIdBySession returns the live tracked runId; null after terminal', async () => {
  const p = createProject({
    slug: 'arm-find',
    name: 'ARM Find',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-find', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { runId, sessionId, completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'go',
    wait: true,
    projectId: p.id as ULID,
    worktreeDir: tmpDataDir,
  });

  assert.equal(mgr.findRunIdBySession(sessionId), runId);

  const s = sessions[0]!;
  s.becomeReady();
  s.emitTurnEnd('done');
  await completion;

  assert.equal(mgr.findRunIdBySession(sessionId), null, 'terminal runs are not findable');
});
