// Section 16b.2a — pending_asks repo round-trip. Pins the contract the
// runtime state machine (16b.2b) + the orchestrator handler protocol
// (16b.3) will call into.
//
// Run via:  pnpm --filter @pc/db test
// Or:       pnpm test:unit  (from repo root)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-db-pa-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  newId,
  runMigrations,
  createProject,
  createPendingAsk,
  getPendingAsk,
  listWaitingPendingAsksForProject,
  listWaitingPendingAsksForSession,
  markPendingAskAnswered,
  markPendingAskCancelled,
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

test('createPendingAsk + getPendingAsk round-trip', () => {
  const p = createProject({ slug: 'pa-rt', name: 'PA RT', stages, folderPath: tmpDir });
  const id = newId();
  const row = createPendingAsk({
    id,
    sessionId: 'sess-abc',
    agentName: 'researcher',
    projectId: p.id as ULID,
    kind: 'ask-orchestrator',
    question: 'which library should I use?',
    context: 'looked at three options',
    now: 1700_000_000_000,
  });

  assert.equal(row.id, id);
  assert.equal(row.status, 'waiting');
  assert.equal(row.context, 'looked at three options');

  const fetched = getPendingAsk(id);
  assert.ok(fetched);
  assert.equal(fetched.sessionId, 'sess-abc');
  assert.equal(fetched.agentName, 'researcher');
  assert.equal(fetched.kind, 'ask-orchestrator');
  assert.equal(fetched.options, null);
});

test('list-waiting queries scope correctly', () => {
  const a = createProject({ slug: 'pa-list-a', name: 'A', stages, folderPath: tmpDir });
  const b = createProject({ slug: 'pa-list-b', name: 'B', stages, folderPath: tmpDir });

  const ask1 = createPendingAsk({
    id: newId(),
    sessionId: 'sess-1',
    agentName: 'r1',
    projectId: a.id as ULID,
    kind: 'ask-user',
    question: 'q1',
    now: 1700_000_001_000,
  });
  const ask2 = createPendingAsk({
    id: newId(),
    sessionId: 'sess-1',
    agentName: 'r1',
    projectId: a.id as ULID,
    kind: 'ask-orchestrator',
    question: 'q2',
    now: 1700_000_002_000,
  });
  createPendingAsk({
    id: newId(),
    sessionId: 'sess-2',
    agentName: 'r2',
    projectId: b.id as ULID,
    kind: 'approval',
    question: 'q3',
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
    now: 1700_000_003_000,
  });

  const waitingA = listWaitingPendingAsksForProject(a.id as ULID);
  assert.equal(waitingA.length, 2);
  assert.deepEqual(
    waitingA.map((r) => r.id),
    [ask1.id, ask2.id],
    'orderBy createdAt asc',
  );

  const waitingSess1 = listWaitingPendingAsksForSession('sess-1');
  assert.equal(waitingSess1.length, 2);
  assert.ok(waitingSess1.every((r) => r.sessionId === 'sess-1'));
});

test('markPendingAskAnswered is atomic + idempotent', () => {
  const p = createProject({ slug: 'pa-ans', name: 'Ans', stages, folderPath: tmpDir });
  const id = newId();
  createPendingAsk({
    id,
    sessionId: 'sess-ans',
    agentName: 'r',
    projectId: p.id as ULID,
    kind: 'ask-orchestrator',
    question: 'q',
    now: 1700_000_010_000,
  });

  assert.equal(
    markPendingAskAnswered({ id, answer: 'use zod', answeredBy: 'orchestrator', now: 1700_000_020_000 }),
    true,
    'first answer flips the row',
  );

  const after1 = getPendingAsk(id);
  assert.equal(after1!.status, 'answered');
  assert.equal(after1!.answer, 'use zod');
  assert.equal(after1!.answeredBy, 'orchestrator');
  assert.equal(after1!.answeredAt, 1700_000_020_000);

  assert.equal(
    markPendingAskAnswered({ id, answer: 'use yup', answeredBy: 'user', now: 1700_000_030_000 }),
    false,
    'second answer is a no-op (replay-safe)',
  );

  const after2 = getPendingAsk(id);
  assert.equal(after2!.answer, 'use zod', 'original answer preserved');
});

test('markPendingAskCancelled flips waiting → cancelled', () => {
  const p = createProject({ slug: 'pa-cxl', name: 'Cxl', stages, folderPath: tmpDir });
  const id = newId();
  createPendingAsk({
    id,
    sessionId: 's',
    agentName: 'r',
    projectId: p.id as ULID,
    kind: 'approval',
    question: 'merge?',
    options: [{ value: 'yes', label: 'Yes' }],
    now: 1700_000_040_000,
  });

  assert.equal(markPendingAskCancelled(id, 1700_000_050_000), true);

  const row = getPendingAsk(id);
  assert.equal(row!.status, 'cancelled');
  assert.equal(row!.cancelledAt, 1700_000_050_000);

  assert.equal(
    markPendingAskAnswered({ id, answer: 'yes', answeredBy: 'user', now: 1700_000_060_000 }),
    false,
    'cancelled rows cannot be answered',
  );
});
