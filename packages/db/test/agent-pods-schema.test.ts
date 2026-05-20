// Section 17a.1 schema smoke — pod tables land via runMigrations against a
// fresh DB and accept basic round-trip inserts. Constraint coverage:
//
// - agents: per-scope unique-name partial indices (global vs project).
// - agent_knowledge / agent_secrets / agent_mcp_servers: unique on
//   (agent_id, scope, project_id, <discriminator>).
// - agent_audit: append-only; multi-row insert preserves change_set_id grouping.
//
// Smoke only — repository layer + audit-on-mutate are 17a.2/17a.4.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-db-pods-'));
process.env.PC_DATA_DIR = tmpDir;

const { getDb, closeDb, runMigrations, newId } = await import('../src/index.ts');
const { agents, agentKnowledge, agentSecrets, agentMcpServers, agentAudit } = await import(
  '../src/schema.ts'
);
import type { ULID } from '@pc/domain';

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function now(): number {
  return Date.now();
}

function makeAgent(overrides: Partial<typeof agents.$inferInsert> = {}) {
  const id = newId() as ULID;
  const t = now();
  return {
    id,
    name: `agent-${id.slice(-6).toLowerCase()}`,
    scope: 'global' as const,
    projectId: null,
    prompt: 'You are a test agent.',
    tools: [],
    model: null,
    effort: null,
    maxTurns: null,
    outputDestination: null,
    description: 'test',
    createdAt: t,
    updatedAt: t,
    deletedAt: null,
    ...overrides,
  };
}

test('all five pod tables exist after migration', () => {
  const db = getDb();
  // Probe each table with an empty select — throws if the table is missing.
  assert.doesNotThrow(() => db.select().from(agents).all());
  assert.doesNotThrow(() => db.select().from(agentKnowledge).all());
  assert.doesNotThrow(() => db.select().from(agentSecrets).all());
  assert.doesNotThrow(() => db.select().from(agentMcpServers).all());
  assert.doesNotThrow(() => db.select().from(agentAudit).all());
});

test('agents insert + select round-trips JSON tools + scalar settings', () => {
  const db = getDb();
  const row = makeAgent({
    name: 'researcher',
    tools: ['Read', 'Grep', 'mcp__pc-rig__pc_knowledge_read'],
    model: 'sonnet',
    effort: 'medium',
    maxTurns: 50,
    outputDestination: 'attachment',
    description: 'Reads the codebase.',
  });
  db.insert(agents).values(row).run();
  const got = db.select().from(agents).where(eq(agents.id, row.id)).get();
  assert.ok(got);
  assert.equal(got.name, 'researcher');
  assert.deepEqual(got.tools, ['Read', 'Grep', 'mcp__pc-rig__pc_knowledge_read']);
  assert.equal(got.model, 'sonnet');
  assert.equal(got.effort, 'medium');
  assert.equal(got.maxTurns, 50);
  assert.equal(got.outputDestination, 'attachment');
  assert.equal(got.scope, 'global');
  assert.equal(got.projectId, null);
});

test('agents unique-name partial index blocks dup global name (live rows)', () => {
  const db = getDb();
  const a = makeAgent({ name: 'writer' });
  const b = makeAgent({ name: 'writer' });
  db.insert(agents).values(a).run();
  assert.throws(() => db.insert(agents).values(b).run(), /UNIQUE constraint/);
});

test('agents unique-name partial index ignores soft-deleted rows', () => {
  const db = getDb();
  const a = makeAgent({ name: 'planner', deletedAt: now() });
  const b = makeAgent({ name: 'planner' });
  db.insert(agents).values(a).run();
  // The live `b` can coexist with the soft-deleted `a` because the partial
  // index only watches `deleted_at IS NULL`.
  assert.doesNotThrow(() => db.insert(agents).values(b).run());
});

test('agents global vs project namespaces are independent', () => {
  const db = getDb();
  const projectId = newId() as ULID;
  const g = makeAgent({ name: 'reviewer' });
  const p = makeAgent({ name: 'reviewer', scope: 'project', projectId });
  db.insert(agents).values(g).run();
  assert.doesNotThrow(() => db.insert(agents).values(p).run());
});

test('agent_knowledge unique-name within (agent, scope, project_id)', () => {
  const db = getDb();
  const owner = makeAgent({ name: 'kb-owner' });
  db.insert(agents).values(owner).run();
  const t = now();
  const k1 = {
    id: newId() as ULID,
    agentId: owner.id,
    scope: 'global' as const,
    projectId: null,
    name: 'style-guide',
    kind: 'knowledge' as const,
    content: '# Style guide\n',
    createdAt: t,
    updatedAt: t,
  };
  db.insert(agentKnowledge).values(k1).run();
  const k2 = { ...k1, id: newId() as ULID };
  assert.throws(() => db.insert(agentKnowledge).values(k2).run(), /UNIQUE constraint/);
});

test('agent_secrets stores plaintext value + unique on env_var_name', () => {
  const db = getDb();
  const owner = makeAgent({ name: 'secret-owner' });
  db.insert(agents).values(owner).run();
  const s1 = {
    id: newId() as ULID,
    agentId: owner.id,
    scope: 'global' as const,
    projectId: null,
    envVarName: 'OPENAI_API_KEY',
    valuePlaintext: 'sk-test-123',
    createdAt: now(),
  };
  db.insert(agentSecrets).values(s1).run();
  const got = db.select().from(agentSecrets).where(eq(agentSecrets.id, s1.id)).get();
  assert.ok(got);
  assert.equal(got.valuePlaintext, 'sk-test-123');
  const dup = { ...s1, id: newId() as ULID };
  assert.throws(() => db.insert(agentSecrets).values(dup).run(), /UNIQUE constraint/);
});

test('agent_mcp_servers config_json round-trips inline server shape', () => {
  const db = getDb();
  const owner = makeAgent({ name: 'mcp-owner' });
  db.insert(agents).values(owner).run();
  const cfg = {
    command: 'node',
    args: ['./server.mjs'],
    env: { LOG_LEVEL: 'debug' },
  };
  const m = {
    id: newId() as ULID,
    agentId: owner.id,
    scope: 'global' as const,
    projectId: null,
    name: 'pc-rig',
    config: cfg,
    createdAt: now(),
  };
  db.insert(agentMcpServers).values(m).run();
  const got = db.select().from(agentMcpServers).where(eq(agentMcpServers.id, m.id)).get();
  assert.ok(got);
  assert.deepEqual(got.config, cfg);
});

test('agent_audit accepts change_set_id grouping + scalar + ref rows', () => {
  const db = getDb();
  const owner = makeAgent({ name: 'audit-owner' });
  db.insert(agents).values(owner).run();
  const changeSetId = newId() as ULID;
  const t = now();
  db.insert(agentAudit)
    .values([
      {
        id: newId() as ULID,
        agentId: owner.id,
        changeSetId,
        actor: 'orchestrator',
        field: 'prompt',
        fieldRef: null,
        priorValue: 'old prompt',
        newValue: 'new prompt',
        reason: 'tune wording',
        createdAt: t,
      },
      {
        id: newId() as ULID,
        agentId: owner.id,
        changeSetId,
        actor: 'orchestrator',
        field: 'knowledge',
        fieldRef: 'style-guide',
        priorValue: null,
        newValue: '# new style\n',
        reason: null,
        createdAt: t,
      },
      {
        // Secret event-only: value columns NULL even on creation.
        id: newId() as ULID,
        agentId: owner.id,
        changeSetId: null,
        actor: 'user',
        field: 'secret',
        fieldRef: 'OPENAI_API_KEY',
        priorValue: null,
        newValue: null,
        reason: null,
        createdAt: t,
      },
    ])
    .run();
  const grouped = db.select().from(agentAudit).where(eq(agentAudit.changeSetId, changeSetId)).all();
  assert.equal(grouped.length, 2);
  const all = db.select().from(agentAudit).where(eq(agentAudit.agentId, owner.id)).all();
  assert.equal(all.length, 3);
  const secret = all.find((r) => r.field === 'secret');
  assert.ok(secret);
  assert.equal(secret.priorValue, null);
  assert.equal(secret.newValue, null);
});

// Local import of `eq` to avoid bumping the file header — drizzle expression
// builder isn't re-exported from @pc/db.
import { eq } from 'drizzle-orm';
