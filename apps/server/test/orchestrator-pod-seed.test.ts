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

const { closeDb, runMigrations, getAgentByName, listAgentAudit } = await import('@pc/db');
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
  assert.deepEqual(row!.tools, ORCHESTRATOR_POD_CONTENT.tools);
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

test('second call is a no-op when the row already exists', () => {
  const before = getAgentByName({ name: 'orchestrator', scope: 'global' });
  assert.ok(before, 'previous test should have left the row in place');

  const result = seedOrchestratorPodIfMissing();
  assert.equal(result.seeded, false);
  assert.equal(result.agentId, before!.id);

  // No additional audit rows.
  const audit = listAgentAudit({ agentId: before!.id });
  assert.equal(audit.length, 1, 'no new audit row from the no-op call');
});
