// Section 17a.4 — Audit-log writes + reads.
//
// Verifies that every pod mutator lands the right `agent_audit` row in the
// same transaction as the mutation: shape (field, fieldRef, prior/new), actor
// threading, change-set grouping for multi-field updateAgent calls, secrets
// log event-only, restore is NOT audited, and listAgentAudit returns newest-
// first with the documented filters.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-db-pods-audit-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  newId,
  runMigrations,
  createAgent,
  updateAgent,
  softDeleteAgent,
  restoreAgent,
  createKnowledge,
  updateKnowledge,
  deleteKnowledge,
  createSecret,
  deleteSecret,
  createMcpServer,
  deleteMcpServer,
  listAgentAudit,
} = await import('../src/index.ts');
import type { ULID } from '@pc/domain';
import { mergeRequiredAgentTools } from '@pc/domain';
import type { AuditInput } from '../src/index.ts';

const U: AuditInput = { actor: 'user' };
const ORCH: AuditInput = { actor: 'orchestrator' };

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// --- agent lifecycle --------------------------------------------------------

test('createAgent emits a single `created` audit row with new_value snapshot', () => {
  const a = createAgent(
    { name: 'audit-create', scope: 'global', prompt: 'hello', tools: ['Read'] },
    { actor: 'user', reason: 'first agent' },
  );
  const rows = listAgentAudit({ agentId: a.id });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.field, 'created');
  assert.equal(r.actor, 'user');
  assert.equal(r.reason, 'first agent');
  assert.equal(r.fieldRef, null);
  assert.equal(r.priorValue, null);
  assert.ok(r.newValue);
  const snap = JSON.parse(r.newValue!);
  assert.equal(snap.name, 'audit-create');
  assert.equal(snap.prompt, 'hello');
  // Section 26: createAgent always merges in the required work-item tools.
  assert.deepEqual(snap.tools, mergeRequiredAgentTools(['Read']));
});

test('softDeleteAgent emits a `deleted` row with prior_value snapshot', () => {
  const a = createAgent(
    { name: 'audit-soft-del', scope: 'global', prompt: 'p1' },
    U,
  );
  softDeleteAgent(a.id, { actor: 'user', reason: 'cleanup' });
  const rows = listAgentAudit({ agentId: a.id });
  // newest-first → [deleted, created]
  assert.equal(rows[0].field, 'deleted');
  assert.equal(rows[0].reason, 'cleanup');
  assert.ok(rows[0].priorValue);
  const snap = JSON.parse(rows[0].priorValue!);
  assert.equal(snap.prompt, 'p1');
  assert.equal(rows[0].newValue, null);
});

test('restoreAgent does NOT emit an audit row (v1 carve-out)', () => {
  const a = createAgent({ name: 'audit-restore', scope: 'global' }, U);
  softDeleteAgent(a.id, U);
  const before = listAgentAudit({ agentId: a.id }).length;
  restoreAgent(a.id);
  const after = listAgentAudit({ agentId: a.id }).length;
  assert.equal(after, before, 'restore should not add audit rows in v1');
});

// --- updateAgent: change-set grouping --------------------------------------

test('updateAgent solo-field edit emits one row, no change_set_id', () => {
  const a = createAgent(
    { name: 'audit-solo', scope: 'global', prompt: 'v1' },
    U,
  );
  updateAgent(a.id, { prompt: 'v2' }, U);
  const rows = listAgentAudit({ agentId: a.id, field: 'prompt' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].field, 'prompt');
  assert.equal(rows[0].priorValue, JSON.stringify('v1'));
  assert.equal(rows[0].newValue, JSON.stringify('v2'));
  assert.equal(rows[0].changeSetId, null);
});

test('updateAgent multi-field edit groups all rows under a fresh change_set_id', () => {
  const a = createAgent(
    {
      name: 'audit-multi',
      scope: 'global',
      prompt: 'v1',
      model: 'sonnet',
      tools: ['Read'],
    },
    U,
  );
  updateAgent(
    a.id,
    { prompt: 'v2', model: 'opus', tools: ['Read', 'Grep'] },
    U,
  );
  const rows = listAgentAudit({ agentId: a.id, limit: 10 }).filter(
    (r) => r.field !== 'created',
  );
  assert.equal(rows.length, 3);
  const csid = rows[0].changeSetId;
  assert.ok(csid, 'multi-field update should mint a change_set_id');
  for (const r of rows) assert.equal(r.changeSetId, csid);
  const fields = rows.map((r) => r.field).sort();
  assert.deepEqual(fields, ['model', 'prompt', 'tools']);
});

test('updateAgent honors a caller-supplied change_set_id even on solo edits', () => {
  const a = createAgent({ name: 'audit-csid', scope: 'global', prompt: 'v1' }, U);
  const csid = newId() as ULID;
  updateAgent(a.id, { prompt: 'v2' }, { actor: 'orchestrator', changeSetId: csid });
  const rows = listAgentAudit({ agentId: a.id, field: 'prompt' });
  assert.equal(rows[0].changeSetId, csid);
  assert.equal(rows[0].actor, 'orchestrator');
});

test('updateAgent skips audit when the patch is a no-op', () => {
  const a = createAgent({ name: 'audit-noop', scope: 'global', prompt: 'v1' }, U);
  const before = listAgentAudit({ agentId: a.id }).length;
  updateAgent(a.id, { prompt: 'v1' }, U); // identical value
  updateAgent(a.id, {}, U); // empty patch
  const after = listAgentAudit({ agentId: a.id }).length;
  assert.equal(after, before, 'no-op updates should not add audit rows');
});

// --- knowledge --------------------------------------------------------------

test('createKnowledge emits a `knowledge` row with the doc id in field_ref', () => {
  const owner = createAgent({ name: 'audit-k-create', scope: 'global' }, U);
  const k = createKnowledge(
    {
      agentId: owner.id,
      scope: 'global',
      name: 'note',
      content: 'hi',
    },
    { actor: 'orchestrator', reason: 'first note' },
  );
  const rows = listAgentAudit({ agentId: owner.id, field: 'knowledge' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fieldRef, k.id);
  assert.equal(rows[0].actor, 'orchestrator');
  assert.equal(rows[0].reason, 'first note');
  const snap = JSON.parse(rows[0].newValue!);
  assert.equal(snap.name, 'note');
  assert.equal(snap.content, 'hi');
});

test('updateKnowledge emits a `knowledge` row with prior + new snapshots', () => {
  const owner = createAgent({ name: 'audit-k-update', scope: 'global' }, U);
  const k = createKnowledge(
    { agentId: owner.id, scope: 'global', name: 'doc', content: 'v1' },
    U,
  );
  updateKnowledge(k.id, { content: 'v2' }, U);
  const rows = listAgentAudit({ agentId: owner.id, field: 'knowledge' });
  // newest-first → [update, create]
  assert.equal(rows[0].fieldRef, k.id);
  const prior = JSON.parse(rows[0].priorValue!);
  const next = JSON.parse(rows[0].newValue!);
  assert.equal(prior.content, 'v1');
  assert.equal(next.content, 'v2');
});

test('updateKnowledge skips audit when patch produces no changes', () => {
  const owner = createAgent({ name: 'audit-k-noop', scope: 'global' }, U);
  const k = createKnowledge(
    { agentId: owner.id, scope: 'global', name: 'same', content: 'x' },
    U,
  );
  const before = listAgentAudit({ agentId: owner.id }).length;
  updateKnowledge(k.id, { name: 'same', content: 'x' }, U);
  const after = listAgentAudit({ agentId: owner.id }).length;
  assert.equal(after, before);
});

test('deleteKnowledge emits a `knowledge` row with prior_value only', () => {
  const owner = createAgent({ name: 'audit-k-delete', scope: 'global' }, U);
  const k = createKnowledge(
    { agentId: owner.id, scope: 'global', name: 'doomed', content: 'bye' },
    U,
  );
  deleteKnowledge(k.id, U);
  const rows = listAgentAudit({ agentId: owner.id, field: 'knowledge' });
  // newest-first → [delete, create]
  assert.equal(rows[0].fieldRef, k.id);
  assert.equal(rows[0].newValue, null);
  const prior = JSON.parse(rows[0].priorValue!);
  assert.equal(prior.content, 'bye');
});

// --- secrets (event-only) ---------------------------------------------------

test('createSecret emits an event-only `secret` row — value columns NULL', () => {
  const owner = createAgent({ name: 'audit-s-create', scope: 'global' }, U);
  createSecret(
    {
      agentId: owner.id,
      scope: 'global',
      envVarName: 'TOKEN',
      valuePlaintext: 'shh-secret',
    },
    U,
  );
  const rows = listAgentAudit({ agentId: owner.id, field: 'secret' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fieldRef, 'TOKEN', 'env var name lands in field_ref');
  assert.equal(rows[0].priorValue, null, 'secrets NEVER log the value');
  assert.equal(rows[0].newValue, null, 'secrets NEVER log the value');
});

test('deleteSecret emits an event-only `secret` row with the env-var name', () => {
  const owner = createAgent({ name: 'audit-s-delete', scope: 'global' }, U);
  const s = createSecret(
    {
      agentId: owner.id,
      scope: 'global',
      envVarName: 'OLD_TOKEN',
      valuePlaintext: 'v',
    },
    U,
  );
  deleteSecret(s.id, U);
  const rows = listAgentAudit({ agentId: owner.id, field: 'secret' });
  // newest-first → [delete, create]
  assert.equal(rows[0].fieldRef, 'OLD_TOKEN');
  assert.equal(rows[0].priorValue, null);
  assert.equal(rows[0].newValue, null);
});

// --- mcp servers ------------------------------------------------------------

test('createMcpServer emits an `mcp_server` row with config snapshot', () => {
  const owner = createAgent({ name: 'audit-m-create', scope: 'global' }, U);
  createMcpServer(
    {
      agentId: owner.id,
      scope: 'global',
      name: 'jira',
      config: { command: 'jira-mcp', env: { HOST: 'example.com' } },
    },
    U,
  );
  const rows = listAgentAudit({ agentId: owner.id, field: 'mcp_server' });
  assert.equal(rows[0].fieldRef, 'jira');
  const snap = JSON.parse(rows[0].newValue!);
  assert.equal(snap.name, 'jira');
  assert.deepEqual(snap.config, { command: 'jira-mcp', env: { HOST: 'example.com' } });
});

test('deleteMcpServer emits an `mcp_server` row with prior_value only', () => {
  const owner = createAgent({ name: 'audit-m-delete', scope: 'global' }, U);
  const m = createMcpServer(
    {
      agentId: owner.id,
      scope: 'global',
      name: 'gmail',
      config: { command: 'gmail-mcp' },
    },
    U,
  );
  deleteMcpServer(m.id, U);
  const rows = listAgentAudit({ agentId: owner.id, field: 'mcp_server' });
  // newest-first → [delete, create]
  assert.equal(rows[0].fieldRef, 'gmail');
  assert.equal(rows[0].newValue, null);
  const prior = JSON.parse(rows[0].priorValue!);
  assert.equal(prior.config.command, 'gmail-mcp');
});

// --- listAgentAudit filters + ordering --------------------------------------

test('listAgentAudit returns newest-first across all fields', () => {
  const a = createAgent({ name: 'audit-list-order', scope: 'global' }, U);
  createKnowledge({ agentId: a.id, scope: 'global', name: 'a', content: '1' }, U);
  createKnowledge({ agentId: a.id, scope: 'global', name: 'b', content: '2' }, U);
  updateAgent(a.id, { prompt: 'changed' }, U);
  const rows = listAgentAudit({ agentId: a.id });
  // most-recent should be the prompt update; oldest should be `created`
  assert.equal(rows[0].field, 'prompt');
  assert.equal(rows[rows.length - 1].field, 'created');
});

test('listAgentAudit filters by actor', () => {
  const a = createAgent({ name: 'audit-list-actor', scope: 'global' }, U);
  updateAgent(a.id, { prompt: 'orch-1' }, ORCH);
  updateAgent(a.id, { prompt: 'user-1' }, U);
  updateAgent(a.id, { prompt: 'orch-2' }, ORCH);
  const orch = listAgentAudit({ agentId: a.id, actor: 'orchestrator' });
  const user = listAgentAudit({ agentId: a.id, actor: 'user' });
  // 2 orchestrator prompt updates
  assert.equal(orch.filter((r) => r.field === 'prompt').length, 2);
  // 1 user prompt update + 1 user 'created' row
  assert.equal(user.filter((r) => r.field === 'prompt').length, 1);
  assert.equal(user.filter((r) => r.field === 'created').length, 1);
});

test('listAgentAudit respects limit', () => {
  const a = createAgent({ name: 'audit-list-limit', scope: 'global' }, U);
  for (let i = 0; i < 5; i++) updateAgent(a.id, { prompt: `v${i}` }, U);
  const rows = listAgentAudit({ agentId: a.id, limit: 3 });
  assert.equal(rows.length, 3);
});
