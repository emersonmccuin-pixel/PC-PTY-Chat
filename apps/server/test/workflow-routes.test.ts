// Section 19.17 — Workflow HTTP routes unit tests.
//
// Mirrors pod-routes.test.ts: fresh Hono app, registerWorkflowRoutes()
// against in-memory deps, exercise endpoints via app.fetch(new Request(...)).
// Persistence is real — the same workflowsRepo the production server uses —
// but the in-flight-runs guard + fire callback are stubs so each test owns
// its own assertion surface.
//
// Run via:  pnpm --filter @pc/server test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDataDir = mkdtempSync(join(tmpdir(), 'pc-wf-routes-db-'));
process.env.PC_DATA_DIR = tmpDataDir;

const { closeDb, createProject, runMigrations, workflowsRepo } = await import('@pc/db');
const { Hono } = await import('hono');
const { registerWorkflowRoutes } = await import('../src/routes/workflow-routes.ts');

import type { Stage, ULID, WorkflowV2 } from '@pc/domain';

const SEED_STAGES: Stage[] = [
  { id: 'backlog', name: 'Backlog', order: 0 },
  { id: 'review', name: 'Review', order: 1 },
  { id: 'done', name: 'Done', order: 2 },
];

let projectSeq = 0;
function ensureProject(seedTag: string): ULID {
  projectSeq += 1;
  const slug = `wfr-${seedTag.toLowerCase()}-${projectSeq}`;
  const created = createProject({
    slug,
    name: slug,
    stages: SEED_STAGES,
    folderPath: join(tmpDataDir, slug),
  });
  return created.id as ULID;
}

interface BroadcastTo {
  projectId: string;
  msg: { type?: string; change?: string; workflowId?: string };
}
interface BroadcastAll {
  msg: { type?: string; change?: string; workflowId?: string };
}

function freshApp(
  opts?: {
    inFlightBySlug?: Record<string, number>;
    fireResult?: { runId: ULID; rootWorkItemId: ULID };
    fireThrows?: string;
  },
) {
  const broadcastsTo: BroadcastTo[] = [];
  const broadcastsAll: BroadcastAll[] = [];
  const cancelCalls: { projectId: string; slug: string }[] = [];
  const fireCalls: {
    projectId: string;
    def: WorkflowV2.Workflow;
    trigger: WorkflowV2.WorkflowTrigger;
  }[] = [];
  const app = new Hono();
  registerWorkflowRoutes(app, {
    broadcastTo: (projectId, msg) => {
      broadcastsTo.push({ projectId, msg: msg as BroadcastTo['msg'] });
    },
    broadcastAll: (msg) => {
      broadcastsAll.push({ msg: msg as BroadcastAll['msg'] });
    },
    countInFlightRuns: (_pid, slug) => opts?.inFlightBySlug?.[slug] ?? 0,
    cancelInFlightRuns: (projectId, slug) => {
      cancelCalls.push({ projectId, slug });
    },
    fireWorkflow: async (projectId, def, trigger) => {
      fireCalls.push({ projectId, def, trigger });
      if (opts?.fireThrows) throw new Error(opts.fireThrows);
      return (
        opts?.fireResult ?? {
          runId: '01TESTRUN0000000000000000R' as ULID,
          rootWorkItemId: '01TESTWI00000000000000000W' as ULID,
        }
      );
    },
  });
  return { app, broadcastsTo, broadcastsAll, cancelCalls, fireCalls };
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

const TWO_NODE_YAML = `version: 2
id: simple-chain
name: Simple Chain
worktree: none
triggers:
  - kind: manual
nodes:
  - kind: bash
    id: n1
    bash: 'echo hello'
`;

const STAGE_ENTRY_YAML = `version: 2
id: stage-fire
name: Stage Fire
worktree: none
triggers:
  - kind: stage-on-entry
    stage: review
nodes:
  - kind: bash
    id: n1
    bash: 'echo enter'
`;

// Mint a real project row per test — workflows.projectId carries a FK to
// projects.id, so synthetic ULID strings (the trick pod-routes uses, since
// agents.projectId has no FK) don't work here.
function projectId(seed: string): ULID {
  return ensureProject(seed);
}

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

// --- CRUD ------------------------------------------------------------------

test('POST /api/workflows creates a project-scope row + emits workflow-changed to the project', async () => {
  const { app, broadcastsTo, broadcastsAll } = freshApp();
  const pid = projectId('CREATE_A');
  const { status, data } = await fetchJson(app, 'POST', '/api/workflows', {
    yaml: TWO_NODE_YAML,
    projectId: pid,
  });
  assert.equal(status, 201);
  assert.equal(data.ok, true);
  const wf = data.workflow as Record<string, unknown>;
  assert.equal(wf.slug, 'simple-chain');
  assert.equal(wf.scope, 'project');
  assert.equal(wf.projectId, pid);
  assert.equal(wf.status, 'active');
  assert.equal(wf.origin, 'user-created');
  assert.equal(wf.disabled, false);

  assert.equal(broadcastsTo.length, 1);
  assert.equal(broadcastsTo[0]?.projectId, pid);
  assert.equal(broadcastsTo[0]?.msg.type, 'workflow-changed');
  assert.equal(broadcastsTo[0]?.msg.change, 'created');
  assert.equal(broadcastsAll.length, 0);
});

test('POST /api/workflows 400 when projectId missing for project scope', async () => {
  const { app } = freshApp();
  const { status, data } = await fetchJson(app, 'POST', '/api/workflows', {
    yaml: TWO_NODE_YAML,
  });
  assert.equal(status, 400);
  assert.equal(data.ok, false);
  assert.match(String(data.error), /projectId/i);
});

test('POST /api/workflows 409 on slug collision in same scope', async () => {
  const { app } = freshApp();
  const pid = projectId('SLUG_COLL');
  await fetchJson(app, 'POST', '/api/workflows', {
    yaml: TWO_NODE_YAML,
    projectId: pid,
  });
  const { status, data } = await fetchJson(app, 'POST', '/api/workflows', {
    yaml: TWO_NODE_YAML,
    projectId: pid,
  });
  assert.equal(status, 409);
  assert.equal(data.ok, false);
  assert.match(String(data.error), /slug.*already exists/i);
});

test('GET /api/workflows?projectId=... returns project rows ∪ globals', async () => {
  const { app } = freshApp();
  const pidA = projectId('LIST_A');
  const pidB = projectId('LIST_B');
  // Project-scope row in A
  await fetchJson(app, 'POST', '/api/workflows', {
    yaml: TWO_NODE_YAML,
    projectId: pidA,
  });
  // Project-scope row in B (same slug — different project, allowed)
  await fetchJson(app, 'POST', '/api/workflows', {
    yaml: TWO_NODE_YAML,
    projectId: pidB,
  });
  // Global row
  await fetchJson(app, 'POST', '/api/workflows', {
    yaml: STAGE_ENTRY_YAML,
    scope: 'global',
  });

  const { status, data } = await fetchJson(
    app,
    'GET',
    `/api/workflows?projectId=${pidA}`,
  );
  assert.equal(status, 200);
  const rows = data.workflows as Array<{ slug: string; scope: string; projectId: string | null }>;
  // A's project row + the global; B's project row excluded.
  const slugs = rows.map((r) => `${r.scope}:${r.slug}`);
  assert.ok(slugs.includes('project:simple-chain'), `expected project row, got ${slugs.join(',')}`);
  assert.ok(slugs.includes('global:stage-fire'), `expected global row, got ${slugs.join(',')}`);
  assert.ok(
    !rows.some((r) => r.projectId === pidB),
    'should NOT contain rows from project B',
  );
});

test('GET /api/workflows (no projectId) returns globals only', async () => {
  const { app } = freshApp();
  await fetchJson(app, 'POST', '/api/workflows', {
    yaml: TWO_NODE_YAML,
    projectId: projectId('GLOBALS_ONLY'),
  });
  await fetchJson(app, 'POST', '/api/workflows', {
    yaml: STAGE_ENTRY_YAML,
    scope: 'global',
  });

  const { status, data } = await fetchJson(app, 'GET', '/api/workflows');
  assert.equal(status, 200);
  const rows = data.workflows as Array<{ scope: string }>;
  assert.ok(rows.every((r) => r.scope === 'global'));
  assert.ok(rows.length >= 1);
});

test('GET /api/workflows/:id 404 for unknown id', async () => {
  const { app } = freshApp();
  const { status, data } = await fetchJson(
    app,
    'GET',
    '/api/workflows/01DOESNOTEXIST0000000000000',
  );
  assert.equal(status, 404);
  assert.equal(data.ok, false);
});

test('PUT /api/workflows/:id updates yaml + reflects new content; rejects slug rename', async () => {
  const { app, broadcastsTo } = freshApp();
  const pid = projectId('UPDATE_A');
  const created = await fetchJson(app, 'POST', '/api/workflows', {
    yaml: TWO_NODE_YAML,
    projectId: pid,
  });
  const id = (created.data.workflow as { id: string }).id;
  broadcastsTo.length = 0;

  // Same slug, edited body
  const edited = TWO_NODE_YAML.replace("echo hello", "echo updated");
  const { status: okStatus, data: okData } = await fetchJson(
    app,
    'PUT',
    `/api/workflows/${id}`,
    { yaml: edited },
  );
  assert.equal(okStatus, 200);
  assert.equal(okData.ok, true);
  const updated = okData.workflow as { yaml: string; yamlHash: string };
  assert.match(updated.yaml, /echo updated/);
  assert.equal(broadcastsTo.length, 1);
  assert.equal(broadcastsTo[0]?.msg.change, 'updated');

  // Slug rename via def.id mismatch → 400
  const renamed = TWO_NODE_YAML.replace('id: simple-chain', 'id: renamed-chain');
  const { status: badStatus, data: badData } = await fetchJson(
    app,
    'PUT',
    `/api/workflows/${id}`,
    { yaml: renamed },
  );
  assert.equal(badStatus, 400);
  assert.match(String(badData.error), /slug/i);
});

test('PUT /api/workflows/:id with disabled=true flips the flag', async () => {
  const { app } = freshApp();
  const pid = projectId('DISABLE_A');
  const created = await fetchJson(app, 'POST', '/api/workflows', {
    yaml: TWO_NODE_YAML,
    projectId: pid,
  });
  const id = (created.data.workflow as { id: string }).id;
  const { status, data } = await fetchJson(app, 'PUT', `/api/workflows/${id}`, {
    disabled: true,
  });
  assert.equal(status, 200);
  assert.equal((data.workflow as { disabled: boolean }).disabled, true);
});

// --- delete --------------------------------------------------------------

test('DELETE /api/workflows/:id soft-deletes when no in-flight runs', async () => {
  const { app, broadcastsTo } = freshApp();
  const pid = projectId('DELETE_A');
  const created = await fetchJson(app, 'POST', '/api/workflows', {
    yaml: TWO_NODE_YAML,
    projectId: pid,
  });
  const id = (created.data.workflow as { id: string }).id;

  const { status, data } = await fetchJson(app, 'DELETE', `/api/workflows/${id}`);
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(broadcastsTo.some((b) => b.msg.change === 'deleted'));

  // Subsequent GET returns 404 (soft-deleted)
  const { status: gone } = await fetchJson(app, 'GET', `/api/workflows/${id}`);
  assert.equal(gone, 404);
});

test('DELETE /api/workflows/:id 409 when in-flight runs exist; ?cancel=1 drives cancelInFlightRuns', async () => {
  const inFlight: Record<string, number> = { 'simple-chain': 2 };
  const { app, cancelCalls } = freshApp({ inFlightBySlug: inFlight });
  const pid = projectId('DELETE_FLIGHT');
  const created = await fetchJson(app, 'POST', '/api/workflows', {
    yaml: TWO_NODE_YAML,
    projectId: pid,
  });
  const id = (created.data.workflow as { id: string }).id;

  const blocked = await fetchJson(app, 'DELETE', `/api/workflows/${id}`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.kind, 'in-flight-runs');
  assert.equal(blocked.data.inFlight, 2);
  assert.equal(cancelCalls.length, 0);

  const forced = await fetchJson(app, 'DELETE', `/api/workflows/${id}?cancel=1`);
  assert.equal(forced.status, 200);
  assert.equal(cancelCalls.length, 1);
  assert.equal(cancelCalls[0]?.slug, 'simple-chain');
});

// --- promote-to-global -----------------------------------------------------

test('POST /api/workflows/:id/promote-to-global flips scope + clears projectId', async () => {
  const { app, broadcastsAll, broadcastsTo } = freshApp();
  const pid = projectId('PROMOTE_A');
  const created = await fetchJson(app, 'POST', '/api/workflows', {
    yaml: TWO_NODE_YAML,
    projectId: pid,
  });
  const id = (created.data.workflow as { id: string }).id;
  broadcastsTo.length = 0;
  broadcastsAll.length = 0;

  const { status, data } = await fetchJson(
    app,
    'POST',
    `/api/workflows/${id}/promote-to-global`,
  );
  assert.equal(status, 200);
  const wf = data.workflow as { scope: string; projectId: string | null };
  assert.equal(wf.scope, 'global');
  assert.equal(wf.projectId, null);

  // Source project sees a 'deleted' envelope (the row left their view).
  assert.ok(broadcastsTo.some((b) => b.msg.change === 'deleted' && b.projectId === pid));
  // Every project sees a 'created' envelope (the new global is visible).
  assert.ok(broadcastsAll.some((b) => b.msg.change === 'created'));
});

test('POST /api/workflows/:id/promote-to-global 409 when global slug already exists', async () => {
  const { app } = freshApp();
  const pidA = projectId('PROM_409_A');
  // First, promote a project row to global (claims the slug globally)
  const createdA = await fetchJson(app, 'POST', '/api/workflows', {
    yaml: TWO_NODE_YAML,
    projectId: pidA,
  });
  const idA = (createdA.data.workflow as { id: string }).id;
  await fetchJson(app, 'POST', `/api/workflows/${idA}/promote-to-global`);

  // Second project tries to promote a row with the same slug
  const pidB = projectId('PROM_409_B');
  const createdB = await fetchJson(app, 'POST', '/api/workflows', {
    yaml: TWO_NODE_YAML,
    projectId: pidB,
  });
  const idB = (createdB.data.workflow as { id: string }).id;
  const { status, data } = await fetchJson(
    app,
    'POST',
    `/api/workflows/${idB}/promote-to-global`,
  );
  assert.equal(status, 409);
  assert.match(String(data.error), /already exists/i);
});

// --- duplicate -------------------------------------------------------------

test('POST /api/workflows/:id/duplicate produces a force-disabled clone in the same scope', async () => {
  const { app } = freshApp();
  const pid = projectId('DUP_A');
  const created = await fetchJson(app, 'POST', '/api/workflows', {
    yaml: TWO_NODE_YAML,
    projectId: pid,
  });
  const id = (created.data.workflow as { id: string }).id;

  const { status, data } = await fetchJson(app, 'POST', `/api/workflows/${id}/duplicate`, {});
  assert.equal(status, 201);
  const clone = data.workflow as {
    id: string;
    slug: string;
    name: string;
    scope: string;
    projectId: string;
    disabled: boolean;
  };
  assert.notEqual(clone.id, id);
  assert.equal(clone.slug, 'simple-chain-copy');
  assert.equal(clone.name, 'Simple Chain (copy)');
  assert.equal(clone.scope, 'project');
  assert.equal(clone.projectId, pid);
  assert.equal(clone.disabled, true);
});

// --- fire ------------------------------------------------------------------

test('POST /api/workflows/:id/fire resolves DB row + invokes fireWorkflow with parsed def', async () => {
  const { app, fireCalls } = freshApp();
  const pid = projectId('FIRE_A');
  const created = await fetchJson(app, 'POST', '/api/workflows', {
    yaml: TWO_NODE_YAML,
    projectId: pid,
  });
  const id = (created.data.workflow as { id: string }).id;

  const { status, data } = await fetchJson(app, 'POST', `/api/workflows/${id}/fire`, {});
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(fireCalls.length, 1);
  assert.equal(fireCalls[0]?.projectId, pid);
  assert.equal(fireCalls[0]?.def.id, 'simple-chain');
  assert.equal(fireCalls[0]?.trigger.kind, 'manual');
  assert.equal(data.runId, '01TESTRUN0000000000000000R');
});

test('POST /api/workflows/:id/fire for global workflows requires projectId in body', async () => {
  const { app, fireCalls } = freshApp();
  // Unique slug so the global doesn't collide with the LIST / no-projectId
  // tests above (the DB is shared across the test file).
  const yaml = STAGE_ENTRY_YAML.replace('id: stage-fire', 'id: stage-fire-globalonly').replace(
    'name: Stage Fire',
    'name: Stage Fire Globalonly',
  );
  const created = await fetchJson(app, 'POST', '/api/workflows', {
    yaml,
    scope: 'global',
  });
  const id = (created.data.workflow as { id: string }).id;

  const missing = await fetchJson(app, 'POST', `/api/workflows/${id}/fire`, {});
  assert.equal(missing.status, 400);
  assert.equal(fireCalls.length, 0);

  const pid = projectId('FIRE_GLOBAL_TARGET');
  const ok = await fetchJson(app, 'POST', `/api/workflows/${id}/fire`, {
    projectId: pid,
  });
  assert.equal(ok.status, 200);
  assert.equal(fireCalls.length, 1);
  assert.equal(fireCalls[0]?.projectId, pid);
});

test('POST /api/workflows/:id/fire 400 when row is disabled', async () => {
  const { app, fireCalls } = freshApp();
  const pid = projectId('FIRE_DISABLED');
  const created = await fetchJson(app, 'POST', '/api/workflows', {
    yaml: TWO_NODE_YAML,
    projectId: pid,
  });
  const id = (created.data.workflow as { id: string }).id;
  await fetchJson(app, 'PUT', `/api/workflows/${id}`, { disabled: true });

  const { status, data } = await fetchJson(app, 'POST', `/api/workflows/${id}/fire`, {});
  assert.equal(status, 400);
  assert.match(String(data.error), /disabled/i);
  assert.equal(fireCalls.length, 0);
});

// --- audit -----------------------------------------------------------------

test('GET /api/workflows/:id/audit returns the audit trail for the row', async () => {
  const { app } = freshApp();
  const pid = projectId('AUDIT_A');
  const created = await fetchJson(app, 'POST', '/api/workflows', {
    yaml: TWO_NODE_YAML,
    projectId: pid,
    actor: 'orchestrator',
    reason: 'mcp-publish',
  });
  const id = (created.data.workflow as { id: string }).id;

  await fetchJson(app, 'PUT', `/api/workflows/${id}`, { disabled: true });

  const { status, data } = await fetchJson(app, 'GET', `/api/workflows/${id}/audit`);
  assert.equal(status, 200);
  const rows = data.rows as Array<{ field: string; actor: string }>;
  assert.ok(rows.length >= 2);
  const fields = rows.map((r) => r.field);
  assert.ok(fields.includes('created'));
  assert.ok(fields.includes('disabled'));
});

// --- workflowsRepo direct sanity -------------------------------------------

test('repo: listWorkflows({ projectId, includeGlobals: true }) reflects route inserts', async () => {
  const { app } = freshApp();
  const pid = projectId('REPO_SANITY');
  await fetchJson(app, 'POST', '/api/workflows', {
    yaml: TWO_NODE_YAML,
    projectId: pid,
  });
  const direct = workflowsRepo.listWorkflows({
    projectId: pid,
    includeGlobals: true,
  });
  assert.ok(direct.some((r) => r.slug === 'simple-chain' && r.projectId === pid));
});
