import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Hono } from 'hono';
import type { Project, Stage, ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-agent-run-routes-'));
process.env.PC_DATA_DIR = tmpDir;
process.env.CLAUDE_CONFIG_DIR = join(tmpDir, 'claude-config');

const {
  closeDb,
  createProject: dbCreateProject,
  insertAgentRunRow,
  markAgentRunTerminal,
  newId,
  runMigrations,
} = await import('@pc/db');
const { jsonlPathFor } = await import('@pc/runtime');
const { registerAgentRunRoutes } = await import('../src/features/agent-runs/routes.ts');

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];
let seq = 0;

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeProject(label: string): Project {
  seq += 1;
  const folderPath = join(tmpDir, `project-${label}-${seq}`);
  mkdirSync(folderPath, { recursive: true });
  return dbCreateProject({
    slug: `agent-run-routes-${label}-${Date.now().toString(36)}-${seq}`,
    name: `Agent Run Routes ${label}`,
    stages,
    folderPath,
  });
}

function makeRun(projectId: ULID, patch: Partial<{
  id: ULID;
  podName: string;
  dispatcherSessionId: string;
  ccSessionId: string;
  status: 'queued' | 'spawning' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  input: string | null;
  parentWorkItemId: ULID | null;
  continues: ULID | null;
  queuedAt: number;
}> = {}) {
  return insertAgentRunRow({
    id: patch.id ?? newId(),
    projectId,
    podName: patch.podName ?? 'researcher',
    dispatcherSessionId: patch.dispatcherSessionId ?? 'orch-session',
    ccSessionId: patch.ccSessionId ?? `cc-${newId()}`,
    status: patch.status ?? 'running',
    input: patch.input ?? 'input',
    ...(patch.parentWorkItemId !== undefined ? { parentWorkItemId: patch.parentWorkItemId } : {}),
    ...(patch.continues !== undefined ? { continues: patch.continues } : {}),
    queuedAt: patch.queuedAt ?? Date.now(),
  });
}

async function json<T>(res: Response): Promise<T> {
  return await res.json() as T;
}

test('agent-run active list and cancel routes preserve envelopes', async () => {
  const project = makeProject('active');
  const running = makeRun(project.id, {
    podName: 'researcher',
    status: 'running',
    queuedAt: 100,
    ccSessionId: 'cc-running',
  });
  const paused = makeRun(project.id, {
    podName: 'writer',
    status: 'paused',
    queuedAt: 200,
    ccSessionId: 'cc-paused',
  });
  const terminal = makeRun(project.id, {
    podName: 'planner',
    status: 'running',
    queuedAt: 300,
  });
  markAgentRunTerminal({
    id: terminal.id,
    status: 'completed',
    result: 'done',
    failureCause: null,
    failureReason: null,
    completedAt: 400,
  });

  let cancelled = false;
  const app = new Hono();
  registerAgentRunRoutes(app, {
    channelServer: {} as never,
    broadcastTo: () => {},
    getActiveRunRegistry: () => ({
      get: (runId) =>
        runId === running.id
          ? { projectId: project.id, run: { cancel: () => { cancelled = true; } } }
          : null,
    }),
  });

  let res = await app.request(`/api/projects/${project.id}/agent-runs`);
  assert.equal(res.status, 200);
  const body = await json<{
    ok: boolean;
    runs: Array<{
      runId: ULID;
      sessionId: string;
      agentName: string;
      model: string;
      worktreeDir: string;
      status: string;
      result: string;
    }>;
  }>(res);
  assert.equal(body.ok, true);
  assert.deepEqual(body.runs.map((run) => run.runId), [paused.id, running.id]);
  assert.equal(body.runs[0].sessionId, 'cc-paused');
  assert.equal(body.runs[0].model, 'opus');
  assert.equal(body.runs[0].worktreeDir, project.folderPath);
  assert.equal(body.runs[0].result, '');

  res = await app.request(`/api/projects/${project.id}/agent-runs/${running.id}/cancel`, {
    method: 'POST',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, status: 'cancelled' });
  assert.equal(cancelled, true);

  const missingRunId = newId();
  res = await app.request(`/api/projects/${project.id}/agent-runs/${missingRunId}/cancel`, {
    method: 'POST',
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await json(res), {
    ok: false,
    error: `unknown run: ${missingRunId}`,
  });
});

test('agent-run events route backfills canonical JSONL events', async () => {
  const project = makeProject('events');
  const run = makeRun(project.id, {
    status: 'running',
    ccSessionId: 'cc-events',
  });
  const jsonlPath = jsonlPathFor(project.folderPath, 'cc-events');
  mkdirSync(dirname(jsonlPath), { recursive: true });
  writeFileSync(
    jsonlPath,
    [
      JSON.stringify({ type: 'user', message: { content: 'research this' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 3, output_tokens: 2 },
          model: 'claude-test',
        },
      }),
      'not-json',
      '',
    ].join('\n'),
  );

  const app = new Hono();
  registerAgentRunRoutes(app, {
    channelServer: {} as never,
    broadcastTo: () => {},
  });

  const res = await app.request(`/api/projects/${project.id}/agent-runs/${run.id}/events`);
  assert.equal(res.status, 200);
  const body = await json<{
    ok: boolean;
    runId: ULID;
    status: string;
    jsonlPath: string;
    transcriptStatus: string;
    events: Array<{ kind: string; text?: string; model?: string | null }>;
  }>(res);
  assert.equal(body.ok, true);
  assert.equal(body.runId, run.id);
  assert.equal(body.status, 'running');
  assert.equal(body.jsonlPath, jsonlPath);
  assert.equal(body.transcriptStatus, 'ready');
  assert.deepEqual(body.events.map((event) => event.kind), [
    'jsonl-user',
    'jsonl-usage',
    'jsonl-turn-end',
  ]);
  assert.equal(body.events[0]?.text, 'research this');
  assert.equal(body.events[1]?.model, 'claude-test');
  assert.equal(body.events[2]?.text, 'done');
});

test('agent-run events route distinguishes missing and empty provider transcripts', async () => {
  const project = makeProject('events-missing');
  const missingRun = makeRun(project.id, {
    status: 'running',
    ccSessionId: 'cc-events-missing',
  });
  const emptyRun = makeRun(project.id, {
    status: 'running',
    ccSessionId: 'cc-events-empty',
  });
  const emptyJsonlPath = jsonlPathFor(project.folderPath, 'cc-events-empty');
  mkdirSync(dirname(emptyJsonlPath), { recursive: true });
  writeFileSync(emptyJsonlPath, '');

  const app = new Hono();
  registerAgentRunRoutes(app, {
    channelServer: {} as never,
    broadcastTo: () => {},
  });

  let res = await app.request(`/api/projects/${project.id}/agent-runs/${missingRun.id}/events`);
  assert.equal(res.status, 200);
  let body = await json<{
    ok: boolean;
    jsonlPath: string;
    transcriptStatus: string;
    events: unknown[];
  }>(res);
  assert.equal(body.ok, true);
  assert.equal(body.transcriptStatus, 'missing');
  assert.deepEqual(body.events, []);

  res = await app.request(`/api/projects/${project.id}/agent-runs/${emptyRun.id}/events`);
  assert.equal(res.status, 200);
  body = await json<{
    ok: boolean;
    jsonlPath: string;
    transcriptStatus: string;
    events: unknown[];
  }>(res);
  assert.equal(body.ok, true);
  assert.equal(body.jsonlPath, emptyJsonlPath);
  assert.equal(body.transcriptStatus, 'empty');
  assert.deepEqual(body.events, []);
});

test('invoke route validates inputs, delegates dispatch, audits, and returns async envelope', async () => {
  const project = makeProject('invoke');
  const dispatched: unknown[] = [];
  const audits: unknown[] = [];
  const app = new Hono();
  registerAgentRunRoutes(app, {
    channelServer: {} as never,
    broadcastTo: () => {},
    now: () => 12345,
    dispatchFreshAgent: ((input: {
      agentName: string;
    }) => {
      dispatched.push(input);
      return {
        ok: true,
        agentRunId: 'run-invoke' as ULID,
        ccSessionId: 'cc-invoke',
        podName: input.agentName,
        initialState: 'queued',
        startedAt: 111,
      };
    }) as never,
    recordAgentInvoke: ((input: unknown) => {
      audits.push(input);
    }) as never,
  });

  let res = await app.request(`/api/projects/${project.id}/agents/researcher/invoke`, {
    method: 'POST',
    body: JSON.stringify({ input: 'hello' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), {
    ok: false,
    error: 'dispatcherSessionId required (orchestrator must forward PC_SESSION_ID)',
  });

  res = await app.request(`/api/projects/${project.id}/agents/researcher/invoke`, {
    method: 'POST',
    body: JSON.stringify({
      input: ' do research ',
      dispatcherSessionId: ' orch-1 ',
      parentInvokeDepth: 0,
      parentWorkItemId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      workItemId: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
    }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), {
    ok: true,
    mode: 'async',
    sessionId: 'cc-invoke',
    runId: 'run-invoke',
    agentName: 'researcher',
    startedAt: 111,
    status: 'queued',
  });
  assert.deepEqual(dispatched, [
    {
      projectId: project.id,
      worktreeDir: project.folderPath,
      agentName: 'researcher',
      input: ' do research ',
      dispatcherSessionId: 'orch-1',
      parentWorkItemId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      workItemId: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
      invokeDepth: 1,
      slug: project.slug,
    },
  ]);
  assert.deepEqual(audits, [
    {
      workItemId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      agentName: 'researcher',
      sessionId: 'cc-invoke',
      runId: 'run-invoke',
      mode: 'async',
      input: ' do research ',
      now: 12345,
    },
  ]);
});

test('continue route enforces ownership, delegates dispatch, and list-by-dispatcher summarizes rows', async () => {
  const project = makeProject('continue');
  const parent = makeRun(project.id, {
    status: 'completed',
    dispatcherSessionId: 'orch-owner',
    input: 'parent',
    queuedAt: 100,
  });
  const longInput = 'x'.repeat(90);
  const listed = makeRun(project.id, {
    podName: 'writer',
    status: 'running',
    dispatcherSessionId: 'orch-owner',
    input: longInput,
    queuedAt: 300,
  });
  makeRun(project.id, {
    podName: 'planner',
    status: 'completed',
    dispatcherSessionId: 'orch-owner',
    input: 'short',
    queuedAt: 200,
  });

  const continuations: unknown[] = [];
  const audits: unknown[] = [];
  const app = new Hono();
  registerAgentRunRoutes(app, {
    channelServer: {} as never,
    broadcastTo: () => {},
    now: () => 67890,
    dispatchContinueAgent: ((input: unknown) => {
      continuations.push(input);
      return {
        ok: true,
        agentRunId: 'run-continue' as ULID,
        ccSessionId: 'cc-continue',
        podName: 'researcher',
        initialState: 'spawning',
        startedAt: 222,
      };
    }) as never,
    recordAgentInvoke: ((input: unknown) => {
      audits.push(input);
    }) as never,
  });

  let res = await app.request(`/api/projects/${project.id}/agent-runs/${parent.id}/continue`, {
    method: 'POST',
    body: JSON.stringify({ input: 'follow up', dispatcherSessionId: 'wrong-owner' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 403);
  assert.deepEqual(await json(res), {
    ok: false,
    error: `run ${parent.id} was dispatched by a different orchestrator session — only the dispatcher can continue it`,
    cause: 'ownership-mismatch',
  });

  res = await app.request(`/api/projects/${project.id}/agent-runs/${parent.id}/continue`, {
    method: 'POST',
    body: JSON.stringify({ input: 'follow up', dispatcherSessionId: 'orch-owner' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), {
    ok: true,
    mode: 'async',
    sessionId: 'cc-continue',
    runId: 'run-continue',
    agentName: 'researcher',
    startedAt: 222,
    status: 'spawning',
    continues: parent.id,
  });
  assert.deepEqual(continuations, [
    {
      projectId: project.id,
      worktreeDir: project.folderPath,
      parentAgentRunId: parent.id,
      input: 'follow up',
      dispatcherSessionId: 'orch-owner',
      workItemId: null,
      slug: project.slug,
    },
  ]);
  assert.equal((audits[0] as { runId: string }).runId, 'run-continue');

  res = await app.request(`/api/projects/${project.id}/agent-runs/by-dispatcher`);
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), {
    ok: false,
    error: 'dispatcherSessionId query param required',
  });

  res = await app.request(
    `/api/projects/${project.id}/agent-runs/by-dispatcher?dispatcherSessionId=orch-owner&status=running&limit=1`,
  );
  assert.equal(res.status, 200);
  const listBody = await json<{
    ok: boolean;
    runs: Array<{ runId: ULID; agentName: string; status: string; summary: string }>;
  }>(res);
  assert.deepEqual(listBody, {
    ok: true,
    runs: [
      {
        runId: listed.id,
        agentName: 'writer',
        status: 'running',
        dispatchedAt: 300,
        completedAt: null,
        summary: `${'x'.repeat(80)}…`,
        continues: null,
      },
    ],
  });
});

test('pending ask routes preserve validation, status mapping, and success envelopes', async () => {
  const project = makeProject('pending');
  const app = new Hono();
  const pauses: unknown[] = [];
  registerAgentRunRoutes(app, {
    channelServer: {} as never,
    broadcastTo: () => {},
    recordExplicitPause: ((input: unknown, deps: { slug: string }) => {
      pauses.push({ input, slug: deps.slug });
      return {
        ok: true,
        pendingAskId: 'ask-created' as ULID,
        eventDelivered: false,
        eventInboxId: null,
      };
    }) as never,
    answerPendingAsk: ((input: unknown) => ({
      ok: true,
      agentRunId: 'run-answered' as ULID,
      ccSessionId: 'cc-answered',
      podRevisionDrifted: true,
      podRevisionAtDispatch: '1',
      podRevisionAtResume: '2',
      input,
    })) as never,
    cancelPendingAsk: ((input: { pendingAskId: string }) =>
      input.pendingAskId === 'missing'
        ? { ok: false, error: 'no pending-ask with id missing', cause: 'unknown-pending-ask' }
        : { ok: true, agentRunId: 'run-cancelled' as ULID }) as never,
  });

  let res = await app.request(`/api/projects/${project.id}/agent-pending-asks`, {
    method: 'POST',
    body: JSON.stringify({
      agentRunId: 'run-1',
      kind: 'approval',
      promptBody: 'approve?',
    }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), {
    ok: false,
    error: 'options required (non-empty array) for kind=approval',
  });

  res = await app.request(`/api/projects/${project.id}/agent-pending-asks`, {
    method: 'POST',
    body: JSON.stringify({
      agentRunId: 'run-1',
      kind: 'user',
      promptBody: 'What now?',
      context: 'ctx',
    }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), {
    ok: true,
    pendingAskId: 'ask-created',
    status: 'waiting',
    eventDelivered: false,
  });
  assert.deepEqual(pauses, [
    {
      input: {
        agentRunId: 'run-1',
        kind: 'user',
        promptBody: 'What now?',
        context: 'ctx',
        options: null,
      },
      slug: project.slug,
    },
  ]);

  res = await app.request(`/api/projects/${project.id}/agent-pending-asks/ask-1/answer`, {
    method: 'POST',
    body: JSON.stringify({ answer: 'yes', answeredBy: 'user' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), {
    ok: true,
    agentRunId: 'run-answered',
    ccSessionId: 'cc-answered',
    podRevisionDrifted: true,
    podRevisionAtDispatch: '1',
    podRevisionAtResume: '2',
  });

  res = await app.request(`/api/projects/${project.id}/agent-pending-asks/missing/cancel`, {
    method: 'POST',
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await json(res), {
    ok: false,
    error: 'no pending-ask with id missing',
    cause: 'unknown-pending-ask',
  });

  res = await app.request(`/api/projects/${project.id}/agent-pending-asks/ask-2/cancel`, {
    method: 'POST',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, agentRunId: 'run-cancelled' });
});
