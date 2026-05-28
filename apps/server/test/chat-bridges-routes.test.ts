import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Hono } from 'hono';
import { relative, resolve } from 'node:path';
import type { ULID } from '@pc/domain';

import {
  createPendingAskStore,
  registerChatBridgeRoutes,
  type ChannelSendInput,
  type ChannelSendResult,
} from '../src/features/chat-bridges/routes.ts';

async function json<T>(res: Response): Promise<T> {
  return await res.json() as T;
}

function makeHarness(opts: {
  transcriptRoot?: string;
  transcriptFiles?: Map<string, string>;
  readError?: Error;
  channelResult?: ChannelSendResult;
  channelError?: Error;
} = {}) {
  const broadcasts: Array<{ projectId: ULID; msg: unknown }> = [];
  const scheduledTimeouts: Array<{ callback: () => void; delayMs: number }> = [];
  const channelSends: ChannelSendInput[] = [];
  const pendingAsks = createPendingAskStore();
  const app = new Hono();
  registerChatBridgeRoutes(app, {
    broadcastTo: (projectId, msg) => broadcasts.push({ projectId, msg }),
    pendingAsks,
    resolveProject: (projectId) =>
      projectId === 'project-1' ? { project: { slug: 'Project Slug' } } : null,
    channelPort: 8788,
    askTimeoutMs: 123,
    scheduleAskTimeout: (callback, delayMs) => {
      scheduledTimeouts.push({ callback, delayMs });
    },
    claudeProjectsDir: opts.transcriptRoot ?? resolve(process.cwd(), 'claude-projects'),
    fileExists: (path) => opts.transcriptFiles?.has(path) ?? false,
    readFileText: async (path) => {
      if (opts.readError) throw opts.readError;
      return opts.transcriptFiles?.get(path) ?? '';
    },
    sendChannelMessage: async (input) => {
      channelSends.push(input);
      if (opts.channelError) throw opts.channelError;
      return opts.channelResult ?? { status: 200, body: 'sent' };
    },
  });
  return { app, broadcasts, scheduledTimeouts, pendingAsks, channelSends };
}

async function waitForRouteSetup(): Promise<void> {
  await new Promise((resolveReady) => setTimeout(resolveReady, 0));
}

test('ask route preserves no-project, broadcast, answer, and timeout envelopes', async () => {
  const harness = makeHarness();

  let res = await harness.app.request('/api/ask', {
    method: 'POST',
    body: JSON.stringify({ toolName: 'AskUserQuestion', toolUseId: 'ask-0', toolInput: {} }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { answer: '(no projectId on ask payload)' });
  assert.deepEqual(harness.broadcasts, []);

  const pendingAnswer = harness.app.request('/api/ask', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-1',
      sessionId: 'session-1',
      toolName: 'AskUserQuestion',
      toolUseId: 'ask-1',
      toolInput: { question: 'Continue?' },
    }),
    headers: { 'content-type': 'application/json' },
  });
  await waitForRouteSetup();
  assert.deepEqual(harness.broadcasts, [
    {
      projectId: 'project-1' as ULID,
      msg: {
        type: 'ask',
        sessionId: 'session-1',
        toolName: 'AskUserQuestion',
        toolUseId: 'ask-1',
        toolInput: { question: 'Continue?' },
      },
    },
  ]);
  assert.equal(harness.scheduledTimeouts[0]?.delayMs, 123);
  assert.equal(harness.pendingAsks.resolve('ask-1', 'approved'), true);
  res = await pendingAnswer;
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { answer: 'approved' });

  const pendingTimeout = harness.app.request('/api/ask', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-1',
      toolName: 'ExitPlanMode',
      toolUseId: 'ask-2',
      toolInput: {},
    }),
    headers: { 'content-type': 'application/json' },
  });
  await waitForRouteSetup();
  harness.scheduledTimeouts[1]?.callback();
  res = await pendingTimeout;
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { answer: '(timeout — no user response)' });
  assert.equal(harness.pendingAsks.resolve('ask-2', 'late'), false);
});

test('subagent transcript route preserves path validation and JSONL parsing envelopes', async () => {
  const root = resolve(process.cwd(), 'claude-projects');
  const transcriptPath = resolve(root, 'project-1', 'session.jsonl');
  const missingPath = resolve(root, 'project-1', 'missing.jsonl');
  const outsidePath = resolve(process.cwd(), 'outside.jsonl');
  const harness = makeHarness({
    transcriptRoot: root,
    transcriptFiles: new Map([
      [transcriptPath, '{"kind":"one"}\nnot-json\n{"kind":"two"}\n\n'],
    ]),
  });

  let res = await harness.app.request('/api/subagent-transcript');
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), {
    ok: false,
    error: 'absolute path query param required',
  });

  res = await harness.app.request(
    `/api/subagent-transcript?path=${encodeURIComponent(outsidePath)}`,
  );
  assert.equal(res.status, 403);
  assert.deepEqual(await json(res), {
    ok: false,
    error: 'path must live under ~/.claude/projects/',
  });

  res = await harness.app.request(
    `/api/subagent-transcript?path=${encodeURIComponent(missingPath)}`,
  );
  assert.equal(res.status, 404);
  assert.deepEqual(await json(res), { ok: false, error: 'transcript not found' });

  res = await harness.app.request(
    `/api/subagent-transcript?path=${encodeURIComponent(transcriptPath)}`,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), {
    ok: true,
    path: transcriptPath,
    relPath: relative(root, transcriptPath),
    events: [{ kind: 'one' }, { kind: 'two' }],
  });
});

test('subagent transcript route maps read failures to legacy 500 envelope', async () => {
  const root = resolve(process.cwd(), 'claude-projects');
  const transcriptPath = resolve(root, 'project-1', 'session.jsonl');
  const harness = makeHarness({
    transcriptRoot: root,
    transcriptFiles: new Map([[transcriptPath, '']]),
    readError: new Error('disk read failed'),
  });

  const res = await harness.app.request(
    `/api/subagent-transcript?path=${encodeURIComponent(transcriptPath)}`,
  );
  assert.equal(res.status, 500);
  assert.deepEqual(await json(res), { ok: false, error: 'disk read failed' });
});

test('channel-send route preserves validation, service delegation, and error envelopes', async () => {
  let harness = makeHarness({ channelResult: { status: 202, body: 'queued' } });

  let res = await harness.app.request('/api/projects/missing/channel-send', {
    method: 'POST',
    body: JSON.stringify({ message: 'hello' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await json(res), { ok: false, error: 'unknown project: missing' });

  res = await harness.app.request('/api/projects/project-1/channel-send', {
    method: 'POST',
    body: JSON.stringify({ message: '' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), { ok: false, error: 'empty message' });

  res = await harness.app.request('/api/projects/project-1/channel-send', {
    method: 'POST',
    body: JSON.stringify({ message: 'hello channel' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: false, status: 202, body: 'queued' });
  assert.deepEqual(harness.channelSends, [
    { port: 8788, slug: 'Project Slug', message: 'hello channel' },
  ]);

  harness = makeHarness({ channelError: new Error('connect ECONNREFUSED') });
  res = await harness.app.request('/api/projects/project-1/channel-send', {
    method: 'POST',
    body: JSON.stringify({ message: 'hello channel' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 503);
  assert.deepEqual(await json(res), { ok: false, error: 'connect ECONNREFUSED' });
});
