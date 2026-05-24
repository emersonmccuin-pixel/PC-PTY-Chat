// Section 26.8 — ephemeral work-item auto-archive sweep.
//
// `pc_create_agent_work_item` accepts `ephemeral: true` for throwaway
// dispatches the orchestrator doesn't intend to keep around for archaeology.
// Once those contracts reach `complete` and sit idle for 24h, they should
// disappear from the (archive-included) work-item lists — soft-deleted via
// the existing `softDeleteWorkItem` semantics (deletedAt + status='archived'
// + version bump).
//
// Boot-time only. No interval timer. If the box runs for days the sweep
// doesn't re-fire; ephemeral rows then sit archived a day-or-two longer than
// the design target, which is fine — these are dispatch-throwaways. The
// next server restart catches them up.

import {
  listEphemeralCompletedOlderThan,
  softDeleteWorkItem,
} from '@pc/db';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface EphemeralSweepResult {
  /** Candidate rows the cutoff query returned. */
  scanned: number;
  /** Rows successfully soft-deleted. */
  archived: number;
}

export interface EphemeralSweepOptions {
  /** Retention window in ms. Defaults to 24 hours. Tests pass shorter. */
  retentionMs?: number;
  /** Anchor time for the cutoff. Defaults to `Date.now()`. Tests pass a
   *  deterministic value. */
  now?: number;
}

/** Sweep ephemeral, `complete` work items that have been idle past the
 *  retention window. Soft-delete via the standard repo helper so the
 *  flip stays in lockstep with manual archive — same status, same
 *  version-bump, same deletedAt write. Returns a counts pair for logging.
 *
 *  Non-throwing by contract: per-row failures (race with a concurrent
 *  archive, missing row between query + delete) are counted as skips by
 *  silently not bumping `archived`. The caller can log the delta.
 */
export function sweepEphemeralWorkItems(
  opts: EphemeralSweepOptions = {},
): EphemeralSweepResult {
  const retentionMs = opts.retentionMs ?? DAY_MS;
  const now = opts.now ?? Date.now();
  const cutoff = now - retentionMs;
  const candidates = listEphemeralCompletedOlderThan(cutoff);
  let archived = 0;
  for (const wi of candidates) {
    try {
      const result = softDeleteWorkItem(wi.id);
      if (result) archived += 1;
    } catch {
      // Per-row failure — race with a concurrent mutation. Skip silently;
      // boot-time sweep is best-effort.
    }
  }
  return { scanned: candidates.length, archived };
}
