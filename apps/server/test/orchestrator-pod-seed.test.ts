// Section 16a.2 unit tests — orchestrator pod boot-time seed.
//
// Verifies the idempotency contract: a fresh DB seeds the row exactly once
// (with a `created` audit attribution that names the system-seed reason); a
// DB already carrying the orchestrator row yields a no-op result on the
// second call and keeps the original audit history.
//
// Run via:  pnpm --filter @pc/server test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDataDir = mkdtempSync(join(tmpdir(), 'pc-orch-seed-db-'));
process.env.PC_DATA_DIR = tmpDataDir;

const { closeDb, runMigrations, getAgentByName, listAgentAudit, updateAgent } = await import('@pc/db');
import type { ULID } from '@pc/domain';
import { mergeRequiredAgentTools } from '@pc/domain';
import { ORCHESTRATOR_POD_CONTENT } from '../src/services/orchestrator-pod-content.ts';
import { seedOrchestratorPodIfMissing } from '../src/services/orchestrator-pod-seed.ts';

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

test('first call on empty DB inserts the orchestrator row with content from ORCHESTRATOR_POD_CONTENT', () => {
  // Fresh DB — no global orchestrator yet.
  assert.equal(getAgentByName({ name: 'orchestrator', scope: 'global' }), null);

  const result = seedOrchestratorPodIfMissing();
  assert.equal(result.seeded, true);
  assert.notEqual(result.agentId, '');

  const row = getAgentByName({ name: 'orchestrator', scope: 'global' });
  assert.ok(row, 'orchestrator row should be live post-seed');
  assert.equal(row!.id, result.agentId);
  assert.equal(row!.scope, 'global');
  assert.equal(row!.projectId, null);
  assert.equal(row!.prompt, ORCHESTRATOR_POD_CONTENT.prompt);
  // Section 26: createAgent always merges in the required work-item tools.
  assert.deepEqual(row!.tools, mergeRequiredAgentTools(ORCHESTRATOR_POD_CONTENT.tools ?? []));
  assert.equal(row!.model, ORCHESTRATOR_POD_CONTENT.model);
  assert.equal(row!.maxTurns, ORCHESTRATOR_POD_CONTENT.maxTurns);
  assert.equal(row!.outputDestination, ORCHESTRATOR_POD_CONTENT.outputDestination);
  assert.equal(row!.description, ORCHESTRATOR_POD_CONTENT.description);

  // Audit row should attribute the creation to the boot-time seed.
  const audit = listAgentAudit({ agentId: row!.id });
  assert.equal(audit.length, 1, 'exactly one audit row from the seed');
  assert.equal(audit[0].field, 'created');
  assert.equal(audit[0].actor, 'orchestrator');
  assert.ok(
    audit[0].reason?.startsWith('system-seed:'),
    `audit reason should be a system-seed marker, got: ${audit[0].reason}`,
  );
});

test('second call is a no-op when the row already exists and matches the seed', () => {
  const before = getAgentByName({ name: 'orchestrator', scope: 'global' });
  assert.ok(before, 'previous test should have left the row in place');

  const result = seedOrchestratorPodIfMissing();
  assert.equal(result.seeded, false);
  assert.equal(result.action, 'unchanged');
  assert.equal(result.agentId, before!.id);
  assert.deepEqual(result.reseededFields, []);

  // No additional audit rows.
  const audit = listAgentAudit({ agentId: before!.id });
  assert.equal(audit.length, 1, 'no new audit row from the no-op call');
});

// B3 mitigation (2026-05-20) — when ORCHESTRATOR_POD_CONTENT changes between
// installs, the seed must drift-detect + auto-reseed if no user edits exist.
test('auto-reseeds when live row drifts AND has only system-authored audit rows', () => {
  const live = getAgentByName({ name: 'orchestrator', scope: 'global' });
  assert.ok(live);

  // Simulate prior-version seed content: hand-edit the live row's prompt +
  // tools to something different from the current seed, audited as a
  // system-seed (= no user touch). After this, `seedOrchestratorPodIfMissing`
  // must restore the seed values.
  updateAgent(
    live!.id as ULID,
    { prompt: '<<old seed>>', tools: ['Read'] },
    { actor: 'orchestrator', reason: 'system-seed:older-version' },
  );

  const result = seedOrchestratorPodIfMissing();
  assert.equal(result.action, 'reseeded');
  assert.equal(result.agentId, live!.id);
  assert.deepEqual([...result.reseededFields].sort(), ['prompt', 'tools']);

  const restored = getAgentByName({ name: 'orchestrator', scope: 'global' });
  assert.equal(restored!.prompt, ORCHESTRATOR_POD_CONTENT.prompt);
  // Section 26: tools persist as the merged list (REQUIRED_AGENT_TOOLS added).
  assert.deepEqual(restored!.tools, mergeRequiredAgentTools(ORCHESTRATOR_POD_CONTENT.tools ?? []));

  // Audit log should have a reseed entry per changed field.
  const audit = listAgentAudit({ agentId: live!.id });
  const reseedRows = audit.filter((r) => r.reason?.startsWith('system-reseed:'));
  assert.equal(reseedRows.length, 2, 'one reseed audit row per drifted field');
  for (const r of reseedRows) assert.equal(r.actor, 'orchestrator');
});

test('skips reseed when live row has a user-authored audit row, even on drift', () => {
  const live = getAgentByName({ name: 'orchestrator', scope: 'global' });
  assert.ok(live);

  // Real user edit: actor='user', no system-seed reason.
  updateAgent(
    live!.id as ULID,
    { prompt: '<<user-customised orchestrator prompt>>' },
    { actor: 'user', reason: 'tweaking the voice' },
  );

  const result = seedOrchestratorPodIfMissing();
  assert.equal(result.action, 'skipped-user-edited');
  assert.deepEqual(result.reseededFields, ['prompt']);

  // Row content stays as the user left it.
  const after = getAgentByName({ name: 'orchestrator', scope: 'global' });
  assert.equal(after!.prompt, '<<user-customised orchestrator prompt>>');
});
