// Section 16b.2b unit tests — resume primitive.
//
// Exercises the lookup → atomic flip → spawn → send-answer path with a fake
// session factory. Real PtySession isn't booted (no claude.exe spawn) —
// these are pure wire-up + state-machine tests. End-to-end smoke lives in
// 16b.13 once the MCP-tool surfaces ship.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDataDir = mkdtempSync(join(tmpdir(), 'pc-agent-resume-'));
process.env.PC_DATA_DIR = tmpDataDir;

const {
  closeDb,
  newId,
  runMigrations,
  createProject,
  createPendingAsk,
  getPendingAsk,
} = await import('@pc/db');
import type { Stage, ULID } from '@pc/domain';

import { respawnAgentWithAnswer } from '../src/services/agent-resume.ts';
import type { ResumeSessionLike } from '../src/services/agent-resume.ts';
import type { PtySessionOptions } from '@pc/runtime';

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

class FakeSession extends EventEmitter implements ResumeSessionLike {
  sent: string[] = [];
  killed = false;
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
