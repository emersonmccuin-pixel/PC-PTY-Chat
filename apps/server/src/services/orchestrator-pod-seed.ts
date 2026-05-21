// Section 16a.2 — Idempotent boot-time seed for the global orchestrator pod.
//
// Runs once after `runMigrations()` on every server boot.
//
// Behavior:
//   - No live row → insert from `ORCHESTRATOR_POD_CONTENT` + audit-log the
//     `'created'` row with reason prefixed `system-seed:`.
//   - Live row's content matches the seed → no-op.
//   - Live row's content differs from the seed AND the row has never been
//     user-edited (every audit row is actor='orchestrator' with a
//     `system-seed:` / `system-reseed:` reason) → auto-update via
//     `updateAgent` + audit each changed field with `system-reseed:`. This
//     is the B3 mitigation (2026-05-20): a seed-content update lands on
//     existing dev installs automatically on next boot, so iteration on the
//     orchestrator prompt doesn't strand users on a stale pod row.
//   - Live row differs AND has any user-authored audit row → skip + warn
//     to stderr. User edits stay intact; if the user wants the latest seed
//     content, they go through the Pod UI (17d) explicitly.
//
// 16a.3 wires the orchestrator's spawn path through `preparePodSpawn` —
// which depends on this row existing. Without the seed, the orchestrator's
// first boot falls back to the legacy `--append-system-prompt-file` path (or
// fails outright, depending on 16a.3's fallback policy).

import {
  createAgent,
  getAgentByName,
  listAgentAudit,
  updateAgent,
  type UpdateAgentInput,
} from '@pc/db';
import type { PodAgentRow, PodAuditRow } from '@pc/domain';
import { ORCHESTRATOR_POD_CONTENT } from './orchestrator-pod-content.ts';

export type SeedOrchestratorPodAction = 'inserted' | 'unchanged' | 'reseeded' | 'skipped-user-edited';

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

const SYSTEM_SEED_REASON_PREFIXES = ['system-seed:', 'system-reseed:'];

/** Idempotently ensure the global orchestrator pod row exists + matches the
 *  current `ORCHESTRATOR_POD_CONTENT`. Safe to call multiple times. */
export function seedOrchestratorPodIfMissing(): SeedOrchestratorPodResult {
  const existing = getAgentByName({ name: 'orchestrator', scope: 'global' });
  if (!existing) {
    const row = createAgent(ORCHESTRATOR_POD_CONTENT, {
      actor: 'orchestrator',
      reason: 'system-seed:16a.1 — global orchestrator pod created at boot',
    });
    return { seeded: true, action: 'inserted', agentId: row.id, reseededFields: [] };
  }

  const drift = collectDriftedFields(existing);
  if (drift.length === 0) {
    return { seeded: false, action: 'unchanged', agentId: existing.id, reseededFields: [] };
  }

  if (hasUserAuthoredEdit(existing.id as PodAgentRow['id'])) {
    return {
      seeded: false,
      action: 'skipped-user-edited',
      agentId: existing.id,
      reseededFields: drift,
    };
  }

  const patch: UpdateAgentInput = {};
  for (const key of drift) {
    (patch as Record<string, unknown>)[key] = (ORCHESTRATOR_POD_CONTENT as unknown as Record<string, unknown>)[key];
  }
  updateAgent(existing.id as PodAgentRow['id'], patch, {
    actor: 'orchestrator',
    reason: `system-reseed: ORCHESTRATOR_POD_CONTENT drift on fields [${drift.join(', ')}]`,
  });
  return { seeded: false, action: 'reseeded', agentId: existing.id, reseededFields: drift };
}

/** Fields the seed declares + whose live value differs from the seed value.
 *  Drives both the skip-vs-update decision and the audit-log reason text. */
function collectDriftedFields(live: PodAgentRow): string[] {
  const drift: string[] = [];
  const seed = ORCHESTRATOR_POD_CONTENT as unknown as Record<string, unknown>;
  const liveAny = live as unknown as Record<string, unknown>;
  // Fields the seed authoritatively sets. Skipped: id / createdAt / updatedAt
  // / deletedAt / scope / projectId (immutable post-create or not seed-owned).
  const seedFields = ['prompt', 'tools', 'model', 'effort', 'maxTurns', 'outputDestination', 'description'];
  for (const f of seedFields) {
    const a = seed[f];
    const b = liveAny[f];
    if (JSON.stringify(a) !== JSON.stringify(b)) drift.push(f);
  }
  return drift;
}

/** Walk the agent's audit log; return true if any row was written by a real
 *  user/MCP edit (anything that isn't `actor='orchestrator'` with a reason
 *  prefixed `system-seed:` or `system-reseed:`). Caps at 1000 rows — far more
 *  than the orchestrator pod will accrue in normal use. */
function hasUserAuthoredEdit(agentId: PodAgentRow['id']): boolean {
  const rows = listAgentAudit({ agentId, limit: 1000 });
  return rows.some((r: PodAuditRow) => !isSystemAuthored(r));
}

function isSystemAuthored(row: PodAuditRow): boolean {
  if (row.actor !== 'orchestrator') return false;
  const reason = row.reason ?? '';
  return SYSTEM_SEED_REASON_PREFIXES.some((p) => reason.startsWith(p));
}
