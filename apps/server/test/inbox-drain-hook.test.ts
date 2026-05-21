// Section 18.4 — UserPromptSubmit hook drain. Exercises the
// `templates/.claude/hooks/inbox-drain.cjs` script's `drainInbox` +
// `renderPreamble` exports against the real `@pc/db` (temp data dir).
//
// Direct CommonJS require of the .cjs is safe: top-level placeholders are
// only used inside `main()`, which is gated on `require.main === module`.
//
// Run via:  pnpm --filter @pc/server test
// Or:       pnpm test:unit  (from repo root)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-server-inbox-drain-'));
process.env.PC_DATA_DIR = tmpDir;
delete process.env.PC_DELIVERY_TRANSPORT;

const {
  closeDb,
  runMigrations,
  createProject,
  enqueueInboxRow,
  getInboxRow,
  getAuditForInbox,
} = await import('@pc/db');

import type { Stage, ULID } from '@pc/domain';

const TRUNK_ROOT = join(import.meta.dirname, '..', '..', '..');
const DB_PATH = join(tmpDir, 'pc.sqlite');

// The hook script lives in templates/.claude/hooks/. require() it via a
// CommonJS bridge — TypeScript's import would mishandle the .cjs.
const requireCjs = createRequire(import.meta.url);
const hook = requireCjs('../../../templates/.claude/hooks/inbox-drain.cjs') as {
  drainInbox: (opts: {
    dbPath: string;
    trunkPath: string;
    sessionId: string;
    now: number;
  }) => { rows: Array<{ id: string; eventKind: string; payloadBody: string }>; drained: number };
  renderPreamble: (
    rows: Array<{ id: string; eventKind: string; payloadBody: string }>,
    slug: string,
  ) => string;
};

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

const SESSION_ORCH = 'sess-drain-hook';
let projectId: ULID;
let slug: string;

before(() => {
  runMigrations();
  const p = createProject({
    slug: 'drain-hook',
    name: 'Drain Hook',
    stages,
    folderPath: tmpDir,
  });
  projectId = p.id as ULID;
  slug = p.slug;
});

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('drainInbox: returns empty when no pending rows', () => {
  const result = hook.drainInbox({
    dbPath: DB_PATH,
    trunkPath: TRUNK_ROOT,
    sessionId: 'no-rows-session',
    now: Date.now(),
  });
  assert.equal(result.drained, 0);
  assert.deepEqual(result.rows, []);
});

test('drainInbox: flips pending rows to delivered with driver=user-prompt', () => {
  const row1 = enqueueInboxRow({
    projectId,
    recipientSessionId: SESSION_ORCH,
    eventKind: 'agent-completed',
    payloadBody: '[pc:agent-event kind=agent-completed version=1]\n[runId: 01]\nResult: one',
    now: Date.now() - 200,
  });
  const row2 = enqueueInboxRow({
    projectId,
    recipientSessionId: SESSION_ORCH,
    eventKind: 'agent-failed',
    payloadBody: '[pc:agent-event kind=agent-failed version=1]\n[runId: 02]\nFailure: two',
    now: Date.now() - 100,
  });

  const now = Date.now();
  const result = hook.drainInbox({
    dbPath: DB_PATH,
    trunkPath: TRUNK_ROOT,
    sessionId: SESSION_ORCH,
    now,
  });

  assert.equal(result.drained, 2);
  assert.equal(result.rows.length, 2);
  // Oldest first.
  assert.equal(result.rows[0]!.id, row1.id);
  assert.equal(result.rows[1]!.id, row2.id);
  assert.equal(result.rows[0]!.eventKind, 'agent-completed');

  const r1 = getInboxRow(row1.id);
  const r2 = getInboxRow(row2.id);
  assert.equal(r1!.status, 'delivered');
  assert.equal(r2!.status, 'delivered');
  assert.equal(r1!.deliveredAt, now);

  const audit1 = getAuditForInbox(row1.id);
  const audit2 = getAuditForInbox(row2.id);
  assert.equal(audit1!.driver, 'user-prompt');
  assert.equal(audit2!.driver, 'user-prompt');
  assert.equal(audit1!.hookDrainedAt, now);
});

test('drainInbox: idempotent — second call drains nothing', () => {
  const result = hook.drainInbox({
    dbPath: DB_PATH,
    trunkPath: TRUNK_ROOT,
    sessionId: SESSION_ORCH,
    now: Date.now(),
  });
  assert.equal(result.drained, 0);
});

test('drainInbox: skips rows for other sessions', () => {
  const ours = enqueueInboxRow({
    projectId,
    recipientSessionId: 'ours',
    eventKind: 'agent-completed',
    payloadBody: 'ours-body',
    now: Date.now(),
  });
  enqueueInboxRow({
    projectId,
    recipientSessionId: 'theirs',
    eventKind: 'agent-failed',
    payloadBody: 'theirs-body',
    now: Date.now(),
  });

  const result = hook.drainInbox({
    dbPath: DB_PATH,
    trunkPath: TRUNK_ROOT,
    sessionId: 'ours',
    now: Date.now(),
  });
  assert.equal(result.drained, 1);
  assert.equal(result.rows[0]!.id, ours.id);
});

test('drainInbox: channel-only transport skips the drain entirely', () => {
  const row = enqueueInboxRow({
    projectId,
    recipientSessionId: 'channel-only-sess',
    eventKind: 'agent-completed',
    payloadBody: 'should-not-drain',
    now: Date.now(),
  });
  process.env.PC_DELIVERY_TRANSPORT = 'channel-only';
  try {
    const result = hook.drainInbox({
      dbPath: DB_PATH,
      trunkPath: TRUNK_ROOT,
      sessionId: 'channel-only-sess',
      now: Date.now(),
    });
    assert.equal(result.drained, 0);
    // Row is still pending — flag preempts before any UPDATE.
    const r = getInboxRow(row.id);
    assert.equal(r!.status, 'pending');
  } finally {
    delete process.env.PC_DELIVERY_TRANSPORT;
  }
});

test('drainInbox: bad db path returns 0 silently', () => {
  const result = hook.drainInbox({
    dbPath: join(tmpDir, 'definitely-does-not-exist.sqlite'),
    trunkPath: TRUNK_ROOT,
    sessionId: SESSION_ORCH,
    now: Date.now(),
  });
  assert.equal(result.drained, 0);
});

// Note: a "bad trunk path returns 0" test isn't meaningful in this process —
// once `@pc/db` imports better-sqlite3, it's in Node's process-wide module
// cache, so a wrong `trunkPath` still resolves. The .cjs's try/catch around
// `createRequire(...)` is exercised in production scenarios where the hook
// runs in a fresh node child without that cache. Tested manually.

test('renderPreamble: empty rows returns empty string', () => {
  assert.equal(hook.renderPreamble([], slug), '');
});

test('renderPreamble: single row wraps in agent channel block', () => {
  const out = hook.renderPreamble(
    [
      {
        id: '01',
        eventKind: 'agent-completed',
        payloadBody: '[pc:agent-event kind=agent-completed version=1]\nResult: x',
      },
    ],
    slug,
  );
  assert.ok(out.includes(`<channel source="agent" path="/channel/${slug}/agent" method="POST">`));
  assert.ok(out.includes('[pc:agent-event kind=agent-completed version=1]'));
  assert.ok(out.includes('Result: x'));
  assert.ok(out.includes('</channel>'));
  assert.ok(out.startsWith('One agent event arrived'));
});

test('renderPreamble: multi-row pluralises + concatenates', () => {
  const out = hook.renderPreamble(
    [
      { id: '01', eventKind: 'agent-completed', payloadBody: 'body-one' },
      { id: '02', eventKind: 'agent-failed', payloadBody: 'body-two' },
    ],
    slug,
  );
  assert.ok(out.startsWith('2 agent events arrived'));
  const channelBlocks = out.match(/<channel source="agent"/g);
  assert.equal(channelBlocks?.length, 2);
  assert.ok(out.indexOf('body-one') < out.indexOf('body-two'), 'oldest-first ordering');
});
