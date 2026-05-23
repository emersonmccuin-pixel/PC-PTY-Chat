// Section 24 — instruction_deposits repo round-trip. Pins the contract the
// long-poll endpoint (24.2) + the `pc_continue_agent` deposit-path (24.4)
// will call into.
//
// Run via:  pnpm --filter @pc/db test
// Or:       pnpm test:unit  (from repo root)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-db-id-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  newId,
  runMigrations,
  createProject,
  insertAgentRunRow,
  markAgentRunTerminal,
  depositInstruction,
  consumeInstructionForRun,
  cancelInstruction,
  findWaitingForRun,
  reconcileOrphanedInstructionDeposits,
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

function seedRun(opts: {
  projectId: ULID;
  dispatcherSessionId?: string;
  dispatchedAt?: number;
}): ULID {
  const id = newId() as ULID;
  insertAgentRunRow({
    id,
    projectId: opts.projectId,
    agentName: 'researcher',
    dispatcherSessionId: opts.dispatcherSessionId ?? 'orch-1',
    sessionId: `sess-${id}`,
    input: 'do the thing',
    parentWorkItemId: null,
    parentInvokeDepth: 1,
    continues: null,
    dispatchedAt: opts.dispatchedAt ?? 1_700_000_000_000,
  });
  return id;
}

test('depositInstruction + findWaitingForRun round-trip', () => {
  const p = createProject({ slug: 'id-rt', name: 'ID RT', stages, folderPath: tmpDir });
  const runId = seedRun({ projectId: p.id as ULID });
  const id = newId() as ULID;
  const row = depositInstruction({
    id,
    runId,
    projectId: p.id as ULID,
    dispatcherSessionId: 'orch-1',
    instruction: 'of those three, fastest stream-mode?',
    now: 1_700_000_010_000,
  });
  assert.equal(row.id, id);
  assert.equal(row.status, 'waiting');
  assert.equal(row.consumedAt, null);

  const fetched = findWaitingForRun(runId);
  assert.ok(fetched);
  assert.equal(fetched.id, id);
  assert.equal(fetched.instruction, 'of those three, fastest stream-mode?');
});

test('consumeInstructionForRun flips waiting → consumed; idempotent on second call', () => {
  const p = createProject({ slug: 'id-consume', name: 'ID Consume', stages, folderPath: tmpDir });
  const runId = seedRun({ projectId: p.id as ULID });
  depositInstruction({
    id: newId() as ULID,
    runId,
    projectId: p.id as ULID,
    dispatcherSessionId: 'orch-1',
    instruction: 'follow-up text',
    now: 1_700_000_020_000,
  });

  const consumed = consumeInstructionForRun(runId, 1_700_000_025_000);
  assert.ok(consumed, 'first call returns the row');
  assert.equal(consumed.status, 'consumed');
  assert.equal(consumed.consumedAt, 1_700_000_025_000);
  assert.equal(consumed.instruction, 'follow-up text');

  const second = consumeInstructionForRun(runId, 1_700_000_030_000);
  assert.equal(second, null, 'second call returns null (already consumed)');

  // Row state preserved.
  const lookup = findWaitingForRun(runId);
  assert.equal(lookup, null, 'no waiting row after consume');
});

test('consumeInstructionForRun returns null when no deposit exists', () => {
  const p = createProject({ slug: 'id-none', name: 'ID None', stages, folderPath: tmpDir });
  const runId = seedRun({ projectId: p.id as ULID });
  assert.equal(consumeInstructionForRun(runId, 1), null);
});

test('partial unique index blocks a second waiting row for the same run', () => {
  const p = createProject({ slug: 'id-uniq', name: 'ID Uniq', stages, folderPath: tmpDir });
  const runId = seedRun({ projectId: p.id as ULID });
  depositInstruction({
    id: newId() as ULID,
    runId,
    projectId: p.id as ULID,
    dispatcherSessionId: 'orch-1',
    instruction: 'first',
    now: 1,
  });
  assert.throws(
    () =>
      depositInstruction({
        id: newId() as ULID,
        runId,
        projectId: p.id as ULID,
        dispatcherSessionId: 'orch-1',
        instruction: 'second',
        now: 2,
      }),
    /UNIQUE/i,
    'second waiting row for same run rejected by partial unique index',
  );

  // After consuming the first, a fresh deposit succeeds — index is partial
  // on status='waiting', so consumed rows don't block.
  consumeInstructionForRun(runId, 3);
  const replacement = depositInstruction({
    id: newId() as ULID,
    runId,
    projectId: p.id as ULID,
    dispatcherSessionId: 'orch-1',
    instruction: 'replacement',
    now: 4,
  });
  assert.equal(replacement.status, 'waiting');
});

test('cancelInstruction flips waiting → cancelled; no-op on terminal rows', () => {
  const p = createProject({ slug: 'id-cxl', name: 'ID Cxl', stages, folderPath: tmpDir });
  const runId = seedRun({ projectId: p.id as ULID });
  const id = newId() as ULID;
  depositInstruction({
    id,
    runId,
    projectId: p.id as ULID,
    dispatcherSessionId: 'orch-1',
    instruction: 'will be cancelled',
    now: 10,
  });
  assert.equal(cancelInstruction(id, 20), true);
  assert.equal(findWaitingForRun(runId), null);
  assert.equal(cancelInstruction(id, 30), false, 'cancel on terminal row is a no-op');

  // A consumed row also cannot be cancelled.
  const runId2 = seedRun({ projectId: p.id as ULID });
  const id2 = newId() as ULID;
  depositInstruction({
    id: id2,
    runId: runId2,
    projectId: p.id as ULID,
    dispatcherSessionId: 'orch-1',
    instruction: 'will be consumed',
    now: 40,
  });
  consumeInstructionForRun(runId2, 50);
  assert.equal(cancelInstruction(id2, 60), false, 'consumed row cannot be cancelled');
});

test('reconcileOrphanedInstructionDeposits cancels rows whose run is no longer running', () => {
  const p = createProject({ slug: 'id-orph', name: 'ID Orph', stages, folderPath: tmpDir });

  // Run A: still running — waiting deposit must be preserved.
  const runA = seedRun({ projectId: p.id as ULID });
  const depA = newId() as ULID;
  depositInstruction({
    id: depA,
    runId: runA,
    projectId: p.id as ULID,
    dispatcherSessionId: 'orch-orph',
    instruction: 'preserve me',
    now: 1,
  });

  // Run B: terminal (failed) — waiting deposit is orphaned.
  const runB = seedRun({ projectId: p.id as ULID });
  markAgentRunTerminal({
    id: runB,
    status: 'failed',
    result: null,
    failureReason: 'spawn died',
    failureCause: 'spawn-failed',
    completedAt: 2,
  });
  depositInstruction({
    id: newId() as ULID,
    runId: runB,
    projectId: p.id as ULID,
    dispatcherSessionId: 'orch-orph',
    instruction: 'orphan me',
    now: 3,
  });

  const count = reconcileOrphanedInstructionDeposits(99_999);
  assert.equal(count, 1, 'exactly one orphan flipped to cancelled');

  // Run A's deposit survives.
  const survivor = findWaitingForRun(runA);
  assert.ok(survivor);
  assert.equal(survivor.id, depA);

  // Run B has no waiting row anymore.
  assert.equal(findWaitingForRun(runB), null);
});
