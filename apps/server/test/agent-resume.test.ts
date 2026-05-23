// Section 16b.2b unit tests — resume primitive.
//
// Exercises the lookup → atomic flip → spawn → send-answer path with a fake
// session factory. Real PtySession isn't booted (no claude.exe spawn) —
// these are pure wire-up + state-machine tests. End-to-end smoke lives in
// 16b.13 once the MCP-tool surfaces ship.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDataDir = mkdtempSync(join(tmpdir(), 'pc-agent-resume-'));
process.env.PC_DATA_DIR = tmpDataDir;

const {
  closeDb,
  newId,
  runMigrations,
  createProject,
  createAgent,
  createPendingAsk,
  getPendingAsk,
} = await import('@pc/db');
import type { Stage, ULID } from '@pc/domain';

import { respawnAgentWithAnswer } from '../src/services/agent-resume.ts';
import type { ResumeSessionLike } from '../src/services/agent-resume.ts';
import type { JsonlEvent, PtySessionOptions, SessionState } from '@pc/runtime';
import {
  AgentRunManager,
  type AgentSessionLike,
} from '../src/services/agent-run-manager.ts';

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

before(() => {
  runMigrations();
  // Agent-name resolution requires a live global pod row. Seed `researcher`
  // so spawn doesn't fail-fast with cause='unknown-agent'.
  createAgent(
    {
      name: 'researcher',
      scope: 'global',
      prompt: 'researcher test stub',
      tools: [],
      model: 'sonnet',
      effort: null,
      maxTurns: null,
      outputDestination: null,
      description: 'researcher test stub',
    },
    { actor: 'orchestrator', reason: 'system-seed:test-fixture' },
  );
});

after(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

class FakeSession extends EventEmitter implements ResumeSessionLike {
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
  }
  getState(): SessionState {
    return this.state;
  }
}

function makeFakeFactory() {
  const sessions: FakeSession[] = [];
  const factory = (opts: PtySessionOptions): ResumeSessionLike => {
    const s = new FakeSession(opts);
    sessions.push(s);
    // Defer the `ready` event so callers wire listeners before it fires.
    setImmediate(() => s.emit('state', 'ready'));
    return s;
  };
  return { factory, sessions };
}

test('respawnAgentWithAnswer happy path: flips waiting → answered, spawns, sends answer', async () => {
  const p = createProject({ slug: 'ar-happy', name: 'AR Happy', stages, folderPath: tmpDataDir });
  const id = newId();
  createPendingAsk({
    id,
    sessionId: 'sess-ar-1',
    agentName: 'researcher',
    projectId: p.id as ULID,
    kind: 'ask-orchestrator',
    question: 'which lib?',
    context: 'looked at three',
    now: 1700_000_100_000,
  });

  const { factory, sessions } = makeFakeFactory();
  const sessionDataDir = join(tmpDataDir, 'scratch');
  const result = await respawnAgentWithAnswer(
    {
      pendingAskId: id,
      answer: 'use zod',
      answeredBy: 'orchestrator',
      now: 1700_000_200_000,
    },
    {
      createSession: factory,
      sessionDataDirFor: () => sessionDataDir,
      resolveJsonlPath: (folderPath, sessionId) => `${folderPath}/.fake/${sessionId}.jsonl`,
      readyTimeoutMs: 2_000,
    },
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.equal(result.sessionId, 'sess-ar-1');
    assert.equal(result.status, 'resuming');
  }

  const row = getPendingAsk(id);
  assert.equal(row!.status, 'answered');
  assert.equal(row!.answer, 'use zod');
  assert.equal(row!.answeredBy, 'orchestrator');
  assert.equal(row!.answeredAt, 1700_000_200_000);

  assert.equal(sessions.length, 1, 'one session spawned');
  assert.deepEqual(sessions[0]!.sent, ['use zod'], 'answer sent exactly once');
  // Verify the resume-flavored opts.
  assert.equal(sessions[0]!.lastOpts.agentName, 'researcher');
  assert.equal(sessions[0]!.lastOpts.claudeSessionId, 'sess-ar-1');
  assert.equal(sessions[0]!.lastOpts.resume, true);
  assert.ok(
    sessions[0]!.lastOpts.jsonlPath!.includes('sess-ar-1.jsonl'),
    'jsonl path resolves to the session id',
  );
});

test('respawnAgentWithAnswer rejects already-answered rows (replay-safe)', async () => {
  const p = createProject({ slug: 'ar-replay', name: 'AR Replay', stages, folderPath: tmpDataDir });
  const id = newId();
  createPendingAsk({
    id,
    sessionId: 'sess-ar-2',
    agentName: 'researcher',
    projectId: p.id as ULID,
    kind: 'ask-orchestrator',
    question: 'q',
    now: 1700_000_300_000,
  });

  const { factory: f1, sessions: s1 } = makeFakeFactory();
  const r1 = await respawnAgentWithAnswer(
    { pendingAskId: id, answer: 'first', answeredBy: 'orchestrator', now: 1700_000_310_000 },
    {
      createSession: f1,
      sessionDataDirFor: () => join(tmpDataDir, 'scratch-r1'),
      resolveJsonlPath: () => '/dev/null',
      readyTimeoutMs: 2_000,
    },
  );
  assert.equal(r1.ok, true);
  assert.equal(s1.length, 1);

  const { factory: f2, sessions: s2 } = makeFakeFactory();
  const r2 = await respawnAgentWithAnswer(
    { pendingAskId: id, answer: 'second', answeredBy: 'user', now: 1700_000_320_000 },
    {
      createSession: f2,
      sessionDataDirFor: () => join(tmpDataDir, 'scratch-r2'),
      resolveJsonlPath: () => '/dev/null',
      readyTimeoutMs: 2_000,
    },
  );
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.cause, 'already-answered');
  assert.equal(s2.length, 0, 'no second spawn');

  const row = getPendingAsk(id);
  assert.equal(row!.answer, 'first', 'original answer preserved');
});

test('respawnAgentWithAnswer rejects unknown pending-ask id', async () => {
  const { factory, sessions } = makeFakeFactory();
  const r = await respawnAgentWithAnswer(
    {
      pendingAskId: newId(),
      answer: 'x',
      answeredBy: 'orchestrator',
      now: Date.now(),
    },
    {
      createSession: factory,
      sessionDataDirFor: () => join(tmpDataDir, 'scratch-unk'),
      resolveJsonlPath: () => '/dev/null',
      readyTimeoutMs: 2_000,
    },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.cause, 'unknown-pending-ask');
  assert.equal(sessions.length, 0);
});

test('respawnAgentWithAnswer surfaces readyTimeoutMs as resume-failed', async () => {
  const p = createProject({ slug: 'ar-to', name: 'AR Timeout', stages, folderPath: tmpDataDir });
  const id = newId();
  createPendingAsk({
    id,
    sessionId: 'sess-to',
    agentName: 'researcher',
    projectId: p.id as ULID,
    kind: 'ask-user',
    question: 'q',
    now: 1700_000_400_000,
  });

  // Factory that never emits `ready`.
  const stuckSessions: FakeSession[] = [];
  const stuckFactory = (opts: PtySessionOptions): ResumeSessionLike => {
    const s = new FakeSession(opts);
    stuckSessions.push(s);
    return s;
  };

  const r = await respawnAgentWithAnswer(
    {
      pendingAskId: id,
      answer: 'x',
      answeredBy: 'user',
      now: 1700_000_410_000,
    },
    {
      createSession: stuckFactory,
      sessionDataDirFor: () => join(tmpDataDir, 'scratch-to'),
      resolveJsonlPath: () => '/dev/null',
      readyTimeoutMs: 50,
    },
  );

  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.cause, 'resume-failed');
  assert.equal(stuckSessions[0]!.killed, true, 'stuck session was killed on timeout');

  // Atomic flip already happened — the row is now `answered` even though
  // the spawn failed. That's the documented contract: the answer is
  // recorded; the resume-failure is surfaced to the orchestrator so it can
  // retry the answer or escalate.
  const row = getPendingAsk(id);
  assert.equal(row!.status, 'answered');
});

// Section 16b.4.2 — wiring test. Proves the resume primitive hands the
// freshly-spawned PtySession back to the AgentRunManager when a tracked
// run exists, so the original spawn's completion Promise resolves across
// the pause→resume boundary.
test('respawn primitive re-attaches resumed session to the tracked run (16b.4.2)', async () => {
  const p = createProject({
    slug: 'ar-mgr-attach',
    name: 'AR Manager Attach',
    stages,
    folderPath: tmpDataDir,
  });

  // Manager-owned factory: no auto-ready (we drive ready manually to
  // sequence the spawn-time initial-input assertion).
  const spawnSessions: FakeSession[] = [];
  const spawnFactory = (opts: PtySessionOptions): AgentSessionLike => {
    const s = new FakeSession(opts);
    spawnSessions.push(s);
    return s;
  };
  const mgr = new AgentRunManager({
    warmupPrompt: null, createSession: spawnFactory,
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'ar-mgr-attach', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { runId, sessionId, completion } = mgr.spawn({
    agentName: 'researcher',
    input: 'find a lib for date math',
    wait: true,
    projectId: p.id as ULID,
    dispatcherSessionId: 'test-dispatcher-session',
    worktreeDir: tmpDataDir,
  });

  // Drive spawn session to ready; manager sends the initial input.
  const spawnSess = spawnSessions[0]!;
  spawnSess.state = 'ready';
  spawnSess.emit('state', 'ready');
  assert.deepEqual(spawnSess.sent, ['find a lib for date math']);

  // Pre-stage the pending-ask row so the manager flips to paused on the
  // next turn-end (mirrors pc_ask_orchestrator's contract).
  const pendingAskId = newId();
  createPendingAsk({
    id: pendingAskId,
    sessionId,
    agentName: 'researcher',
    projectId: p.id as ULID,
    kind: 'ask-orchestrator',
    question: 'which one?',
    now: 1700_001_000_000,
  });

  const turnEnd: JsonlEvent = {
    kind: 'jsonl-turn-end',
    text: 'asking orchestrator',
    stopReason: 'end_turn',
  };
  spawnSess.emit('jsonl-event', turnEnd);
  assert.equal(mgr.get(runId)!.status, 'paused');
  // Completion has not resolved.
  const racePending = await Promise.race([
    completion.then(() => 'resolved' as const),
    new Promise<'pending'>((r) => setImmediate(() => r('pending'))),
  ]);
  assert.equal(racePending, 'pending');

  // Resume — pass the SAME manager via deps so the resumed session re-
  // attaches to the original run (vs. running ungoverned).
  const { factory: resumeFactory, sessions: resumeSessions } = makeFakeFactory();
  const resumeJsonlPath = join(tmpDataDir, 'ar-mgr-attach-resume.jsonl');
  writeFileSync(
    resumeJsonlPath,
    [
      '{"type":"system","subtype":"init"}',
      '{"type":"user","message":{}}',
      '{"type":"assistant","message":{}}',
    ].join('\n') + '\n',
  );
  const result = await respawnAgentWithAnswer(
    {
      pendingAskId,
      answer: 'use date-fns',
      answeredBy: 'orchestrator',
      now: 1700_001_010_000,
    },
    {
      agentRunManager: mgr,
      createSession: resumeFactory,
      sessionDataDirFor: () => join(tmpDataDir, 'scratch-mgr-attach'),
      resolveJsonlPath: () => resumeJsonlPath,
      readyTimeoutMs: 2_000,
    },
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(resumeSessions.length, 1, 'one resumed session spawned');
  assert.equal(
    resumeSessions[0]!.lastOpts.jsonlStartLine,
    3,
    'paused-agent resume skips historical JSONL already on disk',
  );
  assert.deepEqual(
    resumeSessions[0]!.sent,
    ['use date-fns'],
    'answer is sent on the resumed session (not the original)',
  );
  // Manager flipped paused → running.
  assert.equal(mgr.get(runId)!.status, 'running');

  // Drive the resumed session to terminal turn-end. No new pending-ask is
  // waiting → manager calls complete() → original spawn's completion
  // Promise resolves with the resumed turn's text.
  const finalTurn: JsonlEvent = {
    kind: 'jsonl-turn-end',
    text: 'final answer: use date-fns',
    stopReason: 'end_turn',
  };
  resumeSessions[0]!.emit('jsonl-event', finalTurn);

  const finalRec = await completion;
  assert.equal(finalRec.status, 'completed');
  assert.equal(finalRec.result, 'final answer: use date-fns');
  assert.equal(finalRec.runId, runId);
});

// Section 16b.4.2 — no-op path. When no run is tracked for the paused
// session-id, the resume primitive still works: the resumed session runs
// ungoverned (caller-side concerns like orchestrator chat replays don't
// route through the manager). This pins down the "ad-hoc resume" contract.
test('respawn primitive runs ungoverned when no run is tracked (16b.4.2)', async () => {
  const p = createProject({
    slug: 'ar-mgr-untracked',
    name: 'AR Manager Untracked',
    stages,
    folderPath: tmpDataDir,
  });
  const askId = newId();
  createPendingAsk({
    id: askId,
    sessionId: 'sess-untracked',
    agentName: 'researcher',
    projectId: p.id as ULID,
    kind: 'ask-orchestrator',
    question: 'q',
    now: 1700_002_000_000,
  });

  // Fresh manager that has NEVER seen this session-id — findRunIdBySession
  // returns null and respawn skips the attach.
  const mgr = new AgentRunManager({
    warmupPrompt: null,
    createSession: () => {
      throw new Error('manager.createSession should not be called on the untracked path');
    },
    scratchDirFor: (pid, rid) => join(tmpDataDir, 'ar-mgr-untracked', pid, rid),
    resolveJsonlPath: (_d, sid) => join(tmpDataDir, `.fake/${sid}.jsonl`),
  });

  const { factory, sessions } = makeFakeFactory();
  const result = await respawnAgentWithAnswer(
    {
      pendingAskId: askId,
      answer: 'a',
      answeredBy: 'orchestrator',
      now: 1700_002_010_000,
    },
    {
      agentRunManager: mgr,
      createSession: factory,
      sessionDataDirFor: () => join(tmpDataDir, 'scratch-untracked'),
      resolveJsonlPath: () => '/dev/null',
      readyTimeoutMs: 2_000,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(sessions.length, 1, 'session still spawned even without a tracked run');
  assert.deepEqual(sessions[0]!.sent, ['a']);
  // No tracked run materialised on the manager from this path.
  assert.equal(mgr.findRunIdBySession('sess-untracked'), null);
});
