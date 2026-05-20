// Section 16a.2 — Idempotent boot-time seed for the global orchestrator pod.
//
// Runs once after `runMigrations()` on every server boot. If the live global
// pod row `(scope='global', name='orchestrator')` already exists, this is a
// no-op. Otherwise it inserts the row from `ORCHESTRATOR_POD_CONTENT` along
// with an `agent_audit` row attributing the creation to the boot-time seed
// (actor 'orchestrator', reason prefixed `system-seed:` so future UI can
// recognise + render distinctly from user/orchestrator-driven edits).
//
// User/orchestrator edits to the orchestrator pod after the first boot are
// preserved on subsequent boots — the seed never overwrites an existing row.
// Re-applying the canonical content after edits is a manual operation (delete
// the row + restart, or `pc_update_agent_*` MCP tools when those land in 17b).
//
// 16a.3 wires the orchestrator's spawn path through `preparePodSpawn` —
// which depends on this row existing. Without the seed, the orchestrator's
// first boot falls back to the legacy `--append-system-prompt-file` path (or
// fails outright, depending on 16a.3's fallback policy).

import { createAgent, getAgentByName } from '@pc/db';
import { ORCHESTRATOR_POD_CONTENT } from './orchestrator-pod-content.ts';

export interface SeedOrchestratorPodResult {
  /** True when this boot performed the insert; false when the row already
   *  existed. Caller logs the distinction so first-boot vs steady-state is
   *  visible in server stdout. */
  seeded: boolean;
  /** The orchestrator pod row's id, whether freshly minted or already
   *  present. Empty string when the seed function couldn't resolve the row
   *  (should never happen post-insert). */
  agentId: string;
}

/** Idempotently ensure the global orchestrator pod row exists. Safe to call
 *  multiple times — the existence check happens before any write. */
export function seedOrchestratorPodIfMissing(): SeedOrchestratorPodResult {
  const existing = getAgentByName({ name: 'orchestrator', scope: 'global' });
  if (existing) {
    return { seeded: false, agentId: existing.id };
  }
  const row = createAgent(ORCHESTRATOR_POD_CONTENT, {
    actor: 'orchestrator',
    reason: 'system-seed:16a.1 — global orchestrator pod created at boot',
  });
  return { seeded: true, agentId: row.id };
}
