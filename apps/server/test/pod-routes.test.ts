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

const { closeDb, createAgent, listAgentAudit, runMigrations, softDeleteAgent } = await import(
  '@pc/db'
);
const { Hono } = await import('hono');
const { registerPodRoutes } = await import('../src/routes/pod-routes.ts');
const { mergeRequiredAgentTools } = await import('@pc/domain');

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

interface ResetStub {
  calls: { name: string; reason: string }[];
  result: { agent: { id: string; name: string; prompt: string } | null; resetFields: string[] };
}

function freshApp(opts?: { resetStub?: ResetStub }) {
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
    resetStockPodToDefault: opts?.resetStub
      ? (name, reason) => {
          opts.resetStub!.calls.push({ name, reason });
          return opts.resetStub!.result as never;
        }
      : undefined,
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
  // Section 26: createAgent always merges in the required work-item tools.
  assert.deepEqual(pod.tools, mergeRequiredAgentTools(['Read', 'Glob']));

  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0]?.type, 'pod-changed');
  assert.equal(broadcasts[0]?.change, 'created');

  assert.equal(changedHookCalls.length, 1);
  assert.deepEqual(changedHookCalls[0], { name: 'pod-route-test-1', change: 'created' });
});

test('POST /api/agents/pods creates a project-scoped pod when scope="project" + projectId', async () => {
  const { app, broadcasts, changedHookCalls } = freshApp();
  const projectId = '01HZZZZZZZZZZZZZZZZZZZZZAA';
  const { status, data } = await fetchJson(app, 'POST', '/api/agents/pods', {
    name: 'project-scoped-pod-1',
    scope: 'project',
    projectId,
    prompt: 'You are project-scoped.',
  });
  assert.equal(status, 201);
  assert.equal(data.ok, true);
  const pod = data.pod as Record<string, unknown>;
  assert.equal(pod.scope, 'project');
  assert.equal(pod.projectId, projectId);
  assert.equal(broadcasts.length, 1);
  assert.equal(changedHookCalls[0]?.name, 'project-scoped-pod-1');
});

test('POST /api/agents/pods rejects scope="project" without projectId', async () => {
  const { app } = freshApp();
  const { status, data } = await fetchJson(app, 'POST', '/api/agents/pods', {
    name: 'missing-project',
    scope: 'project',
    prompt: 'nope',
  });
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

test('GET /api/agents/pods?projectId shows project-scope rows only (no global user-created)', async () => {
  const { app } = freshApp();
  const projectId = '01HZZZZZZZZZZZZZZZZZZZZZBB';
  const otherProject = '01HZZZZZZZZZZZZZZZZZZZZZCC';
  await fetchJson(app, 'POST', '/api/agents/pods', { name: 'mix-global-1', prompt: 'g' });
  await fetchJson(app, 'POST', '/api/agents/pods', {
    name: 'mix-project-1',
    scope: 'project',
    projectId,
    prompt: 'p',
  });
  await fetchJson(app, 'POST', '/api/agents/pods', {
    name: 'mix-other-1',
    scope: 'project',
    projectId: otherProject,
    prompt: 'other',
  });
  const { data } = await fetchJson(app, 'GET', `/api/agents/pods?projectId=${projectId}`);
  const names = (data.pods as Array<{ name: string }>).map((p) => p.name);
  // Global user-created pods are excluded from the project view (scope enforcement).
  assert.ok(!names.includes('mix-global-1'));
  // Project-scope row for this project must appear.
  assert.ok(names.includes('mix-project-1'));
  // Other projects' pods must not appear.
  assert.ok(!names.includes('mix-other-1'));
});

test('POST /api/agents/pods/:id/promote-to-global flips scope to global', async () => {
  const { app, broadcasts } = freshApp();
  const projectId = '01HZZZZZZZZZZZZZZZZZZZZZDD';
  const create = await fetchJson(app, 'POST', '/api/agents/pods', {
    name: 'promote-test',
    scope: 'project',
    projectId,
    prompt: 'p',
  });
  const id = (create.data.pod as { id: string }).id;
  broadcasts.length = 0;
  const { status, data } = await fetchJson(
    app,
    'POST',
    `/api/agents/pods/${id}/promote-to-global`,
    {},
  );
  assert.equal(status, 200);
  assert.equal((data.pod as { scope: string }).scope, 'global');
  assert.equal((data.pod as { projectId: string | null }).projectId, null);
  assert.equal(broadcasts.length, 1);
});

test('POST /api/agents/pods/:id/promote-to-global rejects already-global pod', async () => {
  const { app } = freshApp();
  const create = await fetchJson(app, 'POST', '/api/agents/pods', {
    name: 'already-global',
    prompt: 'g',
  });
  const id = (create.data.pod as { id: string }).id;
  const { status, data } = await fetchJson(
    app,
    'POST',
    `/api/agents/pods/${id}/promote-to-global`,
    {},
  );
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

test('POST /api/agents/pods/:id/promote-to-global returns 409 on global-name collision', async () => {
  const { app } = freshApp();
  const projectId = '01HZZZZZZZZZZZZZZZZZZZZZEE';
  await fetchJson(app, 'POST', '/api/agents/pods', { name: 'collision-name', prompt: 'g' });
  const create = await fetchJson(app, 'POST', '/api/agents/pods', {
    name: 'collision-name',
    scope: 'project',
    projectId,
    prompt: 'p',
  });
  const id = (create.data.pod as { id: string }).id;
  const { status, data } = await fetchJson(
    app,
    'POST',
    `/api/agents/pods/${id}/promote-to-global`,
    {},
  );
  assert.equal(status, 409);
  assert.equal(data.ok, false);
});

test('POST /api/agents/pods/:id/clone-to-project clones global to project-scope row with knowledge + mcp', async () => {
  const { app, broadcasts, changedHookCalls } = freshApp();
  // Source global pod with one knowledge row + one mcp server.
  const create = await fetchJson(app, 'POST', '/api/agents/pods', {
    name: 'clonable-global',
    prompt: 'source prompt',
    tools: ['Read', 'Glob'],
    description: 'source desc',
  });
  const sourceId = (create.data.pod as { id: string }).id;
  await fetchJson(app, 'POST', `/api/agents/pods/${sourceId}/knowledge`, {
    name: 'kb-note',
    content: 'kb content',
  });
  await fetchJson(app, 'POST', `/api/agents/pods/${sourceId}/mcp-servers`, {
    name: 'gmail',
    config: { command: 'node', args: ['gmail.js'] },
  });

  broadcasts.length = 0;
  changedHookCalls.length = 0;
  const targetProjectId = '01HZZZZZZZZZZZZZZZZZZZZZAA';
  const { status, data } = await fetchJson(
    app,
    'POST',
    `/api/agents/pods/${sourceId}/clone-to-project`,
    { projectId: targetProjectId },
  );
  assert.equal(status, 201);
  const pod = data.pod as { id: string; name: string; scope: string; projectId: string; prompt: string; tools: string[]; description: string };
  assert.equal(pod.name, 'clonable-global');
  assert.equal(pod.scope, 'project');
  assert.equal(pod.projectId, targetProjectId);
  assert.equal(pod.prompt, 'source prompt');
  // Section 26: createAgent (under clone) merges the required work-item tools.
  assert.deepEqual(pod.tools, mergeRequiredAgentTools(['Read', 'Glob']));
  assert.equal(pod.description, 'source desc');
  assert.notEqual(pod.id, sourceId);
  assert.deepEqual(data.copied, { knowledge: 1, mcpServers: 1 });
  // Bundle reflects the cloned content under the new (project-scope) agent.
  const bundle = await fetchJson(app, 'GET', `/api/agents/pods/${pod.id}`);
  assert.equal(bundle.status, 200);
  const knowledge = bundle.data.knowledge as Array<{ name: string; content: string; scope: string; projectId: string }>;
  assert.equal(knowledge.length, 1);
  assert.equal(knowledge[0]!.name, 'kb-note');
  assert.equal(knowledge[0]!.content, 'kb content');
  assert.equal(knowledge[0]!.scope, 'project');
  assert.equal(knowledge[0]!.projectId, targetProjectId);
  const mcpServers = bundle.data.mcpServers as Array<{ name: string; scope: string; projectId: string }>;
  assert.equal(mcpServers.length, 1);
  assert.equal(mcpServers[0]!.name, 'gmail');
  assert.equal(mcpServers[0]!.scope, 'project');
  assert.equal(mcpServers[0]!.projectId, targetProjectId);
  // Broadcast + hook fired with change='created'.
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0]!.change, 'created');
  assert.equal(changedHookCalls.length, 1);
  assert.equal(changedHookCalls[0]!.change, 'created');
});

test('POST /api/agents/pods/:id/clone-to-project supports name override', async () => {
  const { app } = freshApp();
  const create = await fetchJson(app, 'POST', '/api/agents/pods', {
    name: 'renameable',
    prompt: 'p',
  });
  const sourceId = (create.data.pod as { id: string }).id;
  const { status, data } = await fetchJson(
    app,
    'POST',
    `/api/agents/pods/${sourceId}/clone-to-project`,
    { projectId: '01HZZZZZZZZZZZZZZZZZZZZZBB', name: 'renamed-clone' },
  );
  assert.equal(status, 201);
  assert.equal((data.pod as { name: string }).name, 'renamed-clone');
});

test('POST /api/agents/pods/:id/clone-to-project returns 409 on name collision', async () => {
  const { app } = freshApp();
  const projectId = '01HZZZZZZZZZZZZZZZZZZZZZCC';
  await fetchJson(app, 'POST', '/api/agents/pods', { name: 'dup-source', prompt: 'g' });
  // Mint a project-scope pod with the same name in the target project.
  await fetchJson(app, 'POST', '/api/agents/pods', {
    name: 'dup-source',
    scope: 'project',
    projectId,
    prompt: 'p',
  });
  const globalCreate = await fetchJson(app, 'GET', '/api/agents/pods');
  const globalPod = (globalCreate.data.pods as Array<{ id: string; name: string; scope: string }>).find(
    (p) => p.name === 'dup-source' && p.scope === 'global',
  );
  assert.ok(globalPod);
  const { status, data } = await fetchJson(
    app,
    'POST',
    `/api/agents/pods/${globalPod!.id}/clone-to-project`,
    { projectId },
  );
  assert.equal(status, 409);
  assert.equal(data.ok, false);
});

test('POST /api/agents/pods/:id/clone-to-project rejects missing projectId', async () => {
  const { app } = freshApp();
  const create = await fetchJson(app, 'POST', '/api/agents/pods', {
    name: 'no-target',
    prompt: 'p',
  });
  const id = (create.data.pod as { id: string }).id;
  const { status } = await fetchJson(
    app,
    'POST',
    `/api/agents/pods/${id}/clone-to-project`,
    {},
  );
  assert.equal(status, 400);
});

test('POST /api/agents/pods/:id/reset-to-default rejects non-stock pods', async () => {
  const resetStub: ResetStub = {
    calls: [],
    result: { agent: { id: 'x', name: 'x', prompt: 'x' }, resetFields: [] },
  };
  const { app } = freshApp({ resetStub });
  const create = await fetchJson(app, 'POST', '/api/agents/pods', {
    name: 'not-stock-pod',
    prompt: 'p',
  });
  const id = (create.data.pod as { id: string }).id;
  const { status, data } = await fetchJson(
    app,
    'POST',
    `/api/agents/pods/${id}/reset-to-default`,
    {},
  );
  assert.equal(status, 400);
  assert.equal(data.ok, false);
  assert.equal(resetStub.calls.length, 0);
});

test('POST /api/agents/pods/:id/reset-to-default invokes the reset helper for stock pods + broadcasts', async () => {
  // Section 36 — stock identity is the `origin` column now. POST
  // /api/agents/pods doesn't accept `origin` from callers (always lands as
  // 'user-created'), so seed the test row via the repo directly to plant
  // `origin: 'stock'`.
  const resetStub: ResetStub = {
    calls: [],
    result: {
      agent: { id: 'ad-id', name: 'agent-designer', prompt: 'reset-prompt' },
      resetFields: ['prompt', 'tools'],
    },
  };
  const { app, broadcasts, changedHookCalls } = freshApp({ resetStub });
  const stock = createAgent(
    { name: 'agent-designer', scope: 'global', origin: 'stock', prompt: 'live-edited' },
    { actor: 'orchestrator', reason: 'test-fixture' },
  );
  broadcasts.length = 0;
  changedHookCalls.length = 0;
  const { status, data } = await fetchJson(
    app,
    'POST',
    `/api/agents/pods/${stock.id}/reset-to-default`,
    { reason: 'test-reset' },
  );
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.deepEqual(data.resetFields, ['prompt', 'tools']);
  assert.equal(resetStub.calls.length, 1);
  assert.equal(resetStub.calls[0]!.name, 'agent-designer');
  assert.equal(resetStub.calls[0]!.reason, 'test-reset');
  // Broadcast fired because resetFields was non-empty.
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0]!.change, 'updated');
  assert.equal(changedHookCalls.length, 1);
  // Teardown — soft-delete via the repo directly. The DELETE route is
  // origin-gated (409 on stock).
  softDeleteAgent(stock.id, { actor: 'user', reason: 'test-cleanup' });
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

test('DELETE /api/agents/pods/:id refuses stock specialists (Section 36 — by origin)', async () => {
  const { app } = freshApp();
  // Section 36 — DELETE guard reads agents.origin, not a hard-coded name
  // list. POST defaults to origin='user-created', so seed via createAgent
  // directly to plant origin: 'stock'.
  for (const stock of ['orchestrator', 'researcher', 'writer', 'reviewer', 'planner', 'extractor', 'code-writer']) {
    const row = createAgent(
      { name: stock, scope: 'global', origin: 'stock', prompt: 'stock seed' },
      { actor: 'orchestrator', reason: 'test-fixture' },
    );
    const { status, data } = await fetchJson(app, 'DELETE', `/api/agents/pods/${row.id}`);
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

// --- Section 22.2: child rows inherit agent.scope/projectId ---------------

test('22.2: project pod knowledge/secret/mcp create lands as project-scoped + bundle returns them', async () => {
  const { app } = freshApp();
  const projectId = '01TESTPROJECTFORSCOPE0001';
  const create = await fetchJson(app, 'POST', '/api/agents/pods', {
    name: 'project-child-scope',
    scope: 'project',
    projectId,
  });
  assert.equal(create.status, 201);
  const pod = create.data.pod as { id: string; scope: string; projectId: string };
  assert.equal(pod.scope, 'project');
  assert.equal(pod.projectId, projectId);
  const id = pod.id;

  // Add one of each child resource.
  const k = await fetchJson(app, 'POST', `/api/agents/pods/${id}/knowledge`, {
    name: 'proj-doc',
    content: 'project knowledge',
  });
  assert.equal(k.status, 201);

  const s = await fetchJson(app, 'POST', `/api/agents/pods/${id}/secrets`, {
    envVarName: 'PROJ_TOKEN',
    valuePlaintext: 'tok',
  });
  assert.equal(s.status, 201);

  const m = await fetchJson(app, 'POST', `/api/agents/pods/${id}/mcp-servers`, {
    name: 'proj-srv',
    config: { command: 'node', args: ['s.mjs'] },
  });
  assert.equal(m.status, 201);

  // Bundle read (which filters children by agent.scope/projectId) must
  // surface every entry we just created. Before the fix these would land as
  // 'global' rows and be invisible to the bundle read.
  const bundle = await fetchJson(app, 'GET', `/api/agents/pods/${id}`);
  assert.equal(bundle.status, 200);
  const knowledge = bundle.data.knowledge as { name: string; scope: string; projectId: string }[];
  assert.equal(knowledge.length, 1);
  assert.equal(knowledge[0].name, 'proj-doc');
  assert.equal(knowledge[0].scope, 'project');
  assert.equal(knowledge[0].projectId, projectId);

  const secrets = bundle.data.secrets as { envVarName: string }[];
  assert.equal(secrets.length, 1);
  assert.equal(secrets[0].envVarName, 'PROJ_TOKEN');

  const mcpServers = bundle.data.mcpServers as { name: string; scope: string; projectId: string }[];
  assert.equal(mcpServers.length, 1);
  assert.equal(mcpServers[0].name, 'proj-srv');
  assert.equal(mcpServers[0].scope, 'project');
  assert.equal(mcpServers[0].projectId, projectId);
});

test('22.2: global pod child rows still land as global', async () => {
  // Regression guard for the other half of the contract.
  const { app } = freshApp();
  const create = await fetchJson(app, 'POST', '/api/agents/pods', {
    name: 'global-child-scope',
  });
  const id = (create.data.pod as { id: string }).id;
  await fetchJson(app, 'POST', `/api/agents/pods/${id}/knowledge`, {
    name: 'g-doc',
    content: 'global doc',
  });
  const bundle = await fetchJson(app, 'GET', `/api/agents/pods/${id}`);
  const knowledge = bundle.data.knowledge as { scope: string; projectId: string | null }[];
  assert.equal(knowledge[0].scope, 'global');
  assert.equal(knowledge[0].projectId, null);
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

// --- 17b smoke gate (D39) --------------------------------------------------
//
// These exercise the orchestrator's HTTP path on real route handlers (same
// module the production server imports). The MCP layer is a thin HTTP shim
// over these routes; if the routes work, the orchestrator works.

test('17b.10: actor=orchestrator threads from body to audit row (POST + PATCH)', async () => {
  const { app } = freshApp();
  const create = await fetchJson(app, 'POST', '/api/agents/pods', {
    name: 'actor-thread-test',
    prompt: 'first draft',
    actor: 'orchestrator',
    reason: 'mcp-create',
  });
  assert.equal(create.status, 201);
  const id = (create.data.pod as { id: string }).id;

  await fetchJson(app, 'PATCH', `/api/agents/pods/${id}`, {
    prompt: 'second draft',
    actor: 'orchestrator',
    reason: 'mcp-edit-prompt',
  });

  const audit = await fetchJson(app, 'GET', `/api/agents/pods/${id}/audit?actor=orchestrator`);
  const rows = audit.data.rows as Array<{ actor: string; field: string; reason: string }>;
  assert.ok(rows.length >= 2, 'expected at least created + prompt rows');
  assert.ok(rows.every((r) => r.actor === 'orchestrator'));
  const fields = rows.map((r) => r.field).sort();
  assert.ok(fields.includes('created'));
  assert.ok(fields.includes('prompt'));
  // Custom reason is preserved.
  const promptRow = rows.find((r) => r.field === 'prompt');
  assert.equal(promptRow?.reason, 'mcp-edit-prompt');
});

test('17b.10: DELETE actor override via query string lands on audit', async () => {
  const { app } = freshApp();
  const create = await fetchJson(app, 'POST', '/api/agents/pods', { name: 'del-actor-test' });
  const id = (create.data.pod as { id: string }).id;

  const del = await fetchJson(
    app,
    'DELETE',
    `/api/agents/pods/${id}?actor=orchestrator&reason=mcp-delete`,
  );
  assert.equal(del.status, 200);

  // GET /audit on a soft-deleted pod 404s (the route gates on live agents);
  // read via the repo directly to verify the actor + reason landed.
  const rows = listAgentAudit({ agentId: id as never });
  const deleteRow = rows.find((r) => r.field === 'deleted');
  assert.ok(deleteRow, 'expected a deleted audit row');
  assert.equal(deleteRow?.actor, 'orchestrator');
  assert.equal(deleteRow?.reason, 'mcp-delete');
});

test('17b.10: GET single knowledge doc by id returns content', async () => {
  const { app } = freshApp();
  const create = await fetchJson(app, 'POST', '/api/agents/pods', { name: 'know-read-test' });
  const id = (create.data.pod as { id: string }).id;

  const addKnow = await fetchJson(app, 'POST', `/api/agents/pods/${id}/knowledge`, {
    name: 'pricing-tiers',
    content: '# Pricing\n\nTier A is $10/mo. Tier B is $50/mo.',
  });
  const knowledgeId = (addKnow.data.knowledge as { id: string }).id;

  const read = await fetchJson(
    app,
    'GET',
    `/api/agents/pods/${id}/knowledge/${knowledgeId}`,
  );
  assert.equal(read.status, 200);
  const knowledge = read.data.knowledge as { name: string; content: string };
  assert.equal(knowledge.name, 'pricing-tiers');
  assert.ok(knowledge.content.includes('Tier A is $10/mo'));

  // 404 paths:
  const unknownKnow = await fetchJson(
    app,
    'GET',
    `/api/agents/pods/${id}/knowledge/01NOTREAL0000000000000000`,
  );
  assert.equal(unknownKnow.status, 404);

  const unknownPod = await fetchJson(
    app,
    'GET',
    `/api/agents/pods/01NOTAPODID00000000000000/knowledge/${knowledgeId}`,
  );
  assert.equal(unknownPod.status, 404);
});

test('17b.10: full orchestrator flow — create pod, add knowledge, read it, audit reflects orchestrator', async () => {
  const { app } = freshApp();

  // Step 1: orchestrator creates a pod (mimics pc_create_agent).
  const create = await fetchJson(app, 'POST', '/api/agents/pods', {
    name: 'cold-emailer',
    description: 'Drafts cold emails for SaaS prospects.',
    prompt: 'You write 4-sentence cold emails.',
    model: 'sonnet',
    effort: 'medium',
    tools: ['Read', 'Glob', 'mcp__pc-rig__pc_get_work_item'],
    actor: 'orchestrator',
    reason: 'mcp-create',
  });
  assert.equal(create.status, 201);
  const podId = (create.data.pod as { id: string }).id;

  // Step 2: orchestrator attaches knowledge (mimics pc_create_knowledge).
  const know = await fetchJson(app, 'POST', `/api/agents/pods/${podId}/knowledge`, {
    name: 'tone-guide',
    content: 'Tone: warm but direct. No exclamation marks. Avoid superlatives.',
    actor: 'orchestrator',
    reason: 'mcp-create-knowledge',
  });
  assert.equal(know.status, 201);
  const knowId = (know.data.knowledge as { id: string }).id;

  // Step 3: orchestrator reads knowledge (mimics pc_knowledge_read).
  const read = await fetchJson(app, 'GET', `/api/agents/pods/${podId}/knowledge/${knowId}`);
  assert.equal(read.status, 200);
  assert.ok(
    (read.data.knowledge as { content: string }).content.includes('No exclamation marks'),
  );

  // Step 4: orchestrator patches the prompt (mimics pc_update_agent_prompt).
  const patch = await fetchJson(app, 'PATCH', `/api/agents/pods/${podId}`, {
    prompt: 'You write 3-sentence cold emails. Open with a name-drop.',
    actor: 'orchestrator',
    reason: 'mcp-edit-prompt',
  });
  assert.equal(patch.status, 200);
  assert.ok(
    (patch.data.pod as { prompt: string }).prompt.includes('name-drop'),
  );

  // Step 5: audit log reflects only orchestrator actions, multiple fields.
  const audit = await fetchJson(app, 'GET', `/api/agents/pods/${podId}/audit?actor=orchestrator`);
  const rows = audit.data.rows as Array<{ field: string; actor: string }>;
  const fields = new Set(rows.map((r) => r.field));
  assert.ok(fields.has('created'));
  assert.ok(fields.has('prompt'));
  assert.ok(fields.has('knowledge'));
  assert.ok(rows.every((r) => r.actor === 'orchestrator'));

  // Step 6: bundle reflects post-state — prompt + knowledge present.
  const bundle = await fetchJson(app, 'GET', `/api/agents/pods/${podId}`);
  assert.equal(bundle.status, 200);
  assert.ok(
    (bundle.data.agent as { prompt: string }).prompt.includes('name-drop'),
  );
  const knowledge = bundle.data.knowledge as Array<{ name: string }>;
  assert.equal(knowledge.length, 1);
  assert.equal(knowledge[0]?.name, 'tone-guide');
});

test('17b.10 (Section 36): stock-pod delete returns 409 regardless of actor', async () => {
  const { app } = freshApp();
  // Section 36 — stock identity is the `origin` column now. POST doesn't
  // accept `origin` from callers, so seed via createAgent directly to plant
  // origin: 'stock'.
  const stock = createAgent(
    { name: 'agent-designer', scope: 'global', origin: 'stock', prompt: 'stock seed' },
    { actor: 'orchestrator', reason: 'test-fixture' },
  );

  // Orchestrator-as-actor doesn't bypass the guard.
  const del = await fetchJson(
    app,
    'DELETE',
    `/api/agents/pods/${stock.id}?actor=orchestrator&reason=mcp-delete`,
  );
  assert.equal(del.status, 409);
  assert.equal((del.data as { kind?: string }).kind, 'stock-specialist');

  // Inverse: a user-created pod with the same DELETE call succeeds —
  // proves the guard reads the column, not the name.
  const userPod = createAgent(
    { name: 'cold-emailer-section-36', scope: 'global', prompt: 'user pod' },
    { actor: 'user', reason: 'test-fixture' },
  );
  const delUser = await fetchJson(
    app,
    'DELETE',
    `/api/agents/pods/${userPod.id}?actor=user&reason=ui-delete`,
  );
  assert.equal(delUser.status, 200);
});
