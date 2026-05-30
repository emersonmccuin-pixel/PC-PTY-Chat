// Section 26.5 — tier-1 verification harness tests.
//
// Exercises the runVerificationOnTerminal service end-to-end against a real
// sqlite DB. Coverage:
//   - tier-1 pass → WI flips to complete, verification_status=passed.
//   - tier-1 fail (body_contains) → WI flips to failed, verification_notes
//     carries the JSON failure list.
//   - tier-1 with files_exist + bash_exit_zero exercise the injected
//     executors (no real fs/spawn — those are covered by ac-evaluator
//     unit tests in @pc/domain).
//   - tier-2 (orchestrator-review) → WI flips to awaiting-verification,
//     verification_status=pending, no predicate eval.
//   - tier-3 (human-review) → same as tier-2.
//   - cancelled terminal → no-op (returns null, WI untouched).
//   - failed terminal → WI flips to failed with the failureReason as notes,
//     no predicate eval.
//   - non-agent-task WI passed in by mistake → no-op (defensive guard).
//   - empty AC list → trust the agent's done signal (passes by default).
//   - missing WI → null (the contract pointer was stale).
//
// Run via:  pnpm --filter @pc/server test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-agent-verification-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  createWorkItem,
  getWorkItem,
} = await import('@pc/db');

import type { Stage, ULID } from '@pc/domain';
import { runVerificationOnTerminal } from '../src/services/agent-verification.ts';

const stages: Stage[] = [
  { id: 'backlog', name: 'Backlog', order: 0 },
  { id: 'doing', name: 'Doing', order: 1 },
];

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function mkProject(slug: string) {
  return createProject({ slug, name: slug, stages, folderPath: tmpDir });
}

function mkExecutors(opts: {
  fileSize?: (p: string) => Promise<number | null>;
  runBash?: (cmd: string, cwd: 'worktree' | 'project') => Promise<number>;
}) {
  return {
    fileSize: opts.fileSize ?? (async () => null),
    runBash: opts.runBash ?? (async () => 0),
  };
}

// ── Tier-1 pass ────────────────────────────────────────────────────────────

test('tier-1: empty AC → pass + WI flips to complete', async () => {
  const p = mkProject('empty-ac-pass');
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'contract',
    body: 'whatever',
    isAgentTask: true,
    acceptanceCriteria: [],
    verificationTier: 'auto',
  });
  const outcome = await runVerificationOnTerminal({
    workItemId: wi.id,
    terminalStatus: 'completed',
    failureReason: null,
    projectFolderPath: tmpDir,
    worktreeDir: tmpDir,
  });
  assert.equal(outcome?.workItemStatus, 'complete');
  assert.equal(outcome?.verificationStatus, 'passed');
  assert.equal(outcome?.predicatesEvaluated, 0);

  const fresh = getWorkItem(wi.id);
  assert.equal(fresh?.status, 'complete');
  assert.equal(fresh?.verificationStatus, 'passed');
  assert.equal(fresh?.verificationNotes, null);
  // History gained an entry.
  assert.ok(fresh?.history.some((h) => h.note?.includes('verification passed')));
});

test('tier-1: body_contains matches → pass', async () => {
  const p = mkProject('body-contains-pass');
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'researcher contract',
    body: '## summary\n\nFindings: X, Y, Z.',
    isAgentTask: true,
    acceptanceCriteria: [{ kind: 'body_contains', pattern: 'summary' }],
    verificationTier: 'auto',
  });
  const outcome = await runVerificationOnTerminal({
    workItemId: wi.id,
    terminalStatus: 'completed',
    failureReason: null,
    projectFolderPath: tmpDir,
    worktreeDir: tmpDir,
  });
  assert.equal(outcome?.workItemStatus, 'complete');
  assert.equal(outcome?.predicatesEvaluated, 1);
});

test('tier-1: body_contains missing → fail with notes JSON', async () => {
  const p = mkProject('body-contains-fail');
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'researcher contract',
    body: 'nothing useful',
    isAgentTask: true,
    acceptanceCriteria: [{ kind: 'body_contains', pattern: 'summary' }],
    verificationTier: 'auto',
  });
  const outcome = await runVerificationOnTerminal({
    workItemId: wi.id,
    terminalStatus: 'completed',
    failureReason: null,
    projectFolderPath: tmpDir,
    worktreeDir: tmpDir,
  });
  assert.equal(outcome?.workItemStatus, 'failed');
  assert.equal(outcome?.verificationStatus, 'failed');
  assert.match(outcome?.notes ?? '', /body_contains/);

  const fresh = getWorkItem(wi.id);
  assert.equal(fresh?.status, 'failed');
  // Notes round-trip as JSON of the failure list.
  const parsed = JSON.parse(fresh?.verificationNotes ?? '[]') as Array<{ kind: string }>;
  assert.equal(parsed[0]?.kind, 'body_contains');
});

test('tier-1: files_exist passes via injected executor', async () => {
  const p = mkProject('files-exist-pass');
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'code-writer contract',
    body: 'wrote files',
    isAgentTask: true,
    acceptanceCriteria: [{ kind: 'files_exist', paths: ['src/foo.ts'] }],
    verificationTier: 'auto',
  });
  const seen: string[] = [];
  const outcome = await runVerificationOnTerminal(
    {
      workItemId: wi.id,
      terminalStatus: 'completed',
      failureReason: null,
      projectFolderPath: tmpDir,
      worktreeDir: tmpDir,
    },
    {
      executorsFor: () =>
        mkExecutors({
          fileSize: async (path) => {
            seen.push(path);
            return 42;
          },
        }),
    },
  );
  assert.equal(outcome?.workItemStatus, 'complete');
  assert.deepEqual(seen, ['src/foo.ts']);
});

test('tier-1: bash_exit_zero exit=0 passes, exit=1 fails', async () => {
  const p = mkProject('bash-exit-zero');
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'side-effect contract',
    body: 'ran the script',
    isAgentTask: true,
    acceptanceCriteria: [{ kind: 'bash_exit_zero', command: 'pnpm test', cwd: 'worktree' }],
    verificationTier: 'auto',
  });
  // First: exit 0 → pass.
  const ok = await runVerificationOnTerminal(
    {
      workItemId: wi.id,
      terminalStatus: 'completed',
      failureReason: null,
      projectFolderPath: tmpDir,
      worktreeDir: tmpDir,
    },
    {
      executorsFor: () => mkExecutors({ runBash: async () => 0 }),
    },
  );
  assert.equal(ok?.workItemStatus, 'complete');

  // Reset for a second run: re-create a clean WI (tier-1 fail flips status,
  // so a re-run would see status='failed' as the carry-over).
  const wi2 = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'side-effect contract 2',
    body: 'ran the script',
    isAgentTask: true,
    acceptanceCriteria: [{ kind: 'bash_exit_zero', command: 'pnpm test', cwd: 'worktree' }],
    verificationTier: 'auto',
  });
  const bad = await runVerificationOnTerminal(
    {
      workItemId: wi2.id,
      terminalStatus: 'completed',
      failureReason: null,
      projectFolderPath: tmpDir,
      worktreeDir: tmpDir,
    },
    {
      executorsFor: () => mkExecutors({ runBash: async () => 1 }),
    },
  );
  assert.equal(bad?.workItemStatus, 'failed');
  assert.match(bad?.notes ?? '', /bash_exit_zero/);
});

// ── Tier 2 / 3 holds ───────────────────────────────────────────────────────

test('tier-2: orchestrator-review → WI flips to awaiting-verification', async () => {
  const p = mkProject('tier-2-hold');
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'reviewer-tier-2',
    body: '## summary\n\ndone',
    isAgentTask: true,
    acceptanceCriteria: [{ kind: 'body_contains', pattern: 'summary' }],
    verificationTier: 'orchestrator-review',
  });
  const outcome = await runVerificationOnTerminal({
    workItemId: wi.id,
    terminalStatus: 'completed',
    failureReason: null,
    projectFolderPath: tmpDir,
    worktreeDir: tmpDir,
  });
  assert.equal(outcome?.workItemStatus, 'awaiting-verification');
  assert.equal(outcome?.verificationStatus, 'pending');
  assert.equal(outcome?.verificationTier, 'orchestrator-review');
  assert.equal(outcome?.predicatesEvaluated, 0);

  const fresh = getWorkItem(wi.id);
  assert.equal(fresh?.status, 'awaiting-verification');
  assert.equal(fresh?.verificationStatus, 'pending');
});

test('tier-3: human-review → WI flips to awaiting-verification', async () => {
  const p = mkProject('tier-3-hold');
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'human-tier-3',
    body: 'whatever',
    isAgentTask: true,
    acceptanceCriteria: [],
    verificationTier: 'human-review',
  });
  const outcome = await runVerificationOnTerminal({
    workItemId: wi.id,
    terminalStatus: 'completed',
    failureReason: null,
    projectFolderPath: tmpDir,
    worktreeDir: tmpDir,
  });
  assert.equal(outcome?.workItemStatus, 'awaiting-verification');
  assert.equal(outcome?.verificationTier, 'human-review');
});

// ── Terminal-status branches ───────────────────────────────────────────────

test('agent failed → WI fails with failureReason as notes, no eval', async () => {
  const p = mkProject('agent-failed');
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'broken',
    body: '',
    isAgentTask: true,
    acceptanceCriteria: [{ kind: 'body_contains', pattern: 'never-checked' }],
    verificationTier: 'auto',
  });
  // The agent died before the body could be written. Predicates should NOT
  // be evaluated — the failure reason carries.
  const ranBash: string[] = [];
  const outcome = await runVerificationOnTerminal(
    {
      workItemId: wi.id,
      terminalStatus: 'failed',
      failureReason: 'agent exceeded wall-clock cap',
      projectFolderPath: tmpDir,
      worktreeDir: tmpDir,
    },
    {
      executorsFor: () =>
        mkExecutors({
          runBash: async (cmd) => {
            ranBash.push(cmd);
            return 0;
          },
        }),
    },
  );
  assert.equal(outcome?.workItemStatus, 'failed');
  assert.equal(outcome?.verificationStatus, 'failed');
  assert.equal(outcome?.notes, 'agent exceeded wall-clock cap');
  assert.deepEqual(ranBash, []);

  const fresh = getWorkItem(wi.id);
  assert.equal(fresh?.statusReason, 'agent exceeded wall-clock cap');
  assert.equal(fresh?.verificationNotes, 'agent exceeded wall-clock cap');
});

test('agent cancelled → null (no WI mutation)', async () => {
  const p = mkProject('agent-cancelled');
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'cancelled',
    body: '',
    isAgentTask: true,
    acceptanceCriteria: [],
    verificationTier: 'auto',
  });
  const outcome = await runVerificationOnTerminal({
    workItemId: wi.id,
    terminalStatus: 'cancelled',
    failureReason: 'user cancel',
    projectFolderPath: tmpDir,
    worktreeDir: tmpDir,
  });
  assert.equal(outcome, null);

  const fresh = getWorkItem(wi.id);
  // Untouched — orchestrator decides what to do with a cancelled contract.
  assert.equal(fresh?.status, 'pending');
  assert.equal(fresh?.verificationStatus, null);
});

// ── Defensive guards ───────────────────────────────────────────────────────

test('non-agent-task WI passed in → null (defensive guard)', async () => {
  const p = mkProject('lineage-wi');
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'lineage parent',
    body: 'plain work item',
    isAgentTask: false,
    acceptanceCriteria: [{ kind: 'body_contains', pattern: 'never-checked' }],
    verificationTier: 'auto',
  });
  const outcome = await runVerificationOnTerminal({
    workItemId: wi.id,
    terminalStatus: 'completed',
    failureReason: null,
    projectFolderPath: tmpDir,
    worktreeDir: tmpDir,
  });
  assert.equal(outcome, null);
  // WI status unchanged.
  assert.equal(getWorkItem(wi.id)?.status, 'pending');
});

test('null workItemId → null (non-contract dispatch)', async () => {
  const outcome = await runVerificationOnTerminal({
    workItemId: null,
    terminalStatus: 'completed',
    failureReason: null,
    projectFolderPath: tmpDir,
    worktreeDir: tmpDir,
  });
  assert.equal(outcome, null);
});

test('unknown / archived WI → null', async () => {
  const outcome = await runVerificationOnTerminal({
    workItemId: 'wi-phantom-id' as ULID,
    terminalStatus: 'completed',
    failureReason: null,
    projectFolderPath: tmpDir,
    worktreeDir: tmpDir,
  });
  assert.equal(outcome, null);
});
