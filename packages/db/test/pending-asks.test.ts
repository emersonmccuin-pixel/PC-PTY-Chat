// Section 25 Session 8 — pending_asks_v2 repo round-trip. Pins the contract
// the v2 pause/resume orchestration calls into.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-db-pending-asks-v2-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  createPendingAsk,
  getPendingAsk,
  insertAgentRunRow,
  listOpenPendingAsksForProject,
  listOpenPendingAsksForSession,
  markPendingAskAnswered,
  markPendingAskCancelled,
  newId,
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

function seedRun(projectId: ULID, podName = 'researcher', cc = 'cc-uuid-x'): ULID {
  const id = newId();
  insertAgentRunRow({
    id,
    projectId,
    podName,
    dispatcherSessionId: 'orch-sess',
    ccSessionId: cc,
    status: 'paused',
    input: 'go',
    queuedAt: 1_700_000_000_000,
  });
  return id;
}

test('createPendingAsk writes an open row with defaults', () => {
  const p = createProject({ slug: 'pa-v2-create', name: 'PA V2 Create', stages, folderPath: tmpDir });
  const runId = seedRun(p.id as ULID);
  const askId = newId();

  const row = createPendingAsk({
    id: askId,
    agentRunId: runId,
    ccSessionId: 'cc-uuid-x',
    projectId: p.id as ULID,
    kind: 'orchestrator',
    promptBody: 'what is your favorite color?',
    now: 1_700_000_000_000,
  });

  assert.equal(row.id, askId);
  assert.equal(row.status, 'open');
  assert.equal(row.answerBody, null);
  assert.equal(row.answeredAt, null);
  assert.equal(row.cancelledAt, null);
  assert.equal(row.options, null);
  assert.equal(row.context, null);

  const fetched = getPendingAsk(askId);
  assert.ok(fetched);
  assert.equal(fetched!.kind, 'orchestrator');
});

test('markPendingAskAnswered flips open → answered atomically; second call returns false', () => {
  const p = createProject({ slug: 'pa-v2-answer', name: 'Answer', stages, folderPath: tmpDir });
  const runId = seedRun(p.id as ULID, 'researcher', 'cc-uuid-answer');
  const askId = newId();
  createPendingAsk({
    id: askId,
    agentRunId: runId,
    ccSessionId: 'cc-uuid-answer',
    projectId: p.id as ULID,
    kind: 'user',
    promptBody: 'pick one',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
    now: 1_700_000_000_000,
  });

  const first = markPendingAskAnswered({
    id: askId,
    answer: 'a',
    answeredBy: 'user',
    now: 1_700_000_005_000,
  });
  assert.equal(first, true);

  const second = markPendingAskAnswered({
    id: askId,
    answer: 'b',
    answeredBy: 'user',
    now: 1_700_000_006_000,
  });
  assert.equal(second, false);

  const row = getPendingAsk(askId);
  assert.equal(row!.status, 'answered');
  assert.equal(row!.answerBody, 'a');
  assert.equal(row!.answeredBy, 'user');
  assert.equal(row!.answeredAt, 1_700_000_005_000);
  // Options round-trip preserved.
  assert.equal(row!.options?.length, 2);
});

test('markPendingAskCancelled flips open → cancelled; cancelling an answered row is a no-op', () => {
  const p = createProject({ slug: 'pa-v2-cancel', name: 'Cancel', stages, folderPath: tmpDir });
  const runId = seedRun(p.id as ULID, 'researcher', 'cc-uuid-cancel');
  const askId = newId();
  createPendingAsk({
    id: askId,
    agentRunId: runId,
    ccSessionId: 'cc-uuid-cancel',
    projectId: p.id as ULID,
    kind: 'approval',
    promptBody: 'go ahead?',
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
    now: 1_700_000_000_000,
  });

  const cancelled = markPendingAskCancelled(askId, 1_700_000_003_000);
  assert.equal(cancelled, true);

  const row = getPendingAsk(askId);
  assert.equal(row!.status, 'cancelled');
  assert.equal(row!.cancelledAt, 1_700_000_003_000);

  // A second cancel is a no-op.
  assert.equal(markPendingAskCancelled(askId, 1_700_000_004_000), false);

  // Cancelling a different already-answered row is also a no-op.
  const askId2 = newId();
  createPendingAsk({
    id: askId2,
    agentRunId: runId,
    ccSessionId: 'cc-uuid-cancel',
    projectId: p.id as ULID,
    kind: 'orchestrator',
    promptBody: '?',
    now: 1_700_000_000_000,
  });
  markPendingAskAnswered({
    id: askId2,
    answer: 'k',
    answeredBy: 'orchestrator',
    now: 1_700_000_001_000,
  });
  assert.equal(markPendingAskCancelled(askId2, 1_700_000_005_000), false);
});

test('listOpenPendingAsksV2 filters by project / session + oldest-first', () => {
  const p = createProject({ slug: 'pa-v2-list', name: 'List', stages, folderPath: tmpDir });
  const runId = seedRun(p.id as ULID, 'researcher', 'cc-uuid-target');

  const oldId = newId();
  const newerId = newId();
  const answeredId = newId();

  createPendingAsk({
    id: oldId,
    agentRunId: runId,
    ccSessionId: 'cc-uuid-target',
    projectId: p.id as ULID,
    kind: 'orchestrator',
    promptBody: 'first',
    now: 1_700_000_000_000,
  });
  createPendingAsk({
    id: newerId,
    agentRunId: runId,
    ccSessionId: 'cc-uuid-target',
    projectId: p.id as ULID,
    kind: 'user',
    promptBody: 'second',
    now: 1_700_000_001_000,
  });
  // Answered rows are excluded from the open list.
  createPendingAsk({
    id: answeredId,
    agentRunId: runId,
    ccSessionId: 'cc-uuid-target',
    projectId: p.id as ULID,
    kind: 'approval',
    promptBody: 'third',
    options: [{ value: 'ok', label: 'OK' }],
    now: 1_700_000_002_000,
  });
  markPendingAskAnswered({
    id: answeredId,
    answer: 'ok',
    answeredBy: 'orchestrator',
    now: 1_700_000_003_000,
  });

  // Different session — must not surface in either filter.
  const otherP = createProject({
    slug: 'pa-v2-list-other',
    name: 'Other',
    stages,
    folderPath: tmpDir,
  });
  const otherRunId = seedRun(otherP.id as ULID, 'planner', 'cc-uuid-other');
  createPendingAsk({
    id: newId(),
    agentRunId: otherRunId,
    ccSessionId: 'cc-uuid-other',
    projectId: otherP.id as ULID,
    kind: 'orchestrator',
    promptBody: 'foreign',
    now: 1_700_000_005_000,
  });

  const byProject = listOpenPendingAsksForProject(p.id as ULID);
  assert.deepEqual(
    byProject.map((r) => r.id),
    [oldId, newerId],
  );

  const bySession = listOpenPendingAsksForSession('cc-uuid-target');
  assert.deepEqual(
    bySession.map((r) => r.id),
    [oldId, newerId],
  );
});
