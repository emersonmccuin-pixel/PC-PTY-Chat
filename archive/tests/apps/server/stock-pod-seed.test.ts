// Section 17e.1 unit tests — stock pod boot-time seed.
//
// Verifies the idempotency contract for the stock seed: a fresh DB inserts
// every stock row; a second call is a no-op; non-user-edited drift is
// reseeded; user-authored changes are preserved.
//
// Run via:  pnpm --filter @pc/server test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDataDir = mkdtempSync(join(tmpdir(), 'pc-stock-seed-db-'));
process.env.PC_DATA_DIR = tmpDataDir;

const {
  closeDb,
  runMigrations,
  getAgentByName,
  listAgentAudit,
  listAgents,
  listKnowledge,
  updateAgent,
  updateKnowledge,
} = await import('@pc/db');
import type { ULID } from '@pc/domain';
import {
  CAISSON_KNOWLEDGE_DOCS,
  STOCK_POD_CONTENT,
  seedStockPods,
} from '../src/services/stock-pod-seed.ts';

const STOCK_POD_NAMES = STOCK_POD_CONTENT.map((p) => p.name);

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

test('first call on empty DB inserts every stock pod row and caisson knowledge docs', () => {
  for (const name of STOCK_POD_NAMES) {
    assert.equal(
      getAgentByName({ name, scope: 'global' }),
      null,
      `${name} should not be live before the seed`,
    );
  }

  const result = seedStockPods();
  assert.equal(result.insertedCount, STOCK_POD_NAMES.length);
  assert.equal(result.knowledgeInsertedCount, CAISSON_KNOWLEDGE_DOCS.length);
  assert.equal(result.knowledgeReseededCount, 0);
  assert.equal(result.knowledgeSkippedCount, 0);
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

    // One agent audit row per pod, plus caisson's seeded knowledge docs.
    const audit = listAgentAudit({ agentId: row!.id });
    const expectedAuditCount =
      content.name === 'caisson' ? 1 + CAISSON_KNOWLEDGE_DOCS.length : 1;
    assert.equal(
      audit.length,
      expectedAuditCount,
      `${content.name}: expected seed audit rows`,
    );
    const created = audit.find((r) => r.field === 'created');
    assert.ok(created, `${content.name}: created audit row should exist`);
    assert.equal(created.actor, 'orchestrator');
    assert.ok(
      created.reason?.startsWith('system-seed:17e'),
      `${content.name}: audit reason should be a 17e system-seed marker, got: ${created.reason}`,
    );

    if (content.name === 'caisson') {
      const knowledge = listKnowledge({ agentId: row!.id, scope: 'global' });
      assert.equal(knowledge.length, CAISSON_KNOWLEDGE_DOCS.length);
      assert.deepEqual(
        knowledge.map((k) => k.name),
        [...CAISSON_KNOWLEDGE_DOCS.map((d) => d.name)].sort(),
      );
      for (const doc of CAISSON_KNOWLEDGE_DOCS) {
        const rowDoc = knowledge.find((k) => k.name === doc.name);
        assert.ok(rowDoc, `${doc.name} should be seeded`);
        assert.equal(rowDoc!.content, doc.content.trim());
      }
    }
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
  assert.equal(result.knowledgeInsertedCount, 0);
  assert.equal(result.knowledgeReseededCount, 0);
  assert.equal(result.knowledgeSkippedCount, 0);
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
    const expectedAuditCount = row.name === 'caisson' ? 1 + CAISSON_KNOWLEDGE_DOCS.length : 1;
    assert.equal(
      audit.length,
      expectedAuditCount,
      `${row.name}: no new audit rows from the no-op call`,
    );
  }
});

test('caisson stock knowledge auto-reseeds when source-owned content drifts', () => {
  const live = getAgentByName({ name: 'caisson', scope: 'global' });
  assert.ok(live, 'caisson pod should be live from prior tests');
  const doc = listKnowledge({ agentId: live!.id, scope: 'global' }).find(
    (k) => k.name === 'caisson-navigation-guide',
  );
  assert.ok(doc, 'navigation guide should be seeded');

  updateKnowledge(
    doc!.id,
    { content: '<<stale source-owned navigation guide>>' },
    { actor: 'orchestrator', reason: 'system-seed:test-knowledge-drift-fixture' },
  );

  const result = seedStockPods();
  assert.equal(result.knowledgeReseededCount, 1);
  assert.equal(result.knowledgeSkippedCount, 0);

  const after = listKnowledge({ agentId: live!.id, scope: 'global' }).find(
    (k) => k.name === 'caisson-navigation-guide',
  );
  const expected = CAISSON_KNOWLEDGE_DOCS.find((d) => d.name === 'caisson-navigation-guide');
  assert.equal(after!.content, expected!.content.trim());
});

test('user-edited caisson stock knowledge is left alone', () => {
  const live = getAgentByName({ name: 'caisson', scope: 'global' });
  assert.ok(live, 'caisson pod should be live from prior tests');
  const doc = listKnowledge({ agentId: live!.id, scope: 'global' }).find(
    (k) => k.name === 'caisson-product-model',
  );
  assert.ok(doc, 'product model should be seeded');

  updateKnowledge(
    doc!.id,
    { content: '<<user-customised caisson product model>>' },
    { actor: 'user', reason: 'local product wording' },
  );

  const result = seedStockPods();
  assert.equal(result.knowledgeSkippedCount, 1);

  const after = listKnowledge({ agentId: live!.id, scope: 'global' }).find(
    (k) => k.name === 'caisson-product-model',
  );
  assert.equal(after!.content, '<<user-customised caisson product model>>');
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
