// Section 24 — Agent ready-ping protocol storage layer.
//
// Inverse of `pending_asks`: the orchestrator deposits an instruction here
// at the same moment it triggers a `--resume` spawn (`pc_continue_agent`
// route). The agent's first action on boot is `pc_check_in`, which
// long-polls the new `/api/internal/instruction-fetch` endpoint; the
// endpoint atomically consumes the row via `consumeInstructionForRun` and
// returns the instruction as the tool result.
//
// Atomic-flip pattern mirrors `pending_asks`: status guard in the UPDATE
// WHERE clause makes consume / cancel transitions idempotent against
// JSONL-replay re-fires or concurrent ping retries.

import { and, eq } from 'drizzle-orm';

import type { InstructionDepositRow, ULID } from '@pc/domain';

import { getDb } from '../connection.ts';
import { agentRuns, instructionDeposits } from '../schema.ts';

export interface DepositInstructionInput {
  /** PC-minted ULID. Wakeup key in the in-memory EventEmitter. */
  id: ULID;
  runId: ULID;
  projectId: ULID;
  dispatcherSessionId: string;
  instruction: string;
  now: number;
}

/** Insert one `waiting` row. Throws if a `waiting` row already exists for
 *  the run (partial unique index `instruction_deposits_run_waiting_idx`).
 *  Caller — the `pc_continue_agent` route — must be ordered after the
 *  Section 21.5 concurrent-continuation guard, which means the duplicate
 *  case is structurally unreachable; this insert is the belt-and-suspenders
 *  backstop. */
export function depositInstruction(
  input: DepositInstructionInput,
): InstructionDepositRow {
  const row: InstructionDepositRow = {
    id: input.id,
    runId: input.runId,
    projectId: input.projectId,
    dispatcherSessionId: input.dispatcherSessionId,
    instruction: input.instruction,
    status: 'waiting',
    depositedAt: input.now,
    consumedAt: null,
    cancelledAt: null,
  };
  getDb().insert(instructionDeposits).values(row).run();
  return row;
}

/** Atomic `waiting → consumed` transition keyed by `runId`. Returns the
 *  consumed row when the flip succeeded, `null` when no waiting row existed
 *  (already consumed / cancelled / never deposited). Used by the long-poll
 *  endpoint on both the deposit-already-present fast path and the
 *  wakeup-then-fetch deferred path. */
export function consumeInstructionForRun(
  runId: ULID,
  now: number,
): InstructionDepositRow | null {
  const db = getDb();
  // Two-step but transactionally safe: better-sqlite3's `.run()` returns the
  // row count, so we update-with-WHERE-status-waiting, then SELECT the row
  // by id. If the UPDATE flipped no rows we return null without the SELECT.
  // We can't UPDATE...RETURNING in better-sqlite3 cleanly via drizzle here,
  // so the pattern mirrors `markPendingAskAnswered` + a follow-up read.
  const waiting = db
    .select()
    .from(instructionDeposits)
    .where(
      and(eq(instructionDeposits.runId, runId), eq(instructionDeposits.status, 'waiting')),
    )
    .get();
  if (!waiting) return null;
  const res = db
    .update(instructionDeposits)
    .set({ status: 'consumed', consumedAt: now })
    .where(and(eq(instructionDeposits.id, waiting.id), eq(instructionDeposits.status, 'waiting')))
    .run();
  if (res.changes === 0) return null;
  return { ...waiting, status: 'consumed', consumedAt: now };
}

/** Atomic `waiting → cancelled` transition for a single row, used by orphan
 *  reconciliation and the cancel path. Returns `true` when the flip
 *  succeeded. */
export function cancelInstruction(id: ULID, now: number): boolean {
  const res = getDb()
    .update(instructionDeposits)
    .set({ status: 'cancelled', cancelledAt: now })
    .where(and(eq(instructionDeposits.id, id), eq(instructionDeposits.status, 'waiting')))
    .run();
  return res.changes > 0;
}

/** Returns the `waiting` row for a run, or null. Read-only inspection;
 *  callers that intend to deliver must use `consumeInstructionForRun` (the
 *  atomic flip is the load-bearing guard against double-delivery). */
export function findWaitingForRun(runId: ULID): InstructionDepositRow | null {
  const row = getDb()
    .select()
    .from(instructionDeposits)
    .where(
      and(eq(instructionDeposits.runId, runId), eq(instructionDeposits.status, 'waiting')),
    )
    .get();
  return row ?? null;
}

/** Boot-time reconciliation sweep. Any `waiting` row whose target run is no
 *  longer `running` (the agent died, or the server bounced after deposit but
 *  before consume) is flipped to `cancelled`. Mirrors
 *  `reconcileOrphanedRunningRuns` for `agent_runs`. Returns the count of
 *  rows affected. Implementation walks the `waiting` rows and looks each
 *  one up in `agent_runs` — small N (only mid-flight deposits at boot), so
 *  the per-row lookup is fine. */
export function reconcileOrphanedInstructionDeposits(now: number): number {
  const db = getDb();
  const waiting = db
    .select()
    .from(instructionDeposits)
    .where(eq(instructionDeposits.status, 'waiting'))
    .all();
  if (waiting.length === 0) return 0;
  let count = 0;
  for (const row of waiting) {
    const run = db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, row.runId))
      .get();
    if (run && run.status === 'running') continue;
    const res = db
      .update(instructionDeposits)
      .set({ status: 'cancelled', cancelledAt: now })
      .where(and(eq(instructionDeposits.id, row.id), eq(instructionDeposits.status, 'waiting')))
      .run();
    if (res.changes > 0) count += 1;
  }
  return count;
}
