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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  getAgentRunRow,
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
  // B4 (2026-05-21) — agent-name resolution check requires a pod row OR a
  // flat-file agent .md in the worktree. Tests pass `worktreeDir: tmpDataDir`
  // and various names (`researcher`, `a1`, `a2`); write stubs so the spawn
  // doesn't fail-fast with cause='unknown-agent'.
  mkdirSync(join(tmpDataDir, '.claude', 'agents'), { recursive: true });
  for (const name of ['researcher', 'a1', 'a2']) {
    writeFileSync(join(tmpDataDir, '.claude', 'agents', `${name}.md`), `# ${name} (test stub)\n`);
  }
});

after(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

class FakeSession extends EventEmitter implements AgentSessionLike {
  sent: string[] = [];
  /** Section 20.C — count of bare-Enter kicks the manager re-sent. */
  kicks = 0;
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
  kick(): void {
    this.kicks++;
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
    warmupPrompt: null, createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { runId, completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'find a lib for date math',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'test-dispatcher-session',
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

// 18.B-mcp-race (2026-05-21) — CC's `--agent` mode binds the model's tool
// surface before MCP children finish registering. PC's agent dispatch
// previously fired the user prompt at PTY-ready and hit the race every
// time. Fix: send a warmup turn first; send the real initialInput on the
// warmup's `jsonl-turn-end`. The warmup turn shouldn't satisfy the 18.6
// ack contract either — `firstJsonlAt` is gated on `initialInputSent`.
test('warmup turn defers initialInput until first turn-end (18.B-mcp-race)', async () => {
  const p = createProject({
    slug: 'arm-warmup',
    name: 'ARM Warmup',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    // No `warmupPrompt:` override → default warmup is active.
    createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-warmup', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { runId, completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'find a lib for date math',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'warmup-dispatcher',
    worktreeDir: tmpDataDir,
    // Section 22 — this test exercises the warmup-then-real-input flow
    // (18.B-mcp-race), not the new handshake-gate. Skip the handshake
    // wait so warmup fires immediately on ready, same as pre-Section-22.
    mcpHandshakeTimeoutMs: 0,
  });

  assert.equal(sessions.length, 1);
  const s = sessions[0]!;

  // Ready → warmup sent first (NOT the real input). Status stays
  // 'spawning' through the warmup; firstJsonlAt is still null.
  s.becomeReady();
  assert.equal(s.sent.length, 1, 'only the warmup is queued after ready');
  assert.equal(
    s.sent[0],
    'Reply with only the word OK.',
    'first send is the canonical warmup prompt',
  );
  const recAfterReady = mgr.get(runId);
  assert.equal(recAfterReady?.status, 'spawning', 'status held at spawning through warmup');

  // Simulate the warmup turn-end. Manager now sends the real input + flips
  // to running.
  s.emitTurnEnd('OK');
  assert.deepEqual(
    s.sent,
    ['Reply with only the word OK.', 'find a lib for date math'],
    'real initialInput sent on warmup turn-end',
  );
  assert.equal(mgr.get(runId)?.status, 'running', 'status now running');

  // Real turn-end completes the run.
  s.emitTurnEnd('use date-fns');
  const result = await completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'use date-fns');
  await tick();
  assert.equal(s.killed, true);
});

// B7 regression (2026-05-21) — agents that live ONLY in the global library
// at `~/.project-companion/agents/<name>.md` (Section 3 stock globals) must
// be materialised into `<worktree>/.claude/agents/<name>.md` at spawn time
// so CC's `--agent` flag can find them, and cleaned up on terminal.
test('global flat-file agent → materialised into worktree before spawn; cleaned up on terminal', async () => {
  const p = createProject({
    slug: 'arm-b7',
    name: 'ARM B7',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();

  // Use an isolated worktree that does NOT have a `.claude/agents/` set up
  // from the before() block — that's the trigger for the global-flat-file
  // path (worktree has no project override).
  const isolatedWorktree = join(tmpDataDir, 'arm-b7-worktree');
  mkdirSync(isolatedWorktree, { recursive: true });

  // Set up a global library with our test agent.
  const libDir = join(tmpDataDir, 'arm-b7-lib');
  mkdirSync(libDir, { recursive: true });
  writeFileSync(join(libDir, 'b7-global.md'), '# b7-global agent (library fixture)\n');
  const prevLibEnv = process.env.PC_AGENT_LIBRARY_DIR;
  process.env.PC_AGENT_LIBRARY_DIR = libDir;

  try {
    const mgr = new AgentRunManager({
      warmupPrompt: null, createSession: factory,
      scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-b7', pid, rid),
      resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
    });

    const { runId, completion } = mgr.spawn({
      agentName: 'b7-global',
      input: 'go',
      wait: true,
      projectId: p.id as ULID,
      dispatcherSessionId: 'test-dispatcher-session',
      worktreeDir: isolatedWorktree,
    });

    // Materialisation must land BEFORE the PtySession reaches ready (CC reads
    // `.claude/agents/` at startup). Assert immediately after spawn().
    const materializedPath = join(isolatedWorktree, '.claude', 'agents', 'b7-global.md');
    assert.equal(
      existsSync(materializedPath),
      true,
      'b7-global.md should be materialised into the worktree at spawn time',
    );

    sessions[0]!.becomeReady();
    sessions[0]!.emitTurnEnd('done');
    const result = await completion;
    assert.equal(result.status, 'completed');
    assert.equal(result.runId, runId);

    // Cleanup on terminal: the materialised file should be gone.
    await tick();
    assert.equal(
      existsSync(materializedPath),
      false,
      'materialised b7-global.md should be removed on terminal',
    );
  } finally {
    if (prevLibEnv === undefined) delete process.env.PC_AGENT_LIBRARY_DIR;
    else process.env.PC_AGENT_LIBRARY_DIR = prevLibEnv;
  }
});

// B4 regression (2026-05-21) — unknown agent names must fail fast with
// cause='unknown-agent'. Without this, `--agent <unknown>` silently falls
// through to CC's default coding-assistant prompt and the dispatch returns
// whatever that CC happens to say (looks like agent-completed to the caller).
test('unknown agent name → fail immediately with cause=unknown-agent (no session spawned)', async () => {
  const p = createProject({
    slug: 'arm-unknown',
    name: 'ARM Unknown',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    warmupPrompt: null, createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-unknown', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { completion } = mgr.spawn({
    agentName: 'no-such-agent',
    input: 'anything',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'test-dispatcher-session',
    worktreeDir: tmpDataDir,
  });

  const result = await completion;
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCause, 'unknown-agent');
  assert.match(
    result.failureReason ?? '',
    /no agent named "no-such-agent"/,
    `expected failure reason to name the missing agent, got: ${result.failureReason}`,
  );
  assert.equal(sessions.length, 0, 'no PtySession should be created for an unknown agent');
});

// B1 regression (2026-05-20) — Opus 4.7 interleaved thinking emits a
// thinking-only assistant message (no text content blocks → turn-end with
// `text === ''`) followed by a text-only assistant message; the manager must
// keep waiting on the first and complete on the second. Pre-fix bug: first
// empty turn-end was treated as terminal, killing the session before the
// reply landed.
test('text-empty turn-end (thinking-only) → keep waiting; subsequent text turn-end → completed', async () => {
  const p = createProject({
    slug: 'arm-b1',
    name: 'ARM B1',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    warmupPrompt: null, createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-b1', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { runId, completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'read CLAUDE.md',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'test-dispatcher-session',
    worktreeDir: tmpDataDir,
  });

  const s = sessions[0]!;
  s.becomeReady();

  // First turn-end: thinking-only (text === '').
  s.emitTurnEnd('');
  let rec = mgr.get(runId)!;
  assert.equal(rec.status, 'running', 'thinking-only turn-end must NOT terminate');
  assert.equal(rec.result, '', 'no text to record yet');
  assert.equal(s.killed, false, 'session must stay alive for the real reply');

  // Completion must still be pending.
  const racePending = await Promise.race([
    completion.then(() => 'resolved' as const),
    new Promise<'pending'>((r) => setImmediate(() => r('pending'))),
  ]);
  assert.equal(racePending, 'pending');

  // Second turn-end: the actual text reply.
  s.emitTurnEnd('Project Companion is a local-first companion app.');
  const result = await completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'Project Companion is a local-first companion app.');
  await tick();
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
    warmupPrompt: null, createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-pause', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { runId, sessionId, completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'find a lib',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'test-dispatcher-session',
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
    warmupPrompt: null, createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-cancel', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { runId, completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'go',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'test-dispatcher-session',
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
    warmupPrompt: null, createSession: factory,
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
    dispatcherSessionId: 'test-dispatcher-session',
    worktreeDir: tmpDataDir,
    idleTimeoutMs: 1000,
    wallClockTimeoutMs: 60_000,
  });

  const s = sessions[0]!;
  s.becomeReady();

  // Locate the idle timer by its duration — finishSpawn arms wall-clock
  // (60_000), idle (1_000), and spawn-stuck (DEFAULT_SPAWN_STUCK_TIMEOUT_MS),
  // in that order, so position-based lookup is fragile.
  const idleEntry = idleFires.find((e) => e.ms === 1000)!;
  assert.ok(idleEntry, 'idle timer (1000ms) should be armed at finishSpawn');
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
    warmupPrompt: null, createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-exit', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'go',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'test-dispatcher-session',
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
    warmupPrompt: null, createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-find', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { runId, sessionId, completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'go',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'test-dispatcher-session',
    worktreeDir: tmpDataDir,
  });

  assert.equal(mgr.findRunIdBySession(sessionId), runId);

  const s = sessions[0]!;
  s.becomeReady();
  s.emitTurnEnd('done');
  await completion;

  assert.equal(mgr.findRunIdBySession(sessionId), null, 'terminal runs are not findable');
});

// ── 16b.8.1: run-changed event emit + worktreeDir on snapshot + listForProject filter ──

test('emits run-changed at every state transition (spawning → running → completed)', async () => {
  const p = createProject({
    slug: 'arm-emit',
    name: 'ARM Emit',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    warmupPrompt: null, createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-emit', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const seen: Array<{ status: string; runId: string }> = [];
  mgr.on('run-changed', (rec) => {
    seen.push({ status: rec.status, runId: rec.runId });
  });

  const { runId } = mgr.spawn({
    agentName: 'researcher',
    input: 'go',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'test-dispatcher-session',
    worktreeDir: tmpDataDir,
  });

  // After spawn() returns, the initial spawning snapshot has been emitted.
  assert.deepEqual(
    seen.map((s) => s.status),
    ['spawning'],
  );

  const s = sessions[0]!;
  s.becomeReady();
  // spawning → running emit
  assert.deepEqual(
    seen.map((s) => s.status),
    ['spawning', 'running'],
  );

  s.emitTurnEnd('done');
  // running → completed emit
  assert.deepEqual(
    seen.map((s) => s.status),
    ['spawning', 'running', 'completed'],
  );
  assert.ok(seen.every((e) => e.runId === runId));
});

test('snapshot carries worktreeDir for the live-transcript modal', () => {
  const p = createProject({
    slug: 'arm-worktree',
    name: 'ARM Worktree',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory } = makeFactory();
  const mgr = new AgentRunManager({
    warmupPrompt: null, createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-worktree', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });
  const myWorktree = join(tmpDataDir, 'arm-worktree-cwd');
  const { runId } = mgr.spawn({
    agentName: 'researcher',
    input: 'go',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'test-dispatcher-session',
    worktreeDir: myWorktree,
  });
  const snap = mgr.get(runId)!;
  assert.equal(snap.worktreeDir, myWorktree);
});

test('listForProject filters out terminal-status runs only when caller asks; raw includes all', async () => {
  // The HTTP route filters in the handler; the manager itself returns every
  // tracked run for the project. This test pins the manager's contract.
  const p = createProject({
    slug: 'arm-list',
    name: 'ARM List',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    warmupPrompt: null, createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-list', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  // Run 1 → complete it.
  const r1 = mgr.spawn({
    agentName: 'a1',
    input: 'go',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'test-dispatcher-session',
    worktreeDir: tmpDataDir,
  });
  sessions[0]!.becomeReady();
  sessions[0]!.emitTurnEnd('done');
  await r1.completion;

  // Run 2 → leave it spawning.
  mgr.spawn({
    agentName: 'a2',
    input: 'go',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'test-dispatcher-session',
    worktreeDir: tmpDataDir,
  });

  const all = mgr.listForProject(p.id as ULID);
  assert.equal(all.length, 2);
  const active = all.filter(
    (r) => r.status !== 'completed' && r.status !== 'failed' && r.status !== 'cancelled',
  );
  assert.equal(active.length, 1);
  assert.equal(active[0]?.agentName, 'a2');
});

// ── 16b.8.3: run-jsonl-event forwarding for the live-transcript modal ──

test('forwards every jsonl-event as run-jsonl-event with {runId, projectId, event}', async () => {
  const p = createProject({
    slug: 'arm-jsonl-forward',
    name: 'ARM Jsonl Forward',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    warmupPrompt: null, createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-jsonl-forward', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const seen: Array<{ runId: string; projectId: string; kind: string }> = [];
  mgr.on('run-jsonl-event', (payload: { runId: string; projectId: string; event: JsonlEvent }) => {
    seen.push({ runId: payload.runId, projectId: payload.projectId, kind: payload.event.kind });
  });

  const { runId, completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'go',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'test-dispatcher-session',
    worktreeDir: tmpDataDir,
  });
  const s = sessions[0]!;
  s.becomeReady();

  // Forward a tool call + a turn-end (the terminal one). Both must land in
  // the modal so the user sees the closing assistant text.
  s.emitToolCall('Read', { file_path: '/tmp/foo' });
  s.emitTurnEnd('all done');
  await completion;

  assert.deepEqual(
    seen.map((e) => e.kind),
    ['jsonl-tool-call', 'jsonl-turn-end'],
  );
  assert.ok(seen.every((e) => e.runId === runId));
  assert.ok(seen.every((e) => e.projectId === p.id));
});

// ── Section 18.6: ack pattern — waitForFirstJsonl + getFirstJsonlAt ──

test('waitForFirstJsonl resolves on first non-system jsonl event; getFirstJsonlAt returns the timestamp', async () => {
  const p = createProject({
    slug: 'arm-ack-happy',
    name: 'ARM Ack Happy',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    warmupPrompt: null, createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-ack-happy', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { runId, completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'go',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'test-dispatcher-session',
    worktreeDir: tmpDataDir,
  });

  assert.equal(mgr.getFirstJsonlAt(runId), null, 'no ack yet');

  const s = sessions[0]!;
  s.becomeReady();

  // Race waitForFirstJsonl against a 1s sentinel; the jsonl event below
  // must settle the wait. The sentinel proves we don't dangle.
  const ackP = mgr
    .waitForFirstJsonl(runId)
    .then(() => 'acked' as const);
  const sentinelP = new Promise<'sentinel'>((r) => setTimeout(() => r('sentinel'), 1000));

  // jsonl-user lands first — confirms CC accepted + echoed the prompt.
  const before = Date.now();
  s.emit('jsonl-event', { kind: 'jsonl-user', text: 'go' } satisfies JsonlEvent);

  const winner = await Promise.race([ackP, sentinelP]);
  assert.equal(winner, 'acked', 'waitForFirstJsonl must settle on first non-system event');

  const firstAt = mgr.getFirstJsonlAt(runId);
  assert.ok(firstAt !== null, 'getFirstJsonlAt must record the timestamp');
  assert.ok(firstAt! >= before, 'timestamp should be at or after the emit');

  // Subsequent jsonl events don't move the timestamp.
  const firstAtSnapshot = firstAt;
  s.emitToolCall('Read', { file_path: '/tmp/x' });
  assert.equal(mgr.getFirstJsonlAt(runId), firstAtSnapshot);

  // Clean up so the test doesn't hang on terminal.
  s.emitTurnEnd('done');
  await completion;
});

test('jsonl-system events do NOT count as ack; first non-system event does', async () => {
  const p = createProject({
    slug: 'arm-ack-system',
    name: 'ARM Ack System',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    warmupPrompt: null, createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-ack-system', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { runId, completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'go',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'test-dispatcher-session',
    worktreeDir: tmpDataDir,
  });

  const s = sessions[0]!;
  s.becomeReady();

  // A jsonl-system event arrives first — CC's "init" / hook-fired bookkeeping
  // log lines. These must NOT count as ack.
  s.emit('jsonl-event', {
    kind: 'jsonl-system',
    subtype: 'init',
    level: 'info',
    message: 'starting',
    timestamp: null,
    raw: {},
  } satisfies JsonlEvent);
  assert.equal(mgr.getFirstJsonlAt(runId), null, 'jsonl-system must not ack');

  // Now the real ack signal — a tool call.
  s.emitToolCall('Read', { file_path: '/tmp/x' });
  assert.ok(mgr.getFirstJsonlAt(runId) !== null, 'jsonl-tool-call must ack');

  s.emitTurnEnd('done');
  await completion;
});

test('waitForFirstJsonl resolves immediately when the first event already arrived', async () => {
  const p = createProject({
    slug: 'arm-ack-late-wait',
    name: 'ARM Ack Late Wait',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    warmupPrompt: null, createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-ack-late-wait', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { runId, completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'go',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'test-dispatcher-session',
    worktreeDir: tmpDataDir,
  });

  const s = sessions[0]!;
  s.becomeReady();
  s.emitToolCall('Read', { file_path: '/tmp/x' });

  // Wait registers AFTER the first event already landed — must resolve
  // immediately without depending on any further emit.
  const winner = await Promise.race([
    mgr.waitForFirstJsonl(runId).then(() => 'acked' as const),
    new Promise<'sentinel'>((r) => setTimeout(() => r('sentinel'), 1000)),
  ]);
  assert.equal(winner, 'acked');

  s.emitTurnEnd('done');
  await completion;
});

test('terminal-without-ack flushes pending waiters; getFirstJsonlAt stays null', async () => {
  // The route races `waitForFirstJsonl` against an ack timer. When a spawn
  // fails synchronously (unknown-agent), the wait must still resolve so the
  // caller doesn't hang for the full ack window. `getFirstJsonlAt` stays
  // null so the route reports `acked: false`.
  const p = createProject({
    slug: 'arm-ack-terminal-flush',
    name: 'ARM Ack Terminal Flush',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory } = makeFactory();
  const mgr = new AgentRunManager({
    warmupPrompt: null, createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-ack-terminal-flush', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { runId, completion } = mgr.spawn({
    agentName: 'no-such-agent-for-ack-test',
    input: 'go',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'test-dispatcher-session',
    worktreeDir: tmpDataDir,
  });

  // Spawn synchronously failed via the unknown-agent path, which calls
  // `failWithCause` → `flushFirstJsonlResolvers`. `waitForFirstJsonl` for
  // an already-terminal run resolves immediately.
  const winner = await Promise.race([
    mgr.waitForFirstJsonl(runId).then(() => 'acked' as const),
    new Promise<'sentinel'>((r) => setTimeout(() => r('sentinel'), 1000)),
  ]);
  assert.equal(winner, 'acked', 'must not hang on terminal-without-ack');
  assert.equal(mgr.getFirstJsonlAt(runId), null, 'no first jsonl event ever arrived');

  const rec = await completion;
  assert.equal(rec.status, 'failed');
  assert.equal(rec.failureCause, 'unknown-agent');
});

test('terminal flushes a waiter that registered pre-terminal', async () => {
  // Variant covering the case where someone is already awaiting
  // waitForFirstJsonl when the spawn terminates — the wait must resolve.
  const p = createProject({
    slug: 'arm-ack-pre-flush',
    name: 'ARM Ack Pre Flush',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    warmupPrompt: null, createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-ack-pre-flush', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { runId, completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'go',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'test-dispatcher-session',
    worktreeDir: tmpDataDir,
  });

  // Caller registers a waiter BEFORE the session reaches ready / emits anything.
  const ackP = mgr.waitForFirstJsonl(runId).then(() => 'acked' as const);

  // Session dies before any jsonl event arrives.
  const s = sessions[0]!;
  s.becomeReady();
  s.emit('exit', 1, null);

  // Waiter must resolve; getFirstJsonlAt stays null.
  const winner = await Promise.race([
    ackP,
    new Promise<'sentinel'>((r) => setTimeout(() => r('sentinel'), 1000)),
  ]);
  assert.equal(winner, 'acked');
  assert.equal(mgr.getFirstJsonlAt(runId), null);

  const rec = await completion;
  assert.equal(rec.status, 'failed');
  assert.equal(rec.failureCause, 'spawn-exit');
});

test('waitForFirstJsonl for unknown runId resolves immediately (defensive)', async () => {
  const { factory } = makeFactory();
  const mgr = new AgentRunManager({
    warmupPrompt: null, createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-ack-unknown', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });
  const winner = await Promise.race([
    mgr.waitForFirstJsonl('01XXXXXXXXXXXXXXXXXXXXXXXX' as ULID).then(() => 'acked' as const),
    new Promise<'sentinel'>((r) => setTimeout(() => r('sentinel'), 500)),
  ]);
  assert.equal(winner, 'acked');
});

// ── Section 18.7: max-concurrent cap + FIFO queue ──

function makeCapMgr(cap: number, slug: string) {
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    warmupPrompt: null, createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, slug, pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
    getMaxConcurrent: () => cap,
  });
  return { mgr, sessions };
}

test('under cap → direct spawn; result.queued=false, position=null', async () => {
  const p = createProject({
    slug: 'arm-cap-under',
    name: 'ARM Cap Under',
    stages,
    folderPath: tmpDataDir,
  });
  const { mgr, sessions } = makeCapMgr(2, 'arm-cap-under');

  const r1 = mgr.spawn({
    agentName: 'researcher',
    input: 'go',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'cap-under-disp',
    worktreeDir: tmpDataDir,
  });
  assert.equal(r1.queued, false);
  assert.equal(r1.position, null);
  assert.equal(sessions.length, 1, 'under-cap spawn must create a session synchronously');
  // The record should be in `spawning` (then `running` after becomeReady).
  const rec = mgr.get(r1.runId)!;
  assert.equal(rec.status, 'spawning');
  sessions[0]!.becomeReady();
  sessions[0]!.emitTurnEnd('done');
  await r1.completion;
});

test('at cap → queued shape with position; no session created until dequeue', async () => {
  const p = createProject({
    slug: 'arm-cap-queue',
    name: 'ARM Cap Queue',
    stages,
    folderPath: tmpDataDir,
  });
  const { mgr, sessions } = makeCapMgr(1, 'arm-cap-queue');

  const r1 = mgr.spawn({
    agentName: 'a1',
    input: 'go',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'cap-queue-disp',
    worktreeDir: tmpDataDir,
  });
  assert.equal(r1.queued, false, 'first dispatch under cap');
  assert.equal(sessions.length, 1);

  // Second dispatch — cap = 1, one running → must queue.
  const r2 = mgr.spawn({
    agentName: 'a2',
    input: 'second',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'cap-queue-disp',
    worktreeDir: tmpDataDir,
  });
  assert.equal(r2.queued, true, 'second dispatch must queue (cap=1)');
  assert.equal(r2.position, 1, 'first in queue → position 1');
  assert.equal(sessions.length, 1, 'no session created for queued runs until dequeue');
  assert.equal(mgr.get(r2.runId)!.status, 'queued');

  // Third dispatch — also queued, position 2.
  const r3 = mgr.spawn({
    agentName: 'a1',
    input: 'third',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'cap-queue-disp',
    worktreeDir: tmpDataDir,
  });
  assert.equal(r3.queued, true);
  assert.equal(r3.position, 2);
  assert.equal(sessions.length, 1);

  // Clean up — terminate the running one + drain queue.
  sessions[0]!.becomeReady();
  sessions[0]!.emitTurnEnd('done1');
  await r1.completion;
  // After r1's terminal, r2's session was created via dequeue.
  assert.equal(sessions.length, 2);
  sessions[1]!.becomeReady();
  sessions[1]!.emitTurnEnd('done2');
  await r2.completion;
  // After r2's terminal, r3's session was created.
  assert.equal(sessions.length, 3);
  sessions[2]!.becomeReady();
  sessions[2]!.emitTurnEnd('done3');
  await r3.completion;
});

test('queued → dequeue on terminal → emits agent-queued-started with carried-forward timestamps', async () => {
  const p = createProject({
    slug: 'arm-cap-queued-event',
    name: 'ARM Cap Queued Event',
    stages,
    folderPath: tmpDataDir,
  });
  const { mgr, sessions } = makeCapMgr(1, 'arm-cap-queued-event');

  const queuedEvents: Array<Record<string, unknown>> = [];
  mgr.on('agent-queued-started', (payload: Record<string, unknown>) => {
    queuedEvents.push(payload);
  });

  const r1 = mgr.spawn({
    agentName: 'a1',
    input: 'first',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'cap-event-disp',
    worktreeDir: tmpDataDir,
  });
  assert.equal(r1.queued, false);

  const r2DispatchAt = Date.now();
  const r2 = mgr.spawn({
    agentName: 'a2',
    input: 'second',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'cap-event-disp',
    worktreeDir: tmpDataDir,
  });
  assert.equal(r2.queued, true);

  // Snapshot the queued record's startedAt before dequeue (will get bumped).
  const r2QueuedRec = mgr.get(r2.runId)!;
  assert.equal(r2QueuedRec.status, 'queued');

  // No queued-started events fire on enqueue — only on dequeue.
  assert.equal(queuedEvents.length, 0, 'queued-started fires on dequeue, not enqueue');

  // Terminate r1 → drain r2.
  sessions[0]!.becomeReady();
  sessions[0]!.emitTurnEnd('done');
  await r1.completion;

  // Manager fires `agent-queued-started` synchronously inside the terminal
  // path's processQueue. By the time `r1.completion` resolves, the event has
  // already landed.
  assert.equal(queuedEvents.length, 1, 'one queued-started event for r2');
  const ev = queuedEvents[0]!;
  assert.equal(ev.runId, r2.runId);
  assert.equal(ev.sessionId, r2.sessionId);
  assert.equal(ev.agentName, 'a2');
  assert.equal(ev.projectId, p.id);
  assert.equal(ev.dispatcherSessionId, 'cap-event-disp');
  assert.ok(typeof ev.queuedAt === 'number');
  assert.ok(typeof ev.startedAt === 'number');
  assert.ok(
    (ev.queuedAt as number) >= r2DispatchAt - 5,
    'queuedAt should be the dispatch-time timestamp',
  );
  assert.ok(
    (ev.startedAt as number) >= (ev.queuedAt as number),
    'startedAt should be >= queuedAt',
  );
  // r2's record startedAt got bumped to actual spawn time (was dispatch time when queued).
  const r2RunningRec = mgr.get(r2.runId)!;
  assert.equal(r2RunningRec.startedAt, ev.startedAt);

  // Tidy.
  sessions[1]!.becomeReady();
  sessions[1]!.emitTurnEnd('done');
  await r2.completion;
});

test('cancel-while-queued → status=cancelled, completion resolves, queue stays consistent', async () => {
  const p = createProject({
    slug: 'arm-cap-cancel',
    name: 'ARM Cap Cancel',
    stages,
    folderPath: tmpDataDir,
  });
  const { mgr, sessions } = makeCapMgr(1, 'arm-cap-cancel');

  const r1 = mgr.spawn({
    agentName: 'a1',
    input: 'go',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'cancel-disp',
    worktreeDir: tmpDataDir,
  });
  const r2 = mgr.spawn({
    agentName: 'a2',
    input: 'go',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'cancel-disp',
    worktreeDir: tmpDataDir,
  });
  const r3 = mgr.spawn({
    agentName: 'a1',
    input: 'go',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'cancel-disp',
    worktreeDir: tmpDataDir,
  });
  assert.equal(r2.queued, true);
  assert.equal(r3.queued, true);
  assert.equal(r3.position, 2);

  // Cancel r2 (the queued one at position 1). r3 stays in the queue; when
  // the running r1 terminates, r3 should spawn next (skipping the stale r2).
  const cancelled = mgr.cancel(r2.runId, 'user cancelled queued');
  assert.equal(cancelled, true);
  const r2Rec = await r2.completion;
  assert.equal(r2Rec.status, 'cancelled');
  assert.equal(r2Rec.failureCause, 'cancelled');
  assert.equal(sessions.length, 1, 'cancel-while-queued must not spawn a session');

  // Terminate r1 — processQueue should skip the stale r2 entry and pick r3.
  sessions[0]!.becomeReady();
  sessions[0]!.emitTurnEnd('done1');
  await r1.completion;
  assert.equal(sessions.length, 2, 'r3 should now have a session');
  // r3 must be the one running now (not r2).
  const r3Rec = mgr.get(r3.runId)!;
  assert.equal(r3Rec.status, 'spawning');

  sessions[1]!.becomeReady();
  sessions[1]!.emitTurnEnd('done3');
  await r3.completion;
});

test('paused run counts toward the cap (occupies a slot)', async () => {
  const p = createProject({
    slug: 'arm-cap-paused',
    name: 'ARM Cap Paused',
    stages,
    folderPath: tmpDataDir,
  });
  const { mgr, sessions } = makeCapMgr(1, 'arm-cap-paused');

  const r1 = mgr.spawn({
    agentName: 'a1',
    input: 'go',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'paused-disp',
    worktreeDir: tmpDataDir,
  });
  const s = sessions[0]!;
  s.becomeReady();

  // Mint a waiting pending-ask + simulate a turn-end so the manager transitions
  // r1 to `paused`.
  const pendingId = newId();
  createPendingAsk({
    id: pendingId,
    sessionId: r1.sessionId,
    agentName: 'a1',
    projectId: p.id as ULID,
    kind: 'ask-orchestrator',
    question: 'q',
    now: Date.now(),
  });
  s.emitTurnEnd('asking');
  assert.equal(mgr.get(r1.runId)!.status, 'paused');

  // Now dispatch a second run — paused should count as occupying the cap
  // slot, so this must queue.
  const r2 = mgr.spawn({
    agentName: 'a2',
    input: 'go',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'paused-disp',
    worktreeDir: tmpDataDir,
  });
  assert.equal(r2.queued, true, 'paused run must occupy a cap slot');
  assert.equal(r2.position, 1);
  assert.equal(sessions.length, 1, 'no session created for queued r2');

  // Cancel paused r1 to free the slot + drain queue.
  mgr.cancel(r1.runId, 'cleanup');
  await r1.completion;
  assert.equal(sessions.length, 2, 'r2 should now have a session');

  sessions[1]!.becomeReady();
  sessions[1]!.emitTurnEnd('done2');
  await r2.completion;
});

test('multiple terminals drain queue in FIFO order', async () => {
  const p = createProject({
    slug: 'arm-cap-fifo',
    name: 'ARM Cap FIFO',
    stages,
    folderPath: tmpDataDir,
  });
  const { mgr, sessions } = makeCapMgr(1, 'arm-cap-fifo');

  // Dispatch 4 — 1 runs, 3 queue.
  const r1 = mgr.spawn({
    agentName: 'a1',
    input: '1',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'fifo-disp',
    worktreeDir: tmpDataDir,
  });
  const r2 = mgr.spawn({
    agentName: 'a2',
    input: '2',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'fifo-disp',
    worktreeDir: tmpDataDir,
  });
  const r3 = mgr.spawn({
    agentName: 'a1',
    input: '3',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'fifo-disp',
    worktreeDir: tmpDataDir,
  });
  const r4 = mgr.spawn({
    agentName: 'a2',
    input: '4',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'fifo-disp',
    worktreeDir: tmpDataDir,
  });
  assert.deepEqual(
    [r1.queued, r2.queued, r3.queued, r4.queued],
    [false, true, true, true],
  );
  assert.deepEqual([r2.position, r3.position, r4.position], [1, 2, 3]);

  // Drain — each terminal pulls the next queued head.
  sessions[0]!.becomeReady();
  sessions[0]!.emitTurnEnd('d1');
  await r1.completion;
  assert.equal(sessions.length, 2);
  assert.equal(mgr.get(r2.runId)!.status, 'spawning');

  sessions[1]!.becomeReady();
  sessions[1]!.emitTurnEnd('d2');
  await r2.completion;
  assert.equal(sessions.length, 3);
  assert.equal(mgr.get(r3.runId)!.status, 'spawning');

  sessions[2]!.becomeReady();
  sessions[2]!.emitTurnEnd('d3');
  await r3.completion;
  assert.equal(sessions.length, 4);
  assert.equal(mgr.get(r4.runId)!.status, 'spawning');

  sessions[3]!.becomeReady();
  sessions[3]!.emitTurnEnd('d4');
  await r4.completion;
});

test('queued dispatch is durable across multiple terminals before its turn', async () => {
  // Regression: confirm a queued run survives several other terminals + waits
  // for its actual FIFO slot. Also tests that `agent-queued-started` fires
  // exactly once per queued run (not once per terminal-drain pass).
  const p = createProject({
    slug: 'arm-cap-fifo-durable',
    name: 'ARM Cap FIFO Durable',
    stages,
    folderPath: tmpDataDir,
  });
  const { mgr, sessions } = makeCapMgr(2, 'arm-cap-fifo-durable');

  const queuedEvents: string[] = [];
  mgr.on('agent-queued-started', (p: { runId: string }) => {
    queuedEvents.push(p.runId);
  });

  // Two run immediately (cap=2).
  const r1 = mgr.spawn({
    agentName: 'a1',
    input: '1',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'dur-disp',
    worktreeDir: tmpDataDir,
  });
  const r2 = mgr.spawn({
    agentName: 'a2',
    input: '2',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'dur-disp',
    worktreeDir: tmpDataDir,
  });
  // Two queue.
  const r3 = mgr.spawn({
    agentName: 'a1',
    input: '3',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'dur-disp',
    worktreeDir: tmpDataDir,
  });
  const r4 = mgr.spawn({
    agentName: 'a2',
    input: '4',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'dur-disp',
    worktreeDir: tmpDataDir,
  });
  assert.equal(r1.queued, false);
  assert.equal(r2.queued, false);
  assert.equal(r3.queued, true);
  assert.equal(r4.queued, true);

  // Terminate r1 → r3 spawns. r2 is still running.
  sessions[0]!.becomeReady();
  sessions[0]!.emitTurnEnd('d1');
  await r1.completion;
  assert.deepEqual(queuedEvents, [r3.runId]);

  // Terminate r2 → r4 spawns.
  sessions[1]!.becomeReady();
  sessions[1]!.emitTurnEnd('d2');
  await r2.completion;
  assert.deepEqual(queuedEvents, [r3.runId, r4.runId]);

  // Drain.
  sessions[2]!.becomeReady();
  sessions[2]!.emitTurnEnd('d3');
  await r3.completion;
  sessions[3]!.becomeReady();
  sessions[3]!.emitTurnEnd('d4');
  await r4.completion;

  // No duplicate emissions across the back-to-back terminals.
  assert.equal(queuedEvents.length, 2);
});

test('getMaxConcurrent dep override beats DB-backed default', async () => {
  // Pin the test to a cap of 3 regardless of what the DB-backed default
  // would return. Spawn 3 → all run; spawn 4th → queues.
  const p = createProject({
    slug: 'arm-cap-dep',
    name: 'ARM Cap Dep',
    stages,
    folderPath: tmpDataDir,
  });
  const { mgr, sessions } = makeCapMgr(3, 'arm-cap-dep');

  const handles: Array<ReturnType<typeof mgr.spawn>> = [];
  for (let i = 0; i < 3; i++) {
    handles.push(
      mgr.spawn({
        agentName: i % 2 === 0 ? 'a1' : 'a2',
        input: `r${i}`,
        wait: false,
        projectId: p.id as ULID,
        dispatcherSessionId: 'dep-disp',
        worktreeDir: tmpDataDir,
      }),
    );
  }
  for (const h of handles) assert.equal(h.queued, false);
  assert.equal(sessions.length, 3);

  const overflow = mgr.spawn({
    agentName: 'a1',
    input: 'overflow',
    wait: false,
    projectId: p.id as ULID,
    dispatcherSessionId: 'dep-disp',
    worktreeDir: tmpDataDir,
  });
  assert.equal(overflow.queued, true);
  assert.equal(overflow.position, 1);

  // Clean up.
  for (let i = 0; i < 3; i++) {
    sessions[i]!.becomeReady();
    sessions[i]!.emitTurnEnd(`done${i}`);
    await handles[i]!.completion;
  }
  assert.equal(sessions.length, 4, 'overflow drained when cap freed');
  sessions[3]!.becomeReady();
  sessions[3]!.emitTurnEnd('done-overflow');
  await overflow.completion;
});

// Section 20.B.1 — spawn-stuck timeout. A run that boots but never transitions
// out of 'spawning' (warmup turn never lands → e.g. MCP boot hung) must fail
// with cause='spawn-stuck' rather than sitting until the 5-minute idle timer.
test('spawn-stuck timeout: never-ready session fails with cause=spawn-stuck', async () => {
  const p = createProject({
    slug: 'arm-spawn-stuck',
    name: 'ARM SpawnStuck',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    warmupPrompt: null,
    createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-spawn-stuck', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'go',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'spawn-stuck-test',
    worktreeDir: tmpDataDir,
    spawnStuckTimeoutMs: 30,
  });
  assert.equal(sessions.length, 1);
  // Deliberately DO NOT call becomeReady() — simulates a CC child whose
  // MCP boot hung pre-banner OR a stuck warmup. The spawn-stuck timer should
  // fire and resolve completion.

  const result = await completion;
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCause, 'spawn-stuck');
  assert.match(
    result.failureReason ?? '',
    /did not begin its first turn within \d+s/,
    `expected spawn-stuck reason, got: ${result.failureReason}`,
  );
});

// Section 20.B.2 — PTY-exit handler race. When a non-terminal run is failed
// by the manager (spawn-stuck, idle-timeout, cancel), `failWithCause` calls
// `session.kill()` synchronously and then resolves completion. The fake
// session's kill() defers an 'exit' emit via setImmediate; when that exit
// listener runs, `rec.status` is already terminal so the handler must no-op
// (cleanupOnTerminal is idempotent, completion stays resolved once, no
// extra run-changed event fires). Guards against a future regression that
// re-fails a terminal run on its own kill-driven exit.
test('PTY exit after manager kill is idempotent — completion resolves once, no extra run-changed', async () => {
  const p = createProject({
    slug: 'arm-exit-race',
    name: 'ARM Exit Race',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    warmupPrompt: null,
    createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-exit-race', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const terminalSnapshots: string[] = [];
  mgr.on('run-changed', (rec) => {
    if (rec.status === 'failed' || rec.status === 'completed' || rec.status === 'cancelled') {
      terminalSnapshots.push(`${rec.status}:${rec.failureCause ?? '-'}`);
    }
  });

  const { runId, completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'go',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'exit-race-test',
    worktreeDir: tmpDataDir,
    spawnStuckTimeoutMs: 25,
  });
  const s = sessions[0]!;
  // Don't call becomeReady — let spawn-stuck timer fire, which calls
  // session.kill(), which schedules an exit emit on setImmediate.

  const result = await completion;
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCause, 'spawn-stuck');
  // Wait one extra tick to let the deferred exit emit land + run through
  // the exit listener. If the handler tried to re-fail the run, a second
  // terminal run-changed would land here.
  await tick();
  await tick();
  assert.equal(s.killed, true, 'kill was invoked by failWithCause');
  assert.equal(
    terminalSnapshots.length,
    1,
    `terminal run-changed must fire exactly once, got: ${JSON.stringify(terminalSnapshots)}`,
  );
  assert.equal(terminalSnapshots[0], 'failed:spawn-stuck');
  assert.equal(mgr.get(runId)?.failureCause, 'spawn-stuck', 'failureCause must not be overwritten');
});

// Section 20.C — warmup kick. After the warmup text is sent, the manager
// arms a recurring timer that re-sends a bare Enter every warmupKickIntervalMs
// while the warmup is unanswered. Cancelled the moment the warmup turn-end
// lands. Real-world symptom this addresses: text gets typed into CC's prompt
// buffer but the submit is dropped (intermittent on Windows under concurrent
// spawn + strict-mcp-config handshake).
test('warmup kick: re-sends Enter on interval while warmup unanswered; stops on first turn-end', async () => {
  const p = createProject({
    slug: 'arm-warmup-kick',
    name: 'ARM Warmup Kick',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    // Default warmup is active (no override).
    createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-warmup-kick', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'real input',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'kick-test',
    worktreeDir: tmpDataDir,
    warmupKickIntervalMs: 25,
    // Keep spawn-stuck out of the way (well past anything this test does).
    spawnStuckTimeoutMs: 5_000,
    // Section 22 — this test exercises the no-handshake fallback path
    // explicitly (warmup sent at ready + kicks armed). Skip the handshake
    // wait entirely so we don't have to time-travel to fire the timeout.
    mcpHandshakeTimeoutMs: 0,
  });
  const s = sessions[0]!;

  // Ready → warmup sent; kick timer armed; status stays 'spawning'.
  s.becomeReady();
  assert.deepEqual(s.sent, ['Reply with only the word OK.']);
  assert.equal(s.kicks, 0, 'no kicks before the kick interval elapses');

  // Wait for at least 2 kick intervals; expect 2+ kicks while warmup is
  // unanswered.
  await new Promise<void>((r) => setTimeout(r, 80));
  assert.ok(s.kicks >= 2, `expected ≥2 kicks while warmup pending, got ${s.kicks}`);
  const kicksBeforeTurnEnd = s.kicks;

  // Warmup turn finally lands. Manager flips to 'running' + sends real
  // input + cancels kick timer.
  s.emitTurnEnd('OK');
  assert.deepEqual(s.sent, ['Reply with only the word OK.', 'real input']);

  // No additional kicks should land after the warmup turn-end.
  await new Promise<void>((r) => setTimeout(r, 80));
  assert.equal(
    s.kicks,
    kicksBeforeTurnEnd,
    'kick timer must stop once warmup completes',
  );

  // Real turn-end completes the run.
  s.emitTurnEnd('done');
  const result = await completion;
  assert.equal(result.status, 'completed');
});

// Section 22 — when pc-rig's mcp-connected POST has already arrived by the
// time PtySession reaches `ready`, the warmup fires immediately and the
// kick timer is NOT armed (handshake is confirmed; the typed-text-no-Enter
// symptom can't happen because MCP isn't fighting for the input buffer).
test('mcp-connected arrives before ready: warmup fires immediately, no kicks', async () => {
  const p = createProject({
    slug: 'arm-mcp-fast',
    name: 'ARM MCP Fast',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-mcp-fast', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { runId, completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'real input',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'mcp-fast',
    worktreeDir: tmpDataDir,
    warmupKickIntervalMs: 25, // would be visible if kick armed
    mcpHandshakeTimeoutMs: 5_000, // generous; we should not hit it
  });
  const s = sessions[0]!;
  const sessionId = s.lastOpts.claudeSessionId!;

  // pc-rig handshake POST races us to ready.
  const found = mgr.notifyMcpConnected(p.id as ULID, sessionId);
  assert.equal(found, true);
  assert.equal(s.sent.length, 0, 'warmup must not fire before ready');

  // Ready: fast-path triggers warmup immediately, no kick armed.
  s.becomeReady();
  assert.deepEqual(s.sent, ['Reply with only the word OK.']);

  await new Promise<void>((r) => setTimeout(r, 80));
  assert.equal(s.kicks, 0, 'kick must not arm when mcp-connected was confirmed');

  // Warmup turn-end → real input lands.
  s.emitTurnEnd('OK');
  assert.deepEqual(s.sent, ['Reply with only the word OK.', 'real input']);
  s.emitTurnEnd('done');
  const result = await completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.runId, runId);
});

// Section 22 — when ready fires first and mcp-connected arrives later (the
// common case under load), the warmup is deferred until the POST lands —
// no warmup at ready, no kick, then warmup the moment notify fires.
test('ready then mcp-connected: warmup deferred until POST arrives, no kicks', async () => {
  const p = createProject({
    slug: 'arm-mcp-late',
    name: 'ARM MCP Late',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-mcp-late', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'real input',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'mcp-late',
    worktreeDir: tmpDataDir,
    warmupKickIntervalMs: 25,
    mcpHandshakeTimeoutMs: 5_000,
  });
  const s = sessions[0]!;
  const sessionId = s.lastOpts.claudeSessionId!;

  // Ready arrives first; warmup must NOT fire yet (waiting on handshake).
  s.becomeReady();
  assert.equal(s.sent.length, 0, 'warmup must defer until mcp-connected');
  await new Promise<void>((r) => setTimeout(r, 80));
  assert.equal(s.kicks, 0, 'no kicks during the handshake wait');
  assert.equal(s.sent.length, 0, 'still no warmup during handshake wait');

  // POST arrives → warmup fires now, no kick.
  mgr.notifyMcpConnected(p.id as ULID, sessionId);
  assert.deepEqual(s.sent, ['Reply with only the word OK.']);
  await new Promise<void>((r) => setTimeout(r, 80));
  assert.equal(s.kicks, 0, 'kick must not arm when handshake confirmed');

  s.emitTurnEnd('OK');
  assert.deepEqual(s.sent, ['Reply with only the word OK.', 'real input']);
  s.emitTurnEnd('done');
  const result = await completion;
  assert.equal(result.status, 'completed');
});

// Section 22 — if mcp-connected NEVER arrives (pc-rig POST failure, stale
// bundle, network flake), the handshake timer fires the legacy path:
// warmup at deadline + kicks armed for the typed-text-no-Enter case.
// Defense-in-depth — no regression from pre-Section-22 behavior.
test('mcp-connected never arrives: handshake timer fires fallback (warmup + kick)', async () => {
  const p = createProject({
    slug: 'arm-mcp-timeout',
    name: 'ARM MCP Timeout',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-mcp-timeout', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'real input',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'mcp-timeout',
    worktreeDir: tmpDataDir,
    warmupKickIntervalMs: 25,
    mcpHandshakeTimeoutMs: 40, // small; we want the timeout to fire
    spawnStuckTimeoutMs: 5_000,
  });
  const s = sessions[0]!;

  // Ready arrives; warmup deferred waiting on handshake.
  s.becomeReady();
  assert.equal(s.sent.length, 0);

  // Wait past the handshake timeout: warmup fires + kick arms.
  await new Promise<void>((r) => setTimeout(r, 90));
  assert.deepEqual(s.sent, ['Reply with only the word OK.']);
  // Kick should have fired ≥ once by now (warmupKickIntervalMs: 25).
  assert.ok(s.kicks >= 1, `expected ≥1 kick after fallback, got ${s.kicks}`);

  // Warmup eventually completes; kick stops; real input ships.
  s.emitTurnEnd('OK');
  assert.deepEqual(s.sent, ['Reply with only the word OK.', 'real input']);
  s.emitTurnEnd('done');
  const result = await completion;
  assert.equal(result.status, 'completed');
});

// Section 22 — notifyMcpConnected for an unknown sessionId returns false
// and doesn't throw. apps/server's route forwards every pc-rig POST; we
// shouldn't crash on a stale or unmatched id.
test('notifyMcpConnected returns false for unknown sessionId (no throw)', () => {
  const p = createProject({
    slug: 'arm-mcp-unknown',
    name: 'ARM MCP Unknown',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory } = makeFactory();
  const mgr = new AgentRunManager({
    warmupPrompt: null, createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-mcp-unknown', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const found = mgr.notifyMcpConnected(p.id as ULID, 'no-such-session');
  assert.equal(found, false);
});

// Section 22 — duplicate handshake POSTs are idempotent: a second notify
// for the same session doesn't re-fire warmup.
test('notifyMcpConnected is idempotent across duplicate POSTs', async () => {
  const p = createProject({
    slug: 'arm-mcp-dup',
    name: 'ARM MCP Dup',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-mcp-dup', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'real input',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'mcp-dup',
    worktreeDir: tmpDataDir,
    mcpHandshakeTimeoutMs: 5_000,
  });
  const s = sessions[0]!;
  const sessionId = s.lastOpts.claudeSessionId!;

  s.becomeReady();
  mgr.notifyMcpConnected(p.id as ULID, sessionId);
  assert.deepEqual(s.sent, ['Reply with only the word OK.']);

  // Second notify — must NOT re-fire warmup.
  mgr.notifyMcpConnected(p.id as ULID, sessionId);
  assert.deepEqual(
    s.sent,
    ['Reply with only the word OK.'],
    'duplicate handshake POSTs must be idempotent',
  );

  s.emitTurnEnd('OK');
  s.emitTurnEnd('done');
  await completion;
});

// Section 20.B.1 — spawn-stuck timer must be cleared the moment a run flips
// from spawning to running. A run that reaches 'running' before the timer
// fires must complete normally; the timer must not later kick in to mark a
// happy-path run as 'failed'.
test('spawn-stuck timer cleared when run transitions to running (happy path unaffected)', async () => {
  const p = createProject({
    slug: 'arm-spawn-stuck-clear',
    name: 'ARM SpawnStuck Cleared',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    warmupPrompt: null,
    createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-spawn-stuck-clear', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'go',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'spawn-stuck-cleared-test',
    worktreeDir: tmpDataDir,
    spawnStuckTimeoutMs: 30,
  });
  const s = sessions[0]!;
  // Flip to running immediately — spawn-stuck timer should be cleared.
  s.becomeReady();
  // Wait long enough that an uncleared timer would fire (3× its window).
  await new Promise<void>((r) => setTimeout(r, 100));
  s.emitTurnEnd('done');
  const result = await completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.failureCause, null);
});

// Section 21 — concurrent-continuation guard. The route's
// `findActiveContinuation` DB check catches the typical "two HTTP calls
// minutes apart" case; the in-memory map is defence-in-depth for
// same-tick races where two route invocations both pass the DB check
// before either has persisted its continuation row. Second attempt fails
// synchronously with cause='concurrent-continuation'; releasing the
// guard (by completing the in-flight continuation) opens it up again.
test('Section 21 — second continuation for an in-flight parent is rejected synchronously', async () => {
  const p = createProject({
    slug: 'arm-continue-guard',
    name: 'ARM Continue Guard',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    warmupPrompt: null,
    createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-continue-guard', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  // Original dispatch → completed.
  const original = mgr.spawn({
    agentName: 'researcher',
    input: 'first ask',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'guard-dispatcher',
    worktreeDir: tmpDataDir,
  });
  sessions[0]!.becomeReady();
  sessions[0]!.emitTurnEnd('answer one');
  await original.completion;

  // First continuation — proceeds; do NOT drive it to terminal yet.
  const contA = mgr.spawn({
    agentName: 'researcher',
    input: 'follow-up 1',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'guard-dispatcher',
    worktreeDir: tmpDataDir,
    continues: original.runId,
    resume: { providerSessionId: original.sessionId },
  });
  assert.equal(sessions.length, 2, 'first continuation spawned a real session');

  // Second continuation against the same parent — must fail fast without
  // creating a new session. Completion resolves with the rejection cause.
  const contB = mgr.spawn({
    agentName: 'researcher',
    input: 'follow-up 2',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'guard-dispatcher',
    worktreeDir: tmpDataDir,
    continues: original.runId,
    resume: { providerSessionId: original.sessionId },
  });
  assert.equal(
    sessions.length,
    2,
    'second continuation did NOT spawn a session (rejected pre-flight)',
  );
  const contBResult = await contB.completion;
  assert.equal(contBResult.status, 'failed');
  assert.equal(contBResult.failureCause, 'concurrent-continuation');
  assert.match(
    contBResult.failureReason ?? '',
    /already has an active continuation/,
    'failure reason names the live continuation',
  );

  // Complete contA — releases the guard. A third continuation now goes
  // through cleanly.
  sessions[1]!.becomeReady();
  sessions[1]!.emitTurnEnd('refined one');
  await contA.completion;

  const contC = mgr.spawn({
    agentName: 'researcher',
    input: 'follow-up 3',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'guard-dispatcher',
    worktreeDir: tmpDataDir,
    continues: original.runId,
    resume: { providerSessionId: original.sessionId },
  });
  assert.equal(sessions.length, 3, 'third continuation spawned after A released the guard');
  sessions[2]!.becomeReady();
  sessions[2]!.emitTurnEnd('refined two');
  const contCResult = await contC.completion;
  assert.equal(contCResult.status, 'completed');
});

// Section 21 — resume must skip the prior session's JSONL replay. If the
// tailer starts from line 0 on a `--resume`, the prior conversation's
// historical turn-ends re-fire as fresh events and `onTurnEnd` would
// terminate the continuation before claude.exe produces new output (the
// 232ms-result-"OK" bug from the 2026-05-22 user smoke). Spawn must set
// jsonlStartLine to the current file's line count.
test('Section 21 — resume skips historical JSONL replay (jsonlStartLine pinned to current EOF)', async () => {
  const p = createProject({
    slug: 'arm-resume-skip',
    name: 'ARM Resume Skip',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();

  // Use a fixture JSONL path under tmpDataDir so we can pre-seed it with
  // historical lines. The manager's resolveJsonlPath dep gives full control.
  const jsonlDir = join(tmpDataDir, 'arm-resume-skip-jsonl');
  mkdirSync(jsonlDir, { recursive: true });
  const sharedProviderSession = 'shared-provider-session-id';
  const sharedJsonlPath = join(jsonlDir, `${sharedProviderSession}.jsonl`);

  const mgr = new AgentRunManager({
    warmupPrompt: null,
    createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-resume-skip', pid, rid),
    resolveJsonlPath: (_d, sid) => join(jsonlDir, `${sid}.jsonl`),
  });

  // Original dispatch — uses sharedProviderSession via the resolveJsonlPath dep.
  // Drive original to completion so the JSONL fixture would normally accumulate
  // turn-end rows in production; we manually seed historical content below.
  const original = mgr.spawn({
    agentName: 'researcher',
    input: 'first',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'resume-skip-dispatcher',
    worktreeDir: tmpDataDir,
  });
  sessions[0]!.becomeReady();
  sessions[0]!.emitTurnEnd('result-1');
  await original.completion;

  // Pre-seed the SHARED jsonl path (= what the continuation will resume into)
  // with 5 historical lines, mimicking the prior session's leftover content.
  writeFileSync(
    sharedJsonlPath,
    [
      '{"type":"system","subtype":"init"}',
      '{"type":"user","message":{}}',
      '{"type":"assistant","message":{}}',
      '{"type":"user","message":{}}',
      '{"type":"assistant","message":{}}',
    ].join('\n') + '\n',
  );

  const cont = mgr.spawn({
    agentName: 'researcher',
    input: 'follow-up',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'resume-skip-dispatcher',
    worktreeDir: tmpDataDir,
    continues: original.runId,
    resume: { providerSessionId: sharedProviderSession },
  });

  const s = sessions[1]!;
  assert.equal(s.lastOpts.resume, true, 'continuation passes --resume to PtySession');
  assert.equal(
    s.lastOpts.jsonlPath,
    sharedJsonlPath,
    "continuation's tailer attached to the shared (prior) JSONL",
  );
  assert.equal(
    s.lastOpts.jsonlStartLine,
    5,
    'jsonlStartLine pinned to current EOF (skips the 5 historical lines)',
  );

  // Drive continuation to completion to keep the test hygienic + verify the
  // FakeSession's flow still works against the resume path. The send-on-
  // ready behaviour itself is covered by the Section 24 (post-pivot) test
  // below — this test's focus is jsonlStartLine pinning. On Section 24's
  // quiet-window gating, `s.sent` would only populate after the poller
  // fires (≥1500ms post-ready); the synchronous `emitTurnEnd` here
  // terminates the run before that, so `s.sent` stays empty by design.
  s.becomeReady();
  s.emitTurnEnd('refined');
  const result = await cont.completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'refined');
});

// Section 21 — continuation: spawn with `resume: { providerSessionId }`
// reuses the prior run's CC session id, passes `--resume` to PtySession (via
// the resume: true sessionOpts flag), and persists the new row with
// `continues` pointing at the parent. Fresh runId; shared sessionId.
test('Section 21 — resume option threads --resume + reuses providerSessionId + persists continues link', async () => {
  const p = createProject({
    slug: 'arm-continue',
    name: 'ARM Continue',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    warmupPrompt: null,
    createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-continue', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  // Original dispatch — mints a fresh provider session id.
  const original = mgr.spawn({
    agentName: 'researcher',
    input: 'find a date math lib',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'continue-dispatcher',
    worktreeDir: tmpDataDir,
  });
  const s0 = sessions[0]!;
  assert.equal(s0.lastOpts.resume, false, 'original spawn uses --session-id, not --resume');
  s0.becomeReady();
  s0.emitTurnEnd('use date-fns');
  const originalResult = await original.completion;
  assert.equal(originalResult.status, 'completed');
  const originalRow = getAgentRunRow(original.runId);
  assert.equal(originalRow?.status, 'completed', 'original row persisted as completed');
  assert.equal(originalRow?.continues, null, 'original row has no continues link');

  // Continuation — reuses providerSessionId, sets resume: true on the PTY
  // opts, and the new row links back to the original via `continues`.
  const cont = mgr.spawn({
    agentName: 'researcher',
    input: 'expand on point 3',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'continue-dispatcher',
    worktreeDir: tmpDataDir,
    continues: original.runId,
    resume: { providerSessionId: original.sessionId },
  });
  assert.notEqual(cont.runId, original.runId, 'continuation gets a fresh runId');
  assert.equal(
    cont.sessionId,
    original.sessionId,
    'continuation reuses the prior providerSessionId',
  );
  const s1 = sessions[1]!;
  assert.equal(s1.lastOpts.resume, true, 'continuation spawn passes --resume to PtySession');
  assert.equal(
    s1.lastOpts.claudeSessionId,
    original.sessionId,
    'PtySession spawned with the prior providerSessionId',
  );
  assert.equal(
    s1.lastOpts.extraEnv?.PC_AGENT_SESSION_ID,
    original.sessionId,
    'PC_AGENT_SESSION_ID reflects the reused session id',
  );

  // Drive continuation to completion and verify persistence of the link.
  s1.becomeReady();
  s1.emitTurnEnd('point 3 expanded: ...');
  const contResult = await cont.completion;
  assert.equal(contResult.status, 'completed');
  assert.equal(contResult.result, 'point 3 expanded: ...');
  const contRow = getAgentRunRow(cont.runId);
  assert.equal(contRow?.status, 'completed');
  assert.equal(
    contRow?.continues,
    original.runId,
    'continuation row persists the continues FK',
  );
  assert.equal(
    contRow?.sessionId,
    original.sessionId,
    'persisted sessionId matches the reused provider session id',
  );
});

// Section 24 (post-pivot) — quiet-window-gated send for resumed spawns.
// On `state: 'ready'`, the manager defers `session.send(initialInput)` via
// a poller that waits until stdout has been silent for ≥1500ms past ready
// AND ≥1500ms since the last chunk. The labs harness proved 38/38 PASS
// under this gating. Original Section 24 design (autonomous pc_check_in
// tool call) didn't work because claude.exe --resume waits for user input
// to trigger a turn.
test('Section 24 (post-pivot) — resume defers initialInput send until stdout-quiet window passes', async () => {
  const p = createProject({
    slug: 'arm-quiet-window',
    name: 'ARM Quiet Window',
    stages,
    folderPath: tmpDataDir,
  });
  const { factory, sessions } = makeFactory();
  const mgr = new AgentRunManager({
    warmupPrompt: null,
    createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-quiet-window', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  // Original dispatch.
  const original = mgr.spawn({
    agentName: 'researcher',
    input: 'find a date math lib',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'quiet-window-dispatcher',
    worktreeDir: tmpDataDir,
  });
  const s0 = sessions[0]!;
  s0.becomeReady();
  s0.emitTurnEnd('use date-fns');
  await original.completion;

  // Continuation — Section 24 (post-pivot) path. The manager arms a
  // quiet-window poller on ready instead of firing the send immediately.
  // We use real wall-clock timers here (no fake setTimeout injection) so
  // the poller actually runs; the test waits ~2s for the quiet window to
  // elapse. Spawn-stuck (120s) and wall-clock (2h) defaults stay well
  // outside this window.
  const cont = mgr.spawn({
    agentName: 'researcher',
    input: 'expand on point 3',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'quiet-window-dispatcher',
    worktreeDir: tmpDataDir,
    continues: original.runId,
    resume: { providerSessionId: original.sessionId },
  });
  const s1 = sessions[1]!;

  // On ready, the manager does NOT send synchronously — the poller is
  // armed instead.
  s1.becomeReady();
  assert.equal(
    s1.sent.length,
    0,
    'resume defers send on ready (quiet-window poller armed)',
  );
  assert.equal(
    mgr.get(cont.runId)?.status,
    'running',
    'resume flips spawning → running on ready (send pending)',
  );

  // Wait past the quiet window (1500ms threshold + small buffer for the
  // poll cadence). No chunks emitted in this window → quietFor grows
  // unbounded → poller fires the send on its next tick.
  await new Promise<void>((r) => setTimeout(r, 1800));
  assert.deepEqual(
    s1.sent,
    ['expand on point 3'],
    'quiet window passed: initialInput sent via PTY',
  );

  // Drive to completion.
  s1.emitTurnEnd('point 3 expanded: ...');
  const contResult = await cont.completion;
  assert.equal(contResult.status, 'completed');
  assert.equal(contResult.result, 'point 3 expanded: ...');
});
