// Section 25 Session 8 — pause/resume/continuation orchestration tests.
//
// Exercises the three primitives + active-runs registry against:
//  - A real @pc/db (temp data dir).
//  - A real ChannelServer (ephemeral port).
//  - A fake AgentRun implementing the SpawnLike-shaped wrapper surface
//    (state machine + _markPaused / _resumeWithAnswer + terminal event).
//
// Section 9's MCP tools and Session 11's cutover are the production
// callers; this suite pins the contract they'll integrate against.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-server-v2-pause-resume-'));
process.env.PC_DATA_DIR = tmpDir;
delete process.env.PC_DELIVERY_TRANSPORT;

const {
  closeDb,
  runMigrations,
  createProject,
  createAgent,
  createPendingAsk,
  getAgentRunRow,
  getPendingAsk,
  insertAgentRunRow,
  markAgentRunTerminal,
  newId,
} = await import('@pc/db');
const { ChannelServer } = await import('../src/services/channel-server.ts');
const { ActiveRunRegistry } = await import('../src/services/agent-active-runs.ts');
const {
  answerPendingAsk,
  cancelPendingAsk,
  continueAgent,
  recordExplicitPause,
} = await import('../src/services/pause-resume.ts');
import { projectDirFor } from '@pc/runtime';

import type { Stage, ULID } from '@pc/domain';

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

let server: InstanceType<typeof ChannelServer>;
let actualPort = 0;
let projectId: ULID;
let slug: string;
let projectFolder: string;

interface Captured {
  events: Array<{ payload: { source: string; body: string; sender?: string } }>;
}
const captured: Captured = { events: [] };

before(async () => {
  runMigrations();
  // Project folder must exist on disk; the JSONL retention guard
  // computes paths under ~/.claude/projects/<encoded-cwd>/.
  projectFolder = join(tmpDir, 'pause-resume-project');
  mkdirSync(projectFolder, { recursive: true });
  const p = createProject({
    slug: 'v2-pause-resume',
    name: 'V2 Pause Resume',
    stages,
    folderPath: projectFolder,
  });
  projectId = p.id as ULID;
  slug = p.slug;

  // Seed a stock pod row so pod-revision computation has something to read.
  createAgent(
    {
      id: newId(),
      scope: 'global',
      name: 'researcher',
      prompt: 'You are a researcher.',
      tools: [],
      description: 'Lab researcher pod',
    },
    { actor: 'orchestrator', reason: 'test seed' },
  );

  server = new ChannelServer({
    port: 0,
    allowedSenders: new Set(),
    onEvent: (_pid, payload) => {
      captured.events.push({ payload });
    },
  });
  server.start();
  for (let i = 0; i < 50; i++) {
    const addr = (
      server as unknown as { httpServer: { address(): { port: number } | null } }
    ).httpServer?.address();
    if (addr && typeof addr === 'object' && 'port' in addr && addr.port > 0) {
      actualPort = addr.port;
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(actualPort > 0, 'channel server did not bind a port');
});

after(() => {
  server.shutdown();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ──────────────────────────── FAKE AGENT RUN ──────────────────────────────

interface FakeAgentRunOpts {
  agentRunId: ULID;
  ccSessionId: string;
  state?: 'queued' | 'spawning' | 'running' | 'paused';
}

type FakeRunState =
  | 'queued'
  | 'spawning'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

class FakeAgentRun extends EventEmitter {
  private state: FakeRunState;
  private record: {
    agentRunId: ULID;
    ccProviderSessionId: string;
    podName: string;
    state: FakeRunState;
    pendingAskId?: string;
  };
  resumeAnswers: string[] = [];
  cancelCount = 0;

  constructor(opts: FakeAgentRunOpts) {
    super();
    this.state = opts.state ?? 'running';
    this.record = {
      agentRunId: opts.agentRunId,
      ccProviderSessionId: opts.ccSessionId,
      podName: 'researcher',
      state: this.state,
    };
  }

  getState() {
    return this.state;
  }

  getRecord() {
    return { ...this.record };
  }

  _markPaused(askId: string) {
    if (this.state !== 'running') return;
    this.state = 'paused';
    this.record.state = 'paused';
    this.record.pendingAskId = askId;
    this.emit('paused', askId);
    this.emit('state', 'paused', 'running');
  }

  _resumeWithAnswer(answer: string) {
    if (this.state !== 'paused') return;
    this.state = 'spawning';
    this.record.state = 'spawning';
    this.record.pendingAskId = undefined;
    this.resumeAnswers.push(answer);
    this.emit('state', 'spawning', 'paused');
  }

  cancel() {
    this.cancelCount += 1;
    this.state = 'cancelled';
    this.record.state = 'cancelled';
    this.emit('terminal', { status: 'cancelled', cause: 'cancelled', result: undefined });
  }

  /** Simulate terminal transition (production AgentRun fires this on
   *  completed / failed / cancelled). */
  fireTerminal(status: 'completed' | 'failed' | 'cancelled') {
    this.state = status;
    this.record.state = status;
    this.emit('terminal', { status, cause: status === 'cancelled' ? 'cancelled' : undefined });
  }
}

function seedAgentRunRow(
  runId: ULID,
  ccSessionId: string,
  status: 'queued' | 'spawning' | 'running' | 'paused' = 'running',
): void {
  insertAgentRunRow({
    id: runId,
    projectId,
    podName: 'researcher',
    dispatcherSessionId: 'orch-sess',
    ccSessionId,
    status,
    input: 'go',
    queuedAt: 1_700_000_000_000,
  });
}

async function registerFakeChild(sessionId: string, buf: unknown[]): Promise<WebSocket> {
  const url =
    `ws://127.0.0.1:${actualPort}/channel-register?projectId=${projectId}` +
    `&sessionId=${encodeURIComponent(sessionId)}&slug=${slug}`;
  const ws = new WebSocket(url);
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  ws.on('message', (data) => {
    try {
      buf.push(JSON.parse(String(data)));
    } catch {
      buf.push(String(data));
    }
  });
  await new Promise((r) => setTimeout(r, 30));
  return ws;
}

// ──────────────────────────── recordExplicitPause ───────────────────────

test('recordExplicitPause — happy path writes ask row + marks paused + delivers event', () => {
  const reg = new ActiveRunRegistry();
  const runId = newId() as ULID;
  const ccSession = `cc-${runId}`;
  seedAgentRunRow(runId, ccSession);
  const run = new FakeAgentRun({ agentRunId: runId, ccSessionId: ccSession });
  reg.register({
    run: run as never,
    projectId,
    dispatcherSessionId: 'orch-sess',
    ccSessionId: ccSession,
    podName: 'researcher',
    podRevisionAtDispatch: 'agent:1700000000000.k:0',
  });

  const before = captured.events.length;
  const result = recordExplicitPause(
    {
      agentRunId: runId,
      kind: 'orchestrator',
      promptBody: 'What is your favorite color?',
      now: 1_700_000_001_000,
    },
    { channelServer: server, slug, registry: reg },
  );

  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(result.pendingAskId);
  assert.equal(typeof result.eventDelivered, 'boolean');

  // Row written + status open + body present.
  const ask = getPendingAsk(result.pendingAskId)!;
  assert.equal(ask.status, 'open');
  assert.equal(ask.kind, 'orchestrator');
  assert.equal(ask.promptBody, 'What is your favorite color?');
  assert.equal(ask.ccSessionId, ccSession);

  // Run flipped paused (in-memory + persisted).
  assert.equal(run.getState(), 'paused');
  assert.equal(getAgentRunRow(runId)!.status, 'paused');

  // Event was attempted (no registrant; channelDelivered=false; row stays
  // pending). Inbox row exists.
  assert.equal(result.eventDelivered, false);
  assert.ok(result.eventInboxId);
  // Suppress unused-var lint when assertions on `before` are dropped.
  void before;
});

test('recordExplicitPause — unknown agent run id returns 404-shaped error', () => {
  const reg = new ActiveRunRegistry();
  const result = recordExplicitPause(
    {
      agentRunId: newId() as ULID,
      kind: 'orchestrator',
      promptBody: '?',
    },
    { channelServer: server, slug, registry: reg },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.cause, 'unknown-run');
});

test('recordExplicitPause — pausing a non-running run rejects', () => {
  const reg = new ActiveRunRegistry();
  const runId = newId() as ULID;
  const ccSession = `cc-${runId}`;
  seedAgentRunRow(runId, ccSession, 'paused');
  const run = new FakeAgentRun({ agentRunId: runId, ccSessionId: ccSession, state: 'paused' });
  reg.register({
    run: run as never,
    projectId,
    dispatcherSessionId: 'orch-sess',
    ccSessionId: ccSession,
    podName: 'researcher',
    podRevisionAtDispatch: null,
  });

  const result = recordExplicitPause(
    {
      agentRunId: runId,
      kind: 'orchestrator',
      promptBody: '?',
    },
    { channelServer: server, slug, registry: reg },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.cause, 'wrong-state');
});

test('recordExplicitPause — pushes event over a live registrant', async () => {
  const reg = new ActiveRunRegistry();
  const runId = newId() as ULID;
  const ccSession = `cc-${runId}`;
  const dispatcherSession = `orch-${runId}`;
  seedAgentRunRow(runId, ccSession);
  const run = new FakeAgentRun({ agentRunId: runId, ccSessionId: ccSession });
  reg.register({
    run: run as never,
    projectId,
    dispatcherSessionId: dispatcherSession,
    ccSessionId: ccSession,
    podName: 'researcher',
    podRevisionAtDispatch: null,
  });

  const inbox: unknown[] = [];
  const ws = await registerFakeChild(dispatcherSession, inbox);

  const before = captured.events.length;
  const result = recordExplicitPause(
    {
      agentRunId: runId,
      kind: 'user',
      promptBody: 'Pick one',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    },
    { channelServer: server, slug, registry: reg },
  );

  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.eventDelivered, true);

  // Give the WS bubble time to land.
  await new Promise((r) => setTimeout(r, 100));
  ws.close();

  const channelMsgs = inbox.filter(
    (m) =>
      typeof m === 'object' &&
      m !== null &&
      (m as { type?: string }).type === 'channel-event',
  );
  assert.ok(channelMsgs.length >= 1, 'expected at least one channel push');
  const lastBody = (channelMsgs[channelMsgs.length - 1] as { content?: string }).content ?? '';
  assert.ok(lastBody.includes('[pc:agent-event kind=agent-asks-user'));
  assert.ok(lastBody.includes('Pick one'));
  assert.ok(lastBody.includes('Options:'));
  assert.ok(captured.events.length > before);
});

// ──────────────────────────── answerPendingAsk ──────────────────────────

test('answerPendingAsk — happy path: flips row + drives resume', () => {
  const reg = new ActiveRunRegistry();
  const runId = newId() as ULID;
  const ccSession = `cc-${runId}`;
  const askId = newId() as ULID;
  seedAgentRunRow(runId, ccSession, 'paused');
  createPendingAsk({
    id: askId,
    agentRunId: runId,
    ccSessionId: ccSession,
    projectId,
    kind: 'orchestrator',
    promptBody: '?',
    now: 1_700_000_000_000,
  });
  const run = new FakeAgentRun({ agentRunId: runId, ccSessionId: ccSession, state: 'paused' });
  reg.register({
    run: run as never,
    projectId,
    dispatcherSessionId: 'orch-sess',
    ccSessionId: ccSession,
    podName: 'researcher',
    podRevisionAtDispatch: 'agent:1700000000000.k:0',
  });

  const result = answerPendingAsk(
    { pendingAskId: askId, answer: 'blue', answeredBy: 'orchestrator' },
    { channelServer: server, slug, registry: reg },
  );

  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.agentRunId, runId);
  assert.equal(result.ccSessionId, ccSession);
  // Pod row's revision computed from agents table.
  assert.ok(result.podRevisionAtResume !== null);

  // Run was resumed with the answer.
  assert.deepEqual(run.resumeAnswers, ['blue']);

  // Row flipped + persisted.
  const askPost = getPendingAsk(askId)!;
  assert.equal(askPost.status, 'answered');
  assert.equal(askPost.answerBody, 'blue');
  assert.equal(askPost.answeredBy, 'orchestrator');
  assert.equal(getAgentRunRow(runId)!.status, 'spawning');
});

test('answerPendingAsk — unknown pending-ask id returns 404 cause', () => {
  const result = answerPendingAsk(
    { pendingAskId: newId() as ULID, answer: 'x', answeredBy: 'orchestrator' },
    { channelServer: server, slug, registry: new ActiveRunRegistry() },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.cause, 'unknown-pending-ask');
});

test('answerPendingAsk — already-answered row rejects', () => {
  const reg = new ActiveRunRegistry();
  const runId = newId() as ULID;
  const ccSession = `cc-${runId}`;
  const askId = newId() as ULID;
  seedAgentRunRow(runId, ccSession, 'paused');
  createPendingAsk({
    id: askId,
    agentRunId: runId,
    ccSessionId: ccSession,
    projectId,
    kind: 'orchestrator',
    promptBody: '?',
    now: 1_700_000_000_000,
  });
  const run = new FakeAgentRun({ agentRunId: runId, ccSessionId: ccSession, state: 'paused' });
  reg.register({
    run: run as never,
    projectId,
    dispatcherSessionId: 'orch-sess',
    ccSessionId: ccSession,
    podName: 'researcher',
    podRevisionAtDispatch: null,
  });

  const first = answerPendingAsk(
    { pendingAskId: askId, answer: 'a', answeredBy: 'orchestrator' },
    { channelServer: server, slug, registry: reg },
  );
  assert.ok(first.ok);

  const second = answerPendingAsk(
    { pendingAskId: askId, answer: 'b', answeredBy: 'orchestrator' },
    { channelServer: server, slug, registry: reg },
  );
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.cause, 'already-answered');
});

test('answerPendingAsk — flag drift when pod row revision changes', () => {
  const reg = new ActiveRunRegistry();
  const runId = newId() as ULID;
  const ccSession = `cc-${runId}`;
  const askId = newId() as ULID;
  seedAgentRunRow(runId, ccSession, 'paused');
  createPendingAsk({
    id: askId,
    agentRunId: runId,
    ccSessionId: ccSession,
    projectId,
    kind: 'orchestrator',
    promptBody: '?',
    now: 1_700_000_000_000,
  });
  const run = new FakeAgentRun({ agentRunId: runId, ccSessionId: ccSession, state: 'paused' });
  reg.register({
    run: run as never,
    projectId,
    dispatcherSessionId: 'orch-sess',
    ccSessionId: ccSession,
    podName: 'researcher',
    // Pretend dispatch happened against an older revision.
    podRevisionAtDispatch: 'agent:1234567890.k:0',
  });

  const result = answerPendingAsk(
    { pendingAskId: askId, answer: 'x', answeredBy: 'orchestrator' },
    { channelServer: server, slug, registry: reg },
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.podRevisionDrifted, true);
});

// ──────────────────────────── cancelPendingAsk ──────────────────────────

test('cancelPendingAsk — flips row to cancelled and cancels the run', () => {
  const reg = new ActiveRunRegistry();
  const runId = newId() as ULID;
  const ccSession = `cc-${runId}`;
  const askId = newId() as ULID;
  seedAgentRunRow(runId, ccSession, 'paused');
  createPendingAsk({
    id: askId,
    agentRunId: runId,
    ccSessionId: ccSession,
    projectId,
    kind: 'orchestrator',
    promptBody: '?',
    now: 1_700_000_000_000,
  });
  const run = new FakeAgentRun({ agentRunId: runId, ccSessionId: ccSession, state: 'paused' });
  reg.register({
    run: run as never,
    projectId,
    dispatcherSessionId: 'orch-sess',
    ccSessionId: ccSession,
    podName: 'researcher',
    podRevisionAtDispatch: null,
  });

  const result = cancelPendingAsk({ pendingAskId: askId }, { registry: reg });
  assert.ok(result.ok);
  assert.equal(run.cancelCount, 1);
  assert.equal(getPendingAsk(askId)!.status, 'cancelled');

  // Second cancel is a no-op.
  const second = cancelPendingAsk({ pendingAskId: askId }, { registry: reg });
  assert.equal(second.ok, false);
});

// ──────────────────────────── continueAgent ─────────────────────────────

function ensureCcJsonl(ccSessionId: string): string {
  // Mirror what CC would write on disk after a session reaches terminal.
  // The continuation path's retention guard checks this file's existence.
  // projectDirFor honors CLAUDE_CONFIG_DIR (Section 15 lesson) so the
  // file lands where jsonlPathFor inside pause-resume.ts will look.
  const dir = projectDirFor(projectFolder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${ccSessionId}.jsonl`);
  writeFileSync(path, '{"type":"user","message":"hi"}\n');
  return path;
}

function seedTerminalParent(): { runId: ULID; ccSession: string; jsonlPath: string } {
  const runId = newId() as ULID;
  const ccSession = `cc-${runId}`;
  seedAgentRunRow(runId, ccSession, 'running');
  markAgentRunTerminal({
    id: runId,
    status: 'completed',
    result: 'parent done',
    failureCause: null,
    failureReason: null,
    completedAt: 1_700_000_001_000,
  });
  const jsonlPath = ensureCcJsonl(ccSession);
  return { runId, ccSession, jsonlPath };
}

test('continueAgent — happy path mints new row linked to parent', () => {
  const { runId: parentId, ccSession } = seedTerminalParent();
  const result = continueAgent({
    parentAgentRunId: parentId,
    input: 'follow up — say DONE',
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.plan.ccSessionId, ccSession);
  assert.equal(result.plan.podName, 'researcher');
  assert.ok(result.plan.podRevisionAtDispatch);

  // Row exists, status=queued, continues link points at parent.
  const newRow = getAgentRunRow(result.plan.agentRunId)!;
  assert.equal(newRow.status, 'queued');
  assert.equal(newRow.continues, parentId);
  assert.equal(newRow.input, 'follow up — say DONE');
});

test('continueAgent — concurrent continuation rejects with 409 cause', () => {
  const { runId: parentId } = seedTerminalParent();
  const first = continueAgent({ parentAgentRunId: parentId, input: 'a' });
  assert.ok(first.ok);
  // Second attempt while the first continuation is still 'queued' → reject.
  const second = continueAgent({ parentAgentRunId: parentId, input: 'b' });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.cause, 'concurrent-continuation');
});

test('continueAgent — parent not in terminal state rejects with not-continuable', () => {
  const runId = newId() as ULID;
  seedAgentRunRow(runId, `cc-${runId}`, 'running');
  const result = continueAgent({ parentAgentRunId: runId, input: 'x' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.cause, 'not-continuable');
});

test('continueAgent — swept JSONL → session-expired', () => {
  const { runId: parentId, jsonlPath } = seedTerminalParent();
  // Drop the JSONL so the retention guard fires.
  rmSync(jsonlPath, { force: true });
  const result = continueAgent({ parentAgentRunId: parentId, input: 'x' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.cause, 'session-expired');
});

test('continueAgent — unknown parent run → run-not-found', () => {
  const result = continueAgent({
    parentAgentRunId: newId() as ULID,
    input: 'x',
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.cause, 'run-not-found');
});

// ──────────────────────────── ActiveRunRegistry ──────────────────────────

test('ActiveRunRegistry — register + lookup by id and ccSession', () => {
  const reg = new ActiveRunRegistry();
  const runId = newId() as ULID;
  const ccSession = `cc-${runId}`;
  const run = new FakeAgentRun({ agentRunId: runId, ccSessionId: ccSession });
  reg.register({
    run: run as never,
    projectId,
    dispatcherSessionId: 'orch-sess',
    ccSessionId: ccSession,
    podName: 'researcher',
    podRevisionAtDispatch: 'rev-1',
  });

  assert.ok(reg.get(runId));
  assert.equal(reg.get(runId)!.podName, 'researcher');
  assert.ok(reg.getByCcSession(ccSession));
  assert.equal(reg.getByCcSession(ccSession)!.run, run);
  assert.equal(reg.list().length, 1);
});

test('ActiveRunRegistry — auto-unregisters on terminal event', () => {
  const reg = new ActiveRunRegistry();
  const runId = newId() as ULID;
  const ccSession = `cc-${runId}`;
  const run = new FakeAgentRun({ agentRunId: runId, ccSessionId: ccSession });
  reg.register({
    run: run as never,
    projectId,
    dispatcherSessionId: 'orch-sess',
    ccSessionId: ccSession,
    podName: 'researcher',
    podRevisionAtDispatch: null,
  });
  assert.ok(reg.get(runId));

  run.fireTerminal('completed');
  assert.equal(reg.get(runId), null);
  assert.equal(reg.getByCcSession(ccSession), null);
});
