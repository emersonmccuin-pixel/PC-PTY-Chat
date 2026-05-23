// Section 17e.1 unit tests — stock pod boot-time seed.
//
// Verifies the idempotency contract for the 5-pod stock seed: a fresh DB
// inserts all 5 rows (each with a `created` audit row attributing the
// system-seed reason); a second call is a no-op (0 inserts, 5 rows total,
// no extra audit rows); pre-existing rows are never overwritten regardless
// of content drift.
//
// Run via:  pnpm --filter @pc/server test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDataDir = mkdtempSync(join(tmpdir(), 'pc-stock-seed-db-'));
process.env.PC_DATA_DIR = tmpDataDir;

const { closeDb, runMigrations, getAgentByName, listAgentAudit, updateAgent, listAgents } =
  await import('@pc/db');
import type { ULID } from '@pc/domain';
import { STOCK_POD_CONTENT, seedStockPods } from '../src/services/stock-pod-seed.ts';

const STOCK_POD_NAMES = STOCK_POD_CONTENT.map((p) => p.name);

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

test('first call on empty DB inserts all 7 stock pod rows', () => {
  for (const name of STOCK_POD_NAMES) {
    assert.equal(
      getAgentByName({ name, scope: 'global' }),
      null,
      `${name} should not be live before the seed`,
    );
  }

  const result = seedStockPods();
  assert.equal(result.insertedCount, STOCK_POD_NAMES.length);
  assert.equal(result.entries.length, STOCK_POD_NAMES.length);
  for (const entry of result.entries) {
    assert.equal(entry.action, 'inserted', `${entry.name} should be inserted on fresh DB`);
    assert.notEqual(entry.agentId, '');
  }

  // Each row landed with content matching its source const.
  for (const content of STOCK_POD_CONTENT) {
    const row = getAgentByName({ name: content.name, scope: 'global' });
    assert.ok(row, `${content.name} should be live post-seed`);
    assert.equal(row!.scope, 'global');
    assert.equal(row!.projectId, null);
    assert.equal(row!.prompt, content.prompt);
    assert.deepEqual(row!.tools, content.tools);
    assert.equal(row!.model, content.model);
    assert.equal(row!.effort, content.effort);
    assert.equal(row!.maxTurns, content.maxTurns);
    assert.equal(row!.outputDestination, content.outputDestination);
    assert.equal(row!.description, content.description);

    // One audit row per pod, attributing the boot-time seed.
    const audit = listAgentAudit({ agentId: row!.id });
    assert.equal(audit.length, 1, `${content.name}: exactly one audit row from the seed`);
    assert.equal(audit[0].field, 'created');
    assert.equal(audit[0].actor, 'orchestrator');
    assert.ok(
      audit[0].reason?.startsWith('system-seed:17e'),
      `${content.name}: audit reason should be a 17e system-seed marker, got: ${audit[0].reason}`,
    );
  }
});

test('second call is a no-op — 0 inserts, full roster present, no extra audit rows', () => {
  const expected = STOCK_POD_NAMES.length;
  const rowsBefore = listAgents({ scope: 'global' });
  const stockRowsBefore = rowsBefore.filter((r) => STOCK_POD_NAMES.includes(r.name));
  assert.equal(
    stockRowsBefore.length,
    expected,
    `previous test should have left exactly ${expected} stock rows in place`,
  );

  const result = seedStockPods();
  assert.equal(result.insertedCount, 0);
  assert.equal(result.entries.length, expected);
  for (const entry of result.entries) {
    assert.equal(entry.action, 'unchanged', `${entry.name} should be unchanged on second call`);
  }

  // No new rows.
  const rowsAfter = listAgents({ scope: 'global' });
  const stockRowsAfter = rowsAfter.filter((r) => STOCK_POD_NAMES.includes(r.name));
  assert.equal(stockRowsAfter.length, expected, `still exactly ${expected} stock rows after no-op call`);

  // No extra audit rows on any pod.
  for (const row of stockRowsAfter) {
    const audit = listAgentAudit({ agentId: row.id });
    assert.equal(audit.length, 1, `${row.name}: no new audit rows from the no-op call`);
  }
});

// User-edited rows are protected — drift is reported (skipped-user-edited)
// but the live row is left intact.
test('user-edited row is left alone — drift is reported, but the user prompt survives', () => {
  const live = getAgentByName({ name: 'writer', scope: 'global' });
  assert.ok(live, 'writer pod should be live from prior tests');

  updateAgent(
    live!.id as ULID,
    { prompt: '<<user-customised writer prompt>>' },
    { actor: 'user', reason: 'tightening up the voice' },
  );

  const result = seedStockPods();
  const writerEntry = result.entries.find((e) => e.name === 'writer');
  assert.ok(writerEntry);
  assert.equal(writerEntry!.action, 'skipped-user-edited');
  assert.ok(
    writerEntry!.reseededFields.includes('prompt'),
    'prompt should be reported as drifted',
  );
  assert.equal(result.skippedCount, 1);

  const after = getAgentByName({ name: 'writer', scope: 'global' });
  assert.equal(after!.prompt, '<<user-customised writer prompt>>');
});

// Non-user-edited rows pick up source drift automatically.
test('non-user-edited row gets auto-reseeded when source drifts', () => {
  const live = getAgentByName({ name: 'extractor', scope: 'global' });
  assert.ok(live, 'extractor pod should be live from prior tests');

  // Simulate prior source content by mutating the live row using a
  // system-authored audit reason — leaves `hasUserAuthoredEdit` returning
  // false.
  updateAgent(
    live!.id as ULID,
    { prompt: '<<stale prior-source prompt>>' },
    { actor: 'orchestrator', reason: 'system-seed:test-drift-fixture' },
  );

  const result = seedStockPods();
  const extractorEntry = result.entries.find((e) => e.name === 'extractor');
  assert.ok(extractorEntry);
  assert.equal(extractorEntry!.action, 'reseeded');
  assert.ok(
    extractorEntry!.reseededFields.includes('prompt'),
    'prompt should be in the reseeded fields list',
  );

  const after = getAgentByName({ name: 'extractor', scope: 'global' });
  const expected = STOCK_POD_CONTENT.find((p) => p.name === 'extractor');
  assert.equal(after!.prompt, expected!.prompt, 'live row should match the current source');
});
