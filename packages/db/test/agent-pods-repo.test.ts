// Section 17a.2 repo smoke + 17a.4 audit threading — CRUD per pod table +
// getPodForSpawn bundle reader. Mirrors the attachments + field-schemas test
// shape (fresh sqlite DB in a tmp dir; node:test).
//
// All mutator calls thread `audit: { actor: 'user' }`. Audit-row content
// assertions live in agent-pods-audit.test.ts — this file stays focused on
// CRUD round-trips.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-db-pods-repo-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  newId,
  runMigrations,
  // agents
  createAgent,
  getAgentById,
  getAgentByName,
  listAgents,
  updateAgent,
  softDeleteAgent,
  restoreAgent,
  // knowledge
  createKnowledge,
  getKnowledge,
  getKnowledgeByName,
  listKnowledge,
  updateKnowledge,
  deleteKnowledge,
  // secrets
  createSecret,
  getSecret,
  getSecretByEnvVarName,
  listSecrets,
  deleteSecret,
  // mcp servers
  createMcpServer,
  getMcpServer,
  getMcpServerByName,
  listMcpServers,
  deleteMcpServer,
  // bundle
  getPodForSpawn,
} = await import('../src/index.ts');
import type { ULID } from '@pc/domain';
import { mergeRequiredAgentTools } from '@pc/domain';
import type { AuditInput } from '../src/index.ts';

const U: AuditInput = { actor: 'user' };

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// --- agents -----------------------------------------------------------------

test('createAgent (global) round-trips defaults + scalar fields', () => {
  const a = createAgent(
    {
      name: 'researcher',
      scope: 'global',
      prompt: 'You read code.',
      tools: ['Read', 'Grep'],
      model: 'sonnet',
      effort: 'medium',
      maxTurns: 30,
      outputDestination: 'attachment',
      description: 'codebase reader',
    },
    U,
  );
  assert.equal(a.name, 'researcher');
  assert.equal(a.scope, 'global');
  assert.equal(a.projectId, null);
  // Section 26: createAgent always merges in the required work-item tools.
  assert.deepEqual(a.tools, mergeRequiredAgentTools(['Read', 'Grep']));
  assert.equal(a.model, 'sonnet');
  assert.equal(a.deletedAt, null);

  const got = getAgentById(a.id);
  assert.ok(got);
  assert.equal(got.name, 'researcher');
  assert.equal(got.prompt, 'You read code.');
});

test('createAgent (project) rejects missing projectId', () => {
  assert.throws(
    () => createAgent({ name: 'p-only', scope: 'project' }, U),
    /projectId is required/,
  );
});

test('getAgentByName scopes correctly (global vs project)', () => {
  const projectId = newId() as ULID;
  const g = createAgent({ name: 'planner', scope: 'global' }, U);
  const p = createAgent({ name: 'planner', scope: 'project', projectId }, U);
  const fg = getAgentByName({ name: 'planner', scope: 'global' });
  const fp = getAgentByName({ name: 'planner', scope: 'project', projectId });
  assert.ok(fg);
  assert.ok(fp);
  assert.equal(fg.id, g.id);
  assert.equal(fp.id, p.id);
  assert.notEqual(fg.id, fp.id);
});

test('listAgents filters by scope + projectId', () => {
  const projectId = newId() as ULID;
  createAgent({ name: 'list-g1', scope: 'global' }, U);
  createAgent({ name: 'list-g2', scope: 'global' }, U);
  createAgent({ name: 'list-p1', scope: 'project', projectId }, U);
  const globals = listAgents({ scope: 'global' }).map((a) => a.name);
  assert.ok(globals.includes('list-g1'));
  assert.ok(globals.includes('list-g2'));
  assert.ok(!globals.includes('list-p1'));
  const projectOnly = listAgents({ projectId }).map((a) => a.name);
  assert.deepEqual(projectOnly, ['list-p1']);
});

test('updateAgent patches scalars + bumps updatedAt', async () => {
  const a = createAgent({ name: 'upd-target', scope: 'global', prompt: 'v1' }, U);
  await new Promise((r) => setTimeout(r, 2));
  const next = updateAgent(
    a.id,
    { prompt: 'v2', model: 'opus', tools: ['Read'] },
    U,
  );
  assert.ok(next);
  assert.equal(next.prompt, 'v2');
  assert.equal(next.model, 'opus');
  // Section 26: updateAgent re-merges the required work-item tools even if
  // the patch tried to remove them.
  assert.deepEqual(next.tools, mergeRequiredAgentTools(['Read']));
  assert.ok(next.updatedAt >= a.updatedAt);
});

test('softDeleteAgent flips deletedAt; getAgentById then returns null', () => {
  const a = createAgent({ name: 'del-target', scope: 'global' }, U);
  const deleted = softDeleteAgent(a.id, U);
  assert.ok(deleted);
  assert.ok(deleted.deletedAt && deleted.deletedAt > 0);
  assert.equal(getAgentById(a.id), null);
  // Idempotent — second call still returns null because getAgentById filters live-only.
  assert.equal(softDeleteAgent(a.id, U), null);
});

test('soft-deleted agent name can be reused immediately (partial index)', () => {
  const a = createAgent({ name: 'reuse-name', scope: 'global' }, U);
  softDeleteAgent(a.id, U);
  // Live unique-name index is scope='global' AND deleted_at IS NULL — fresh
  // insert should succeed because the prior row is soft-deleted.
  const b = createAgent({ name: 'reuse-name', scope: 'global' }, U);
  assert.notEqual(b.id, a.id);
});

test('restoreAgent un-flips deletedAt; row reappears in queries', () => {
  const a = createAgent({ name: 'restore-target', scope: 'global' }, U);
  softDeleteAgent(a.id, U);
  const restored = restoreAgent(a.id);
  assert.ok(restored);
  assert.equal(restored.deletedAt, null);
  assert.ok(getAgentById(a.id));
  // Restoring a live row is a no-op (returns null because nothing to restore).
  assert.equal(restoreAgent(a.id), null);
});

// --- knowledge --------------------------------------------------------------

test('createKnowledge + getKnowledgeByName round-trip', () => {
  const owner = createAgent({ name: 'k-owner', scope: 'global' }, U);
  const k = createKnowledge(
    {
      agentId: owner.id,
      scope: 'global',
      name: 'style-guide',
      content: '# Style guide\n',
    },
    U,
  );
  assert.equal(k.kind, 'knowledge');
  assert.equal(k.content, '# Style guide\n');
  const got = getKnowledgeByName({ agentId: owner.id, scope: 'global', name: 'style-guide' });
  assert.ok(got);
  assert.equal(got.id, k.id);
});

test('listKnowledge returns alphabetical, filtered by agent', () => {
  const owner = createAgent({ name: 'k-list-owner', scope: 'global' }, U);
  createKnowledge({ agentId: owner.id, scope: 'global', name: 'banana', content: 'b' }, U);
  createKnowledge({ agentId: owner.id, scope: 'global', name: 'apple', content: 'a' }, U);
  createKnowledge({ agentId: owner.id, scope: 'global', name: 'cherry', content: 'c' }, U);
  const ordered = listKnowledge({ agentId: owner.id }).map((r) => r.name);
  assert.deepEqual(ordered, ['apple', 'banana', 'cherry']);
});

test('updateKnowledge patches name + content', () => {
  const owner = createAgent({ name: 'k-upd-owner', scope: 'global' }, U);
  const k = createKnowledge(
    {
      agentId: owner.id,
      scope: 'global',
      name: 'old-name',
      content: 'v1',
    },
    U,
  );
  const next = updateKnowledge(k.id, { name: 'new-name', content: 'v2' }, U);
  assert.ok(next);
  assert.equal(next.name, 'new-name');
  assert.equal(next.content, 'v2');
});

test('deleteKnowledge hard-deletes the row', () => {
  const owner = createAgent({ name: 'k-del-owner', scope: 'global' }, U);
  const k = createKnowledge(
    { agentId: owner.id, scope: 'global', name: 'doomed', content: '' },
    U,
  );
  assert.equal(deleteKnowledge(k.id, U), true);
  assert.equal(getKnowledge(k.id), null);
  assert.equal(deleteKnowledge(k.id, U), false);
});

// --- secrets ----------------------------------------------------------------

test('createSecret + getSecretByEnvVarName + listSecrets', () => {
  const owner = createAgent({ name: 's-owner', scope: 'global' }, U);
  const s = createSecret(
    {
      agentId: owner.id,
      scope: 'global',
      envVarName: 'OPENAI_API_KEY',
      valuePlaintext: 'sk-x',
    },
    U,
  );
  const got = getSecretByEnvVarName({
    agentId: owner.id,
    scope: 'global',
    envVarName: 'OPENAI_API_KEY',
  });
  assert.ok(got);
  assert.equal(got.id, s.id);
  assert.equal(got.valuePlaintext, 'sk-x');
  const all = listSecrets({ agentId: owner.id });
  assert.equal(all.length, 1);
});

test('deleteSecret hard-deletes', () => {
  const owner = createAgent({ name: 's-del-owner', scope: 'global' }, U);
  const s = createSecret(
    {
      agentId: owner.id,
      scope: 'global',
      envVarName: 'X',
      valuePlaintext: '1',
    },
    U,
  );
  assert.equal(deleteSecret(s.id, U), true);
  assert.equal(getSecret(s.id), null);
});

// --- mcp servers ------------------------------------------------------------

test('createMcpServer + getMcpServerByName round-trip with config JSON', () => {
  const owner = createAgent({ name: 'm-owner', scope: 'global' }, U);
  const cfg = { command: 'node', args: ['./srv.mjs'], env: { LOG: 'debug' } };
  const m = createMcpServer(
    {
      agentId: owner.id,
      scope: 'global',
      name: 'pc-rig',
      config: cfg,
    },
    U,
  );
  const got = getMcpServerByName({ agentId: owner.id, scope: 'global', name: 'pc-rig' });
  assert.ok(got);
  assert.equal(got.id, m.id);
  assert.deepEqual(got.config, cfg);
});

test('listMcpServers + deleteMcpServer', () => {
  const owner = createAgent({ name: 'm-list-owner', scope: 'global' }, U);
  createMcpServer(
    { agentId: owner.id, scope: 'global', name: 'beta', config: { command: 'b' } },
    U,
  );
  createMcpServer(
    { agentId: owner.id, scope: 'global', name: 'alpha', config: { command: 'a' } },
    U,
  );
  const ordered = listMcpServers({ agentId: owner.id }).map((r) => r.name);
  assert.deepEqual(ordered, ['alpha', 'beta']);
  const first = getMcpServerByName({ agentId: owner.id, scope: 'global', name: 'alpha' });
  assert.ok(first);
  assert.equal(deleteMcpServer(first.id, U), true);
  assert.equal(getMcpServer(first.id), null);
});

// --- pod bundle -------------------------------------------------------------

test('getPodForSpawn returns the global-only merged bundle', () => {
  const a = createAgent(
    {
      name: 'spawn-target',
      scope: 'global',
      prompt: 'do things',
      tools: ['Read'],
    },
    U,
  );
  createKnowledge(
    {
      agentId: a.id,
      scope: 'global',
      name: 'README',
      content: '# project\n',
    },
    U,
  );
  createSecret(
    {
      agentId: a.id,
      scope: 'global',
      envVarName: 'API_KEY',
      valuePlaintext: 'sk-spawn',
    },
    U,
  );
  createMcpServer(
    {
      agentId: a.id,
      scope: 'global',
      name: 'pc-rig',
      config: { command: 'node', args: ['srv.mjs'] },
    },
    U,
  );
  const bundle = getPodForSpawn('spawn-target');
  assert.ok(bundle);
  assert.equal(bundle.agent.id, a.id);
  assert.equal(bundle.agent.prompt, 'do things');
  assert.equal(bundle.knowledge.length, 1);
  assert.equal(bundle.knowledge[0].name, 'README');
  assert.equal(bundle.secrets.length, 1);
  assert.equal(bundle.secrets[0].envVarName, 'API_KEY');
  assert.equal(bundle.mcpServers.length, 1);
  assert.equal(bundle.mcpServers[0].name, 'pc-rig');
});

test('getPodForSpawn returns null when no live global agent matches', () => {
  assert.equal(getPodForSpawn('does-not-exist'), null);
});

test('getPodForSpawn (v1) ignores project-scoped content even if projectId given', () => {
  // v1 contract: global-only resolution. Project rows exist (forward-compat
  // for 17c) but are NOT included in the bundle yet. Guard against accidental
  // overlay-by-default.
  const projectId = newId() as ULID;
  const a = createAgent(
    {
      name: 'v1-only',
      scope: 'global',
      prompt: 'global prompt',
    },
    U,
  );
  // Project-scoped row on the same agent — should be ignored by v1.
  createKnowledge(
    {
      agentId: a.id,
      scope: 'project',
      projectId,
      name: 'project-only-doc',
      content: 'should not appear',
    },
    U,
  );
  const bundle = getPodForSpawn('v1-only', projectId);
  assert.ok(bundle);
  assert.equal(bundle.knowledge.length, 0);
});
