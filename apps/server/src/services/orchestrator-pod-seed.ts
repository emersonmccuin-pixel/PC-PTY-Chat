// Section 16a.2 — Idempotent boot-time seed for the global orchestrator pod.
//
// Thin wrapper around `seedPodWithDriftReseed` (the same helper stock pods
// use). Lives in its own module so the boot sequence in index.ts can call it
// out separately — the orchestrator is the user's chat session, so log
// messages distinguish it from the worker pods.
//
// Behavior:
//   - No live row → insert from `ORCHESTRATOR_POD_CONTENT` + audit-log the
//     `'created'` row with reason prefixed `system-seed:`.
//   - Live row's content matches the seed → no-op.
//   - Live row differs AND row has never been user-edited → auto-update via
//     `updateAgent` + audit each changed field with `system-reseed:`. This
//     keeps existing dev installs in sync with source edits.
//   - Live row differs AND has user-authored audit rows → skip + warn.

import { ORCHESTRATOR_POD_CONTENT } from './orchestrator-pod-content.ts';
import { seedPodWithDriftReseed, type SeedPodAction } from './pod-seed-with-drift.ts';

export type SeedOrchestratorPodAction = SeedPodAction;

export interface SeedOrchestratorPodResult {
  /** True when this boot performed the insert. */
  seeded: boolean;
  /** What the seed actually did this boot. Caller logs the distinction so
   *  first-boot vs steady-state vs auto-reseed vs user-edit-skip is visible
   *  in server stdout. */
  action: SeedOrchestratorPodAction;
  /** The orchestrator pod row's id. Empty string only if the seed function
   *  couldn't resolve the row (shouldn't happen post-insert). */
  agentId: string;
  /** Field names that changed on a reseed. Empty for other actions. */
  reseededFields: string[];
}

/** Idempotently ensure the global orchestrator pod row exists + matches the
 *  current `ORCHESTRATOR_POD_CONTENT`. Safe to call multiple times. */
export function seedOrchestratorPodIfMissing(): SeedOrchestratorPodResult {
  const result = seedPodWithDriftReseed(ORCHESTRATOR_POD_CONTENT, { reasonTag: '16a.1' });
  return {
    seeded: result.action === 'inserted',
    action: result.action,
    agentId: result.agentId,
    reseededFields: result.reseededFields,
  };
}
