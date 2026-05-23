// Section 24.2 — Long-poll service for the agent ready-ping protocol.
//
// The new `pc_check_in` MCP tool's HTTP handler calls `awaitInstruction`
// to block for up to 60s waiting for an orchestrator-deposited instruction
// keyed by the agent's `PC_AGENT_RUN_ID`. The `pc_continue_agent` route
// calls `depositInstruction` (the repo write) followed by `notifyDeposit`
// (this service) to wake any pending long-poll.
//
// DB is the source of truth — the in-memory `EventEmitter` is wakeup
// optimization only. `consumeInstructionForRun`'s atomic-flip pattern is
// the load-bearing guard against double-delivery; if two pollers race the
// loser observes a null return from the consume + keeps waiting (or
// times out).

import { EventEmitter } from 'node:events';

import { consumeInstructionForRun } from '@pc/db';
import type { InstructionDepositRow, ULID } from '@pc/domain';

/** Default long-poll window. 60s per L5 in the buildout — generous for
 *  transport latency since the happy path is "deposit landed in the same
 *  pc_continue_agent route call that triggered the spawn." */
export const DEFAULT_INSTRUCTION_POLL_MS = 60_000;

const emitter = new EventEmitter();
// Many runs may have pollers; keep Node's default 10-listener cap from
// emitting spurious warnings on busy systems.
emitter.setMaxListeners(0);

/** Notify any long-polls waiting on this `runId` that a deposit landed.
 *  Idempotent — caller wires this in immediately after `depositInstruction`
 *  in the `pc_continue_agent` route. */
export function notifyDeposit(runId: ULID): void {
  emitter.emit(eventKey(runId));
}

export interface AwaitInstructionOptions {
  /** Override the poll window (mostly for tests). */
  timeoutMs?: number;
  /** Test injection point for monotonic time. */
  now?: () => number;
}

/** Block until an instruction is deposited for `runId` (and successfully
 *  atomically consumed) or the timeout elapses. Returns the consumed row
 *  on success, `null` on timeout. */
export async function awaitInstruction(
  runId: ULID,
  opts: AwaitInstructionOptions = {},
): Promise<InstructionDepositRow | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_INSTRUCTION_POLL_MS;
  const now = opts.now ?? (() => Date.now());

  // Fast path: the deposit may already be sitting on the shelf. This is
  // the expected case — `pc_continue_agent` deposits + emits BEFORE the
  // agent's spawn completes its first turn, so by the time `pc_check_in`
  // fires the row is almost always already there.
  const fast = consumeInstructionForRun(runId, now());
  if (fast) return fast;

  return new Promise<InstructionDepositRow | null>((resolve) => {
    let settled = false;

    const onDeposit = (): void => {
      if (settled) return;
      const row = consumeInstructionForRun(runId, now());
      if (!row) {
        // Another poller won the consume; keep listening. (In practice the
        // partial-unique index limits us to one waiting row per run, so a
        // race only happens if two `pc_check_in` polls landed for the same
        // run — not expected, but defensive.)
        return;
      }
      settled = true;
      cleanup();
      resolve(row);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    }, timeoutMs);

    const cleanup = (): void => {
      emitter.off(eventKey(runId), onDeposit);
      clearTimeout(timer);
    };

    emitter.on(eventKey(runId), onDeposit);
  });
}

function eventKey(runId: ULID): string {
  // Prefix-namespaced so this emitter can't collide with any other key
  // pattern if the file grows other event types later.
  return `deposit:${runId}`;
}

/** Test-only teardown — drop all listeners between cases so a leaked
 *  poller from a prior test doesn't fire spuriously. */
export function _resetInstructionEmitterForTests(): void {
  emitter.removeAllListeners();
}
