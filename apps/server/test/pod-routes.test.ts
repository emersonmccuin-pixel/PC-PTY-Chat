// Section 17d.1 — Pod HTTP routes unit tests.
//
// Mirrors the workflow-lifecycle.test pattern: spin up a fresh Hono app, call
// registerPodRoutes() against it, exercise endpoints via app.fetch(new
// Request(...)). The route handlers under test are the same module the real
// server imports, so the test exercises real production code.
//
// Run via:  pnpm --filter @pc/server test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDataDir = mkdtempSync(join(tmpdir(), 'pc-pod-routes-db-'));
process.env.PC_DATA_DIR = tmpDataDir;

const { closeDb, runMigrations } = await import('@pc/db');
const { Hono } = await import('hono');
const { registerPodRoutes } = await import('../src/routes/pod-routes.ts');

interface BroadcastedEnvelope {
  type: string;
  change?: string;
  pod?: { id: string; name: string };
  podId?: string;
  name?: string;
}

interface ChangedHookCall {
  name: string;
  change: string;
}

function freshApp() {
  const broadcasts: BroadcastedEnvelope[] = [];
  const changedHookCalls: ChangedHookCall[] = [];
  const app = new Hono();
  registerPodRoutes(app, {
    broadcastAll: (msg) => {
      broadcasts.push(msg as BroadcastedEnvelope);
    },
    onPodChanged: (name, change) => {
      changedHookCalls.push({ name, change });
    },
  });
  return { app, broadcasts, changedHookCalls };
}

async function fetchJson(
  app: InstanceType<typeof Hono>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const init: RequestInit =
    body !== undefined
      ? {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : { method };
  const res = await app.fetch(new Request(`http://test${path}`, init));
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  return { status: res.status, data };
}

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

// --- agent CRUD -------------------------------------------------------------

test('POST /api/agents/pods creates a global pod + broadcasts + fires onPodChanged', async () => {
  const { app, broadcasts, changedHookCalls } = freshApp();
  const { status, data } = await fetchJson(app, 'POST', '/api/agents/pods', {
    name: 'pod-route-test-1',
    description: 'A test pod.',
    prompt: 'You are a test pod.',
    model: 'opus',
    effort: 'high',
    maxTurns: 12,
    tools: ['Read', 'Glob'],
  });
  assert.equal(status, 201);
  assert.equal(data.ok, true);
  const pod = data.pod as Record<string, unknown>;
  assert.equal(pod.name, 'pod-route-test-1');
  assert.equal(pod.scope, 'global');
  assert.equal(pod.projectId, null);
  assert.equal(pod.model, 'opus');
  assert.deepEqual(pod.tools, ['Read', 'Glob']);

  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0]?.type, 'pod-changed');
  assert.equal(broadcasts[0]?.change, 'created');

  assert.equal(changedHookCalls.length, 1);
  assert.deepEqual(changedHookCalls[0], { name: 'pod-route-test-1', change: 'created' });
});

test('POST /api/agents/pods rejects scope="project"', async () => {
  const { app } = freshApp();
  const { status, data } = await fetchJson(app, 'POST', '/api/agents/pods', {
    name: 'should-not-land',
    scope: 'project',
    prompt: 'nope',
  });
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

test('POST /api/agents/pods rejects missing name', async () => {
  const { app } = freshApp();
  const { status } = await fetchJson(app, 'POST', '/api/agents/pods', {
    prompt: 'no name',
  });
  assert.equal(status, 400);
});

test('GET /api/agents/pods lists live pods', async () => {
  const { app } = freshApp();
  await fetchJson(app, 'POST', '/api/agents/pods', { name: 'list-test-a', prompt: 'a' });
  await fetchJson(app, 'POST', '/api/agents/pods', { name: 'list-test-b', prompt: 'b' });

  const { status, data } = await fetchJson(app, 'GET', '/api/agents/pods');
  assert.equal(status, 200);
  const pods = data.pods as Array<{ name: string }>;
  const names = pods.map((p) => p.name);
  assert.ok(names.includes('list-test-a'));
  assert.ok(names.includes('list-test-b'));
});

test('GET /api/agents/pods/:id returns the bundle (agent + knowledge + secrets-no-value + mcp)', async () => {
  const { app } = freshApp();
  const create = await fetchJson(app, 'POST', '/api/agents/pods', {
    name: 'bundle-test',
    prompt: 'bundle me',
  });
  const id = (create.data.pod as { id: string }).id;
  await fetchJson(app, 'POST', `/api/agents/pods/${id}/knowledge`, {
    name: 'note',
    content: 'remember this',
  });
  await fetchJson(app, 'POST', `/api/agents/pods/${id}/secrets`, {
    envVarName: 'TEST_KEY',
    valuePlaintext: 'topsecret',
  });
  await fetchJson(app, 'POST', `/api/agents/pods/${id}/mcp-servers`, {
    name: 'gmail',
    config: { command: 'node', args: ['/path/to/gmail.mjs'] },
  });

  const { status, data } = await fetchJson(app, 'GET', `/api/agents/pods/${id}`);
  assert.equal(status, 200);
  assert.equal((data.agent as { id: string }).id, id);

  const knowledge = data.knowledge as Array<{ name: string; content: string }>;
  assert.equal(knowledge.length, 1);
  assert.equal(knowledge[0]?.name, 'note');

  const secrets = data.secrets as Array<Record<string, unknown>>;
  assert.equal(secrets.length, 1);
  assert.equal(secrets[0]?.envVarName, 'TEST_KEY');
  // Critical: value MUST NOT come back over the wire.
  assert.ok(!('valuePlaintext' in (secrets[0] ?? {})));

  const mcp = data.mcpServers as Array<{ name: string; config: Record<string, unknown> }>;
  assert.equal(mcp.length, 1);
  assert.equal(mcp[0]?.name, 'gmail');
  assert.equal(mcp[0]?.config?.command, 'node');
});

test('GET /api/agents/pods/:id 404 on unknown id', async () => {
  const { app } = freshApp();
  const { status, data } = await fetchJson(app, 'GET', '/api/agents/pods/01NOTAREALID0000000000000');
  assert.equal(status, 404);
  assert.equal(data.ok, false);
});

test('PATCH /api/agents/pods/:id updates fields + audits change', async () => {
  const { app, broadcasts, changedHookCalls } = freshApp();
  const create = await fetchJson(app, 'POST', '/api/agents/pods', {
    name: 'patch-test',
    prompt: 'v1',
  });
  const id = (create.data.pod as { id: string }).id;
  broadcasts.length = 0;
  changedHookCalls.length = 0;

  const { status, data } = await fetchJson(app, 'PATCH', `/api/agents/pods/${id}`, {
    prompt: 'v2 updated',
    description: 'now described',
  });
  assert.equal(status, 200);
  const pod = data.pod as { prompt: string; description: string };
  assert.equal(pod.prompt, 'v2 updated');
  assert.equal(pod.description, 'now described');

  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0]?.change, 'updated');
  assert.equal(changedHookCalls[0]?.change, 'updated');

  // Confirm audit log records the change.
  const audit = await fetchJson(app, 'GET', `/api/agents/pods/${id}/audit`);
  assert.equal(audit.status, 200);
  const rows = audit.data.rows as Array<{ field: string }>;
  // newest first: should include prompt + description edits (2 rows) + the original 'created' row
  const fields = rows.map((r) => r.field);
  assert.ok(fields.includes('prompt'));
  assert.ok(fields.includes('description'));
  assert.ok(fields.includes('created'));
});

test('PATCH /api/agents/pods/:id rejects empty name', async () => {
  const { app } = freshApp();
  const create = await fetchJson(app, 'POST', '/api/agents/pods', { name: 'rename-test' });
  const id = (create.data.pod as { id: string }).id;
  const { status } = await fetchJson(app, 'PATCH', `/api/agents/pods/${id}`, { name: '   ' });
  assert.equal(status, 400);
});

test('DELETE /api/agents/pods/:id soft-deletes a regular pod', async () => {
  const { app, broadcasts, changedHookCalls } = freshApp();
  const create = await fetchJson(app, 'POST', '/api/agents/pods', { name: 'delete-test' });
  const id = (create.data.pod as { id: string }).id;
  broadcasts.length = 0;
  changedHookCalls.length = 0;

  const { status, data } = await fetchJson(app, 'DELETE', `/api/agents/pods/${id}`);
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(broadcasts[0]?.change, 'deleted');
  assert.equal(changedHookCalls[0]?.change, 'deleted');

  // GET should now 404.
  const after = await fetchJson(app, 'GET', `/api/agents/pods/${id}`);
  assert.equal(after.status, 404);
});

test('DELETE /api/agents/pods/:id refuses stock specialist names', async () => {
  const { app } = freshApp();
  for (const stock of ['orchestrator', 'researcher', 'writer', 'reviewer', 'planner', 'extractor']) {
    const create = await fetchJson(app, 'POST', '/api/agents/pods', { name: stock });
    const id = (create.data.pod as { id: string }).id;
    const { status, data } = await fetchJson(app, 'DELETE', `/api/agents/pods/${id}`);
    assert.equal(status, 409, `expected 409 for stock pod ${stock}`);
    assert.equal(data.kind, 'stock-specialist');
  }
});

// --- knowledge --------------------------------------------------------------

test('knowledge CRUD round-trip', async () => {
  const { app } = freshApp();
  const create = await fetchJson(app, 'POST', '/api/agents/pods', { name: 'knowledge-test' });
  const id = (create.data.pod as { id: string }).id;

  const k1 = await fetchJson(app, 'POST', `/api/agents/pods/${id}/knowledge`, {
    name: 'doc-1',
    content: 'first version',
  });
  assert.equal(k1.status, 201);
  const kId = (k1.data.knowledge as { id: string }).id;

  const k2 = await fetchJson(app, 'PATCH', `/api/agents/pods/${id}/knowledge/${kId}`, {
    content: 'second version',
  });
  assert.equal(k2.status, 200);
  assert.equal((k2.data.knowledge as { content: string }).content, 'second version');

  const k3 = await fetchJson(app, 'DELETE', `/api/agents/pods/${id}/knowledge/${kId}`);
  assert.equal(k3.status, 200);

  const bundle = await fetchJson(app, 'GET', `/api/agents/pods/${id}`);
  assert.equal((bundle.data.knowledge as unknown[]).length, 0);
});

test('knowledge PATCH 404 when knowledgeId doesn\'t belong to the pod', async () => {
  const { app } = freshApp();
  const create = await fetchJson(app, 'POST', '/api/agents/pods', { name: 'k-404' });
  const id = (create.data.pod as { id: string }).id;
  const { status } = await fetchJson(
    app,
    'PATCH',
    `/api/agents/pods/${id}/knowledge/01NOTAREALKNOWLEDGE000000`,
    { content: 'nope' },
  );
  assert.equal(status, 404);
});

// --- secrets ---------------------------------------------------------------

test('secrets add + delete; never readback', async () => {
  const { app } = freshApp();
  const create = await fetchJson(app, 'POST', '/api/agents/pods', { name: 'secrets-test' });
  const id = (create.data.pod as { id: string }).id;

  const s1 = await fetchJson(app, 'POST', `/api/agents/pods/${id}/secrets`, {
    envVarName: 'OPENAI_API_KEY',
    valuePlaintext: 'sk-abc',
  });
  assert.equal(s1.status, 201);
  const secret = s1.data.secret as Record<string, unknown>;
  assert.equal(secret.envVarName, 'OPENAI_API_KEY');
  assert.ok(!('valuePlaintext' in secret), 'POST response must not echo the value');

  const sId = secret.id as string;
  const s2 = await fetchJson(app, 'DELETE', `/api/agents/pods/${id}/secrets/${sId}`);
  assert.equal(s2.status, 200);

  const bundle = await fetchJson(app, 'GET', `/api/agents/pods/${id}`);
  assert.equal((bundle.data.secrets as unknown[]).length, 0);
});

test('secrets POST rejects missing envVarName', async () => {
  const { app } = freshApp();
  const create = await fetchJson(app, 'POST', '/api/agents/pods', { name: 'secrets-missing' });
  const id = (create.data.pod as { id: string }).id;
  const { status } = await fetchJson(app, 'POST', `/api/agents/pods/${id}/secrets`, {
    valuePlaintext: 'forgot the name',
  });
  assert.equal(status, 400);
});

// --- mcp servers -----------------------------------------------------------

test('mcp servers add + delete + invalid config rejected', async () => {
  const { app } = freshApp();
  const create = await fetchJson(app, 'POST', '/api/agents/pods', { name: 'mcp-test' });
  const id = (create.data.pod as { id: string }).id;

  const bad = await fetchJson(app, 'POST', `/api/agents/pods/${id}/mcp-servers`, {
    name: 'broken',
    config: { command: 123 },
  });
  assert.equal(bad.status, 400);

  const good = await fetchJson(app, 'POST', `/api/agents/pods/${id}/mcp-servers`, {
    name: 'jira',
    config: { command: 'node', args: ['/path/to/jira.mjs'], env: { JIRA_TOKEN: 'x' } },
  });
  assert.equal(good.status, 201);
  const mcpId = (good.data.mcpServer as { id: string }).id;

  const del = await fetchJson(app, 'DELETE', `/api/agents/pods/${id}/mcp-servers/${mcpId}`);
  assert.equal(del.status, 200);
});

// --- audit listing ---------------------------------------------------------

test('audit listing supports actor + field + limit filters', async () => {
  const { app } = freshApp();
  const create = await fetchJson(app, 'POST', '/api/agents/pods', {
    name: 'audit-filter',
    prompt: 'v1',
  });
  const id = (create.data.pod as { id: string }).id;
  await fetchJson(app, 'PATCH', `/api/agents/pods/${id}`, { prompt: 'v2' });
  await fetchJson(app, 'PATCH', `/api/agents/pods/${id}`, { description: 'desc' });

  const all = await fetchJson(app, 'GET', `/api/agents/pods/${id}/audit`);
  assert.equal(all.status, 200);
  assert.ok((all.data.rows as unknown[]).length >= 3); // created + 2 patches

  const onlyPrompt = await fetchJson(app, 'GET', `/api/agents/pods/${id}/audit?field=prompt`);
  const promptRows = onlyPrompt.data.rows as Array<{ field: string }>;
  assert.ok(promptRows.length >= 1);
  assert.ok(promptRows.every((r) => r.field === 'prompt'));

  const limited = await fetchJson(app, 'GET', `/api/agents/pods/${id}/audit?limit=1`);
  assert.equal((limited.data.rows as unknown[]).length, 1);
});

test('audit listing rejects invalid filter values', async () => {
  const { app } = freshApp();
  const create = await fetchJson(app, 'POST', '/api/agents/pods', { name: 'audit-bad-filter' });
  const id = (create.data.pod as { id: string }).id;

  const badActor = await fetchJson(app, 'GET', `/api/agents/pods/${id}/audit?actor=banana`);
  assert.equal(badActor.status, 400);

  const badField = await fetchJson(app, 'GET', `/api/agents/pods/${id}/audit?field=banana`);
  assert.equal(badField.status, 400);
});
