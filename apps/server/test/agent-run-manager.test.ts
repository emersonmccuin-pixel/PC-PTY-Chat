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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
      createSession: factory,
      scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-b7', pid, rid),
      resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
    });

    const { runId, completion } = mgr.spawn({
      agentName: 'b7-global',
      input: 'go',
      wait: true,
      projectId: p.id as ULID,
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
    createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-unknown', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { completion } = mgr.spawn({
    agentName: 'no-such-agent',
    input: 'anything',
    wait: false,
    projectId: p.id as ULID,
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
    createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-b1', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { runId, completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'read CLAUDE.md',
    wait: true,
    projectId: p.id as ULID,
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
    createSession: factory,
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
    createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-worktree', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });
  const myWorktree = join(tmpDataDir, 'arm-worktree-cwd');
  const { runId } = mgr.spawn({
    agentName: 'researcher',
    input: 'go',
    wait: false,
    projectId: p.id as ULID,
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
    createSession: factory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'arm-list', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  // Run 1 → complete it.
  const r1 = mgr.spawn({
    agentName: 'a1',
    input: 'go',
    wait: true,
    projectId: p.id as ULID,
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
    createSession: factory,
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
