// Section 26.6 — unit tests for the approve / reject service helpers.
//
// Coverage:
//   - approve: tier-2 awaiting-verification → complete + passed, notes persist.
//   - approve: no notes → history note is bare "approved by orchestrator".
//   - approve: WI not awaiting verification → throws not-awaiting-verification.
//   - approve: not an agent task → throws not-agent-task.
//   - approve: unknown id → throws wi-not-found.
//   - reject: tier-2 awaiting-verification → in-progress + failed, feedback in
//     verification_notes, history note truncates long feedback to 240 chars.
//   - reject: empty feedback → throws feedback-required.
//   - reject: WI without assigned_agent_run_id → throws no-assigned-run.
//   - reject: WI not awaiting verification → throws not-awaiting-verification.
//   - reject: continuation call passes the wrapped feedback prompt through.
//
// The continuation side of reject (dispatchContinueAgent) is stubbed — we only
// assert the wrapper passes the right shape; the dispatch internals are
// exercised by other suites.
//
// Run via:  pnpm --filter @pc/server test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-agent-verification-review-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  createWorkItem,
  getWorkItem,
  setAssignedAgentRunId,
  applyAgentVerification,
} = await import('@pc/db');

import type { Project, Stage, ULID } from '@pc/domain';

import {
  approveAgentWorkItem,
  rejectAgentWorkItem,
  VerificationReviewError,
} from '../src/services/agent-verification-review.ts';
import type {
  DispatchAgentResult,
  DispatchContinueAgentInput,
} from '../src/services/agent-run-factory.ts';

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

function mkProject(slug: string): Project {
  return createProject({ slug, name: slug, stages, folderPath: tmpDir });
}

/** Mint a contract WI in awaiting-verification with verification_status =
 *  pending. Used as the precondition for both approve + reject. */
function mkPendingContract(opts: {
  project: Project;
  withAssignedRunId?: ULID | null;
  tier?: 'orchestrator-review' | 'human-review';
}) {
  const wi = createWorkItem({
    projectId: opts.project.id as ULID,
    stageId: 'backlog',
    title: 'contract',
    body: 'agent did the thing',
    isAgentTask: true,
    acceptanceCriteria: [],
    verificationTier: opts.tier ?? 'orchestrator-review',
  });
  applyAgentVerification(wi.id, {
    workItemStatus: 'awaiting-verification',
    statusReason: 'agent reported done — pending review',
    verificationStatus: 'pending',
    verificationNotes: null,
    historyNote: 'awaiting orchestrator-review verification',
  });
  if (opts.withAssignedRunId !== null) {
    setAssignedAgentRunId(wi.id, (opts.withAssignedRunId ?? ('run-fake' as ULID)));
  }
  return getWorkItem(wi.id)!;
}

const noopChannel = {
  emitToSession: () => false,
  isRegistered: () => false,
  registerOnRegisterCallback: () => () => {},
} as unknown as Parameters<typeof rejectAgentWorkItem>[1]['channelServer'];

// ── Approve ────────────────────────────────────────────────────────────────

test('approve: tier-2 awaiting-verification → complete + passed, notes persist', () => {
  const p = mkProject('approve-happy');
  const wi = mkPendingContract({ project: p });
  const result = approveAgentWorkItem({
    workItemId: wi.id,
    notes: 'looks good — ship it',
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.verificationStatus, 'passed');
  assert.equal(result.verificationNotes, 'looks good — ship it');
  const fresh = getWorkItem(wi.id)!;
  assert.equal(fresh.status, 'complete');
  assert.ok(fresh.history.some((h) => h.note?.startsWith('approved by orchestrator:')));
});

test('approve: no notes → history reads "approved by orchestrator" only', () => {
  const p = mkProject('approve-no-notes');
  const wi = mkPendingContract({ project: p });
  const result = approveAgentWorkItem({ workItemId: wi.id });
  assert.equal(result.verificationNotes, null);
  const lastHistory = result.history[result.history.length - 1]!;
  assert.equal(lastHistory.note, 'approved by orchestrator');
});

test('approve: actor=user surfaces in history attribution', () => {
  const p = mkProject('approve-user-actor');
  const wi = mkPendingContract({ project: p });
  const result = approveAgentWorkItem({ workItemId: wi.id, actor: 'user' });
  assert.match(
    result.history[result.history.length - 1]!.note ?? '',
    /approved by user/,
  );
});

test('approve: not awaiting verification → throws not-awaiting-verification', () => {
  const p = mkProject('approve-not-awaiting');
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'plain',
    isAgentTask: true,
    verificationTier: 'auto',
  });
  assert.throws(
    () => approveAgentWorkItem({ workItemId: wi.id }),
    (e: unknown) =>
      e instanceof VerificationReviewError && e.cause === 'not-awaiting-verification',
  );
});

test('approve: not an agent task → throws not-agent-task', () => {
  const p = mkProject('approve-not-agent');
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'plain',
    isAgentTask: false,
  });
  assert.throws(
    () => approveAgentWorkItem({ workItemId: wi.id }),
    (e: unknown) => e instanceof VerificationReviewError && e.cause === 'not-agent-task',
  );
});

test('approve: unknown id → throws wi-not-found', () => {
  assert.throws(
    () => approveAgentWorkItem({ workItemId: 'wi-does-not-exist' as ULID }),
    (e: unknown) => e instanceof VerificationReviewError && e.cause === 'wi-not-found',
  );
});

// ── Reject ─────────────────────────────────────────────────────────────────

/** Capturing dispatch stub used by the reject tests. Returns a fixed success
 *  result by default; tests can override via `dispatch.result = ...` before
 *  calling rejectAgentWorkItem. */
function mkDispatchStub(): {
  fn: (input: DispatchContinueAgentInput, deps: unknown) => Promise<DispatchAgentResult>;
  calls: DispatchContinueAgentInput[];
  result: DispatchAgentResult;
} {
  const calls: DispatchContinueAgentInput[] = [];
  const state = {
    calls,
    result: {
      ok: true,
      agentRunId: 'run-cont',
      ccSessionId: 'cc-cont',
      podName: 'researcher',
      initialState: 'queued' as const,
      startedAt: Date.now(),
    } as DispatchAgentResult,
  };
  return {
    fn: async (input) => {
      state.calls.push(input);
      return state.result;
    },
    get calls() {
      return state.calls;
    },
    get result() {
      return state.result;
    },
    set result(v: DispatchAgentResult) {
      state.result = v;
    },
  } as ReturnType<typeof mkDispatchStub>;
}

test('reject: tier-2 awaiting-verification → in-progress + failed, feedback persists', async () => {
  const p = mkProject('reject-happy');
  const wi = mkPendingContract({
    project: p,
    withAssignedRunId: 'run-producer' as ULID,
  });
  const dispatch = mkDispatchStub();
  const result = await rejectAgentWorkItem(
    {
      workItemId: wi.id,
      feedback: 'the summary section is missing — add it',
      dispatcherSessionId: 'dispatcher-1',
      project: p,
    },
    { channelServer: noopChannel, dispatch: dispatch.fn },
  );
  assert.equal(result.workItem.status, 'in-progress');
  assert.equal(result.workItem.verificationStatus, 'failed');
  assert.equal(
    result.workItem.verificationNotes,
    'the summary section is missing — add it',
  );
  assert.equal(result.continuation.ok, true);
  // Continuation called with the feedback wrapped into the resumed-agent
  // prompt + the assigned run as the parent.
  assert.equal(dispatch.calls.length, 1);
  const passed = dispatch.calls[0]!;
  assert.equal(passed.parentAgentRunId, 'run-producer');
  assert.equal(passed.workItemId, wi.id);
  assert.match(passed.input, /the summary section is missing/);
  assert.match(passed.input, /Reviewer rejected/);
});

test('reject: long feedback truncates in history note', async () => {
  const p = mkProject('reject-long-feedback');
  const wi = mkPendingContract({
    project: p,
    withAssignedRunId: 'run-producer' as ULID,
  });
  const longFeedback = 'x'.repeat(300);
  const dispatch = mkDispatchStub();
  const result = await rejectAgentWorkItem(
    {
      workItemId: wi.id,
      feedback: longFeedback,
      dispatcherSessionId: 'dispatcher-1',
      project: p,
    },
    { channelServer: noopChannel, dispatch: dispatch.fn },
  );
  // Full feedback persists in verificationNotes.
  assert.equal(result.workItem.verificationNotes, longFeedback);
  // History note carries the truncated form.
  const lastHistory =
    result.workItem.history[result.workItem.history.length - 1]!;
  assert.match(lastHistory.note ?? '', /…$/);
  assert.ok((lastHistory.note?.length ?? 0) < 290);
});

test('reject: empty feedback → throws feedback-required', async () => {
  const p = mkProject('reject-empty-feedback');
  const wi = mkPendingContract({ project: p, withAssignedRunId: 'run-x' as ULID });
  await assert.rejects(
    async () =>
      rejectAgentWorkItem(
        {
          workItemId: wi.id,
          feedback: '   ',
          dispatcherSessionId: 'dispatcher-1',
          project: p,
        },
        { channelServer: noopChannel },
      ),
    (e: unknown) => e instanceof VerificationReviewError && e.cause === 'feedback-required',
  );
});

test('reject: WI without assigned_agent_run_id → throws no-assigned-run', async () => {
  const p = mkProject('reject-no-assigned-run');
  const wi = mkPendingContract({ project: p, withAssignedRunId: null });
  await assert.rejects(
    async () =>
      rejectAgentWorkItem(
        {
          workItemId: wi.id,
          feedback: 'try again',
          dispatcherSessionId: 'dispatcher-1',
          project: p,
        },
        { channelServer: noopChannel },
      ),
    (e: unknown) => e instanceof VerificationReviewError && e.cause === 'no-assigned-run',
  );
});

test('reject: not awaiting verification → throws not-awaiting-verification', async () => {
  const p = mkProject('reject-not-awaiting');
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'plain agent task',
    isAgentTask: true,
    verificationTier: 'auto',
  });
  setAssignedAgentRunId(wi.id, 'run-x' as ULID);
  await assert.rejects(
    async () =>
      rejectAgentWorkItem(
        {
          workItemId: wi.id,
          feedback: 'do over',
          dispatcherSessionId: 'dispatcher-1',
          project: p,
        },
        { channelServer: noopChannel },
      ),
    (e: unknown) =>
      e instanceof VerificationReviewError && e.cause === 'not-awaiting-verification',
  );
});

test('reject: continuation failure surfaces in result without throwing', async () => {
  const p = mkProject('reject-cont-fail');
  const wi = mkPendingContract({
    project: p,
    withAssignedRunId: 'run-producer' as ULID,
  });
  const dispatch = mkDispatchStub();
  dispatch.result = {
    ok: false,
    cause: 'session-expired',
    error: 'JSONL retention expired',
  } as DispatchAgentResult;
  const result = await rejectAgentWorkItem(
    {
      workItemId: wi.id,
      feedback: 'try again',
      dispatcherSessionId: 'dispatcher-1',
      project: p,
    },
    { channelServer: noopChannel, dispatch: dispatch.fn },
  );
  // WI flip still happened.
  assert.equal(result.workItem.status, 'in-progress');
  assert.equal(result.workItem.verificationStatus, 'failed');
  // Continuation surfaces the failure.
  assert.equal(result.continuation.ok, false);
});
