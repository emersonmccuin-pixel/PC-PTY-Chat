// Section 25 Session 7 — agent_inbox_v2 repo round-trip. Pins the contract
// the v2 delivery service (apps/server/src/services/v2/delivery.ts) calls
// into. Mirrors v1's agent-inbox.test.ts shape against the v2 tables.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-db-inbox-v2-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  enqueueInboxRowV2,
  getAuditForInboxV2,
  getInboxRowV2,
  listPendingForSessionV2,
  markInboxDeliveredV2,
} = await import('../src/index.ts');
import type { Stage, ULID } from '@pc/domain';

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('enqueueInboxRowV2 writes a pending row with NULL driver', () => {
  const p = createProject({ slug: 'inbox-v2-rt', name: 'Inbox V2 RT', stages, folderPath: tmpDir });

  const row = enqueueInboxRowV2({
    projectId: p.id as ULID,
    pcSessionId: 'sess-orchestrator-1',
    kind: 'agent-completed',
    body: '<channel source="agent">child done</channel>',
    now: 1700_000_000_000,
  });

  assert.equal(row.status, 'pending');
  assert.equal(row.driver, null);
  assert.equal(row.deliveredAt, null);
  assert.equal(row.kind, 'agent-completed');

  const fetched = getInboxRowV2(row.id);
  assert.ok(fetched);
  assert.equal(fetched!.body, '<channel source="agent">child done</channel>');

  // v2 contract: audit row is NOT stubbed at enqueue (one row per successful
  // delivery, written at flip time).
  assert.equal(getAuditForInboxV2(row.id), null);
});

test('markInboxDeliveredV2 flips pending → delivered + writes audit row', () => {
  const p = createProject({ slug: 'inbox-v2-flip', name: 'Flip', stages, folderPath: tmpDir });

  const row = enqueueInboxRowV2({
    projectId: p.id as ULID,
    pcSessionId: 'sess-orchestrator-2',
    kind: 'agent-asks-orchestrator',
    body: '<channel source="agent">question</channel>',
    now: 1700_000_000_000,
  });

  const flipped = markInboxDeliveredV2({
    inboxId: row.id,
    deliveredAt: 1700_000_005_000,
    driver: 'channel',
  });
  assert.equal(flipped, true);

  const post = getInboxRowV2(row.id);
  assert.equal(post!.status, 'delivered');
  assert.equal(post!.driver, 'channel');
  assert.equal(post!.deliveredAt, 1700_000_005_000);

  const audit = getAuditForInboxV2(row.id);
  assert.ok(audit);
  assert.equal(audit!.driver, 'channel');
  assert.equal(audit!.deliveredAt, 1700_000_005_000);
  assert.equal(audit!.latencyMs, 5_000);
});

test('markInboxDeliveredV2 is idempotent — second flip returns false + no duplicate audit', () => {
  const p = createProject({ slug: 'inbox-v2-idem', name: 'Idem', stages, folderPath: tmpDir });

  const row = enqueueInboxRowV2({
    projectId: p.id as ULID,
    pcSessionId: 'sess-orch-3',
    kind: 'agent-failed',
    body: 'b',
    now: 1700_000_000_000,
  });

  assert.equal(
    markInboxDeliveredV2({
      inboxId: row.id,
      deliveredAt: 1700_000_001_000,
      driver: 'channel',
    }),
    true,
  );
  assert.equal(
    markInboxDeliveredV2({
      inboxId: row.id,
      deliveredAt: 1700_000_002_000,
      driver: 'user-prompt',
    }),
    false,
  );

  // Driver + deliveredAt remain at the first flip's values.
  const post = getInboxRowV2(row.id);
  assert.equal(post!.driver, 'channel');
  assert.equal(post!.deliveredAt, 1700_000_001_000);

  // Exactly one audit row exists (single-row read returns the only one).
  const audit = getAuditForInboxV2(row.id);
  assert.ok(audit);
  assert.equal(audit!.driver, 'channel');
});

test('listPendingForSessionV2 returns oldest-first + skips delivered rows', () => {
  const p = createProject({ slug: 'inbox-v2-list', name: 'List', stages, folderPath: tmpDir });
  const session = 'sess-list-target';

  const rowA = enqueueInboxRowV2({
    projectId: p.id as ULID,
    pcSessionId: session,
    kind: 'agent-completed',
    body: 'A',
    now: 1700_000_000_000,
  });
  const rowB = enqueueInboxRowV2({
    projectId: p.id as ULID,
    pcSessionId: session,
    kind: 'agent-failed',
    body: 'B',
    now: 1700_000_001_000,
  });
  enqueueInboxRowV2({
    projectId: p.id as ULID,
    pcSessionId: 'other-session',
    kind: 'agent-completed',
    body: 'C',
    now: 1700_000_002_000,
  });

  const pending = listPendingForSessionV2(session);
  assert.equal(pending.length, 2);
  assert.equal(pending[0].id, rowA.id);
  assert.equal(pending[1].id, rowB.id);

  // Flip A; only B remains.
  markInboxDeliveredV2({
    inboxId: rowA.id,
    deliveredAt: 1700_000_003_000,
    driver: 'user-prompt',
  });
  const after = listPendingForSessionV2(session);
  assert.equal(after.length, 1);
  assert.equal(after[0].id, rowB.id);
});
