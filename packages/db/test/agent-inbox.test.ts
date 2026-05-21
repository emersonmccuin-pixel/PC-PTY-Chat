// Section 18.2 — agent_inbox + agent_delivery_audit repo round-trip. Pins
// the contract the hybrid emit (18.3) + UserPromptSubmit drain (18.4) will
// call into.
//
// Run via:  pnpm --filter @pc/db test
// Or:       pnpm test:unit  (from repo root)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-db-inbox-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  enqueueInboxRow,
  getAuditForInbox,
  getInboxRow,
  listPendingForSession,
  markInboxDelivered,
  recordChannelPushAttempt,
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

test('enqueueInboxRow writes inbox row + stub audit row in one transaction', () => {
  const p = createProject({ slug: 'inbox-rt', name: 'Inbox RT', stages, folderPath: tmpDir });

  const row = enqueueInboxRow({
    projectId: p.id as ULID,
    recipientSessionId: 'sess-orchestrator-1',
    eventKind: 'agent-completed',
    payloadBody: '<channel source="agent">child done</channel>',
    now: 1700_000_000_000,
  });

  assert.equal(row.status, 'pending');
  assert.equal(row.deliveredAt, null);
  assert.equal(row.eventKind, 'agent-completed');

  const fetched = getInboxRow(row.id);
  assert.ok(fetched);
  assert.equal(fetched!.payloadBody, '<channel source="agent">child done</channel>');

  const audit = getAuditForInbox(row.id);
  assert.ok(audit);
  assert.equal(audit!.driver, 'unknown');
  assert.equal(audit!.channelPushAttemptedAt, null);
  assert.equal(audit!.channelPushSucceeded, null);
  assert.equal(audit!.hookDrainedAt, null);
});

test('listPendingForSession returns pending rows oldest-first; skips delivered', () => {
  const p = createProject({ slug: 'inbox-list', name: 'Inbox List', stages, folderPath: tmpDir });
  const sess = 'sess-orchestrator-2';

  const a = enqueueInboxRow({
    projectId: p.id as ULID,
    recipientSessionId: sess,
    eventKind: 'agent-acked',
    payloadBody: 'a',
    now: 1700_000_000_001,
  });
  const b = enqueueInboxRow({
    projectId: p.id as ULID,
    recipientSessionId: sess,
    eventKind: 'agent-completed',
    payloadBody: 'b',
    now: 1700_000_000_002,
  });
  const c = enqueueInboxRow({
    projectId: p.id as ULID,
    recipientSessionId: sess,
    eventKind: 'agent-failed',
    payloadBody: 'c',
    now: 1700_000_000_003,
  });

  // Different session — must NOT appear in this session's pending list.
  enqueueInboxRow({
    projectId: p.id as ULID,
    recipientSessionId: 'sess-other',
    eventKind: 'agent-completed',
    payloadBody: 'noise',
    now: 1700_000_000_004,
  });

  // Deliver middle row; only outer two should remain pending.
  markInboxDelivered({
    inboxId: b.id,
    deliveredAt: 1700_000_000_010,
    driver: 'autonomous',
  });

  const pending = listPendingForSession(sess);
  assert.deepEqual(
    pending.map((r) => r.id),
    [a.id, c.id],
    'pending list should be a + c in created order',
  );
});

test('recordChannelPushAttempt + markInboxDelivered (autonomous driver) round-trip', () => {
  const p = createProject({ slug: 'inbox-auto', name: 'Inbox Auto', stages, folderPath: tmpDir });
  const row = enqueueInboxRow({
    projectId: p.id as ULID,
    recipientSessionId: 'sess-auto',
    eventKind: 'agent-asks-orchestrator',
    payloadBody: 'question?',
    now: 1700_000_001_000,
  });

  recordChannelPushAttempt({
    inboxId: row.id,
    attemptedAt: 1700_000_001_005,
    succeeded: true,
  });

  const flipped = markInboxDelivered({
    inboxId: row.id,
    deliveredAt: 1700_000_001_010,
    driver: 'autonomous',
  });
  assert.equal(flipped, true);

  const stored = getInboxRow(row.id);
  assert.equal(stored!.status, 'delivered');
  assert.equal(stored!.deliveredAt, 1700_000_001_010);

  const audit = getAuditForInbox(row.id);
  assert.equal(audit!.channelPushAttemptedAt, 1700_000_001_005);
  assert.equal(audit!.channelPushSucceeded, true);
  assert.equal(audit!.driver, 'autonomous');
  assert.equal(audit!.hookDrainedAt, null);
});

test('markInboxDelivered records user-prompt driver + hookDrainedAt for hook drains', () => {
  const p = createProject({ slug: 'inbox-hook', name: 'Inbox Hook', stages, folderPath: tmpDir });
  const row = enqueueInboxRow({
    projectId: p.id as ULID,
    recipientSessionId: 'sess-hook',
    eventKind: 'agent-completed',
    payloadBody: 'done',
    now: 1700_000_002_000,
  });

  // Channel push attempted but failed (e.g. registrant collision).
  recordChannelPushAttempt({
    inboxId: row.id,
    attemptedAt: 1700_000_002_005,
    succeeded: false,
  });

  const flipped = markInboxDelivered({
    inboxId: row.id,
    deliveredAt: 1700_000_002_500,
    driver: 'user-prompt',
    hookDrainedAt: 1700_000_002_500,
  });
  assert.equal(flipped, true);

  const audit = getAuditForInbox(row.id);
  assert.equal(audit!.driver, 'user-prompt');
  assert.equal(audit!.hookDrainedAt, 1700_000_002_500);
  assert.equal(audit!.channelPushSucceeded, false);
});

test('markInboxDelivered is idempotent — second call against delivered row returns false', () => {
  const p = createProject({ slug: 'inbox-idem', name: 'Inbox Idem', stages, folderPath: tmpDir });
  const row = enqueueInboxRow({
    projectId: p.id as ULID,
    recipientSessionId: 'sess-idem',
    eventKind: 'agent-completed',
    payloadBody: 'once',
    now: 1700_000_003_000,
  });

  const first = markInboxDelivered({
    inboxId: row.id,
    deliveredAt: 1700_000_003_010,
    driver: 'autonomous',
  });
  const second = markInboxDelivered({
    inboxId: row.id,
    deliveredAt: 1700_000_003_020,
    driver: 'user-prompt',
    hookDrainedAt: 1700_000_003_020,
  });

  assert.equal(first, true);
  assert.equal(second, false, 'second drain attempt must no-op');

  const audit = getAuditForInbox(row.id);
  assert.equal(audit!.driver, 'autonomous', 'driver from winning drain stays');
  assert.equal(audit!.hookDrainedAt, null, 'losing drain must not overwrite audit fields');
});
