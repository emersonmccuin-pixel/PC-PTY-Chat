// Section 17e starter (2026-05-21) — Idempotent boot-time seed for the
// global researcher pod row.
//
// Behavior matches `seedOrchestratorPodIfMissing` (16a.2):
//   - No live row → insert from `RESEARCHER_POD_CONTENT` + audit-log with
//     reason prefixed `system-seed:`.
//   - Live row matches the seed → no-op.
//   - Live row differs AND row has never been user-edited → auto-update +
//     audit-log with `system-reseed:`. B3 mitigation: dev iteration on the
//     pod content lands on existing installs automatically on next boot.
//   - Live row differs AND has user-authored audit rows → skip + warn.
//     User edits stay intact; latest seed content lands via the Pod UI (17d).
//
// Pulled forward as a Section 18 dependency (researcher needs the comms
// primitives in its tool list before V-3 + V-4 can run). The remaining four
// worker pods (writer / reviewer / planner / extractor) stay on the
// flat-file fallback path until the full 17e migration ships.

import {
  createAgent,
  getAgentByName,
  listAgentAudit,
  updateAgent,
  type UpdateAgentInput,
} from '@pc/db';
import type { PodAgentRow, PodAuditRow } from '@pc/domain';
import { RESEARCHER_POD_CONTENT } from './researcher-pod-content.ts';

export type SeedResearcherPodAction =
  | 'inserted'
  | 'unchanged'
  | 'reseeded'
  | 'skipped-user-edited';

export interface SeedResearcherPodResult {
  seeded: boolean;
  action: SeedResearcherPodAction;
  agentId: string;
  reseededFields: string[];
}

const SYSTEM_SEED_REASON_PREFIXES = ['system-seed:', 'system-reseed:'];

export function seedResearcherPodIfMissing(): SeedResearcherPodResult {
  const existing = getAgentByName({ name: 'researcher', scope: 'global' });
  if (!existing) {
    const row = createAgent(RESEARCHER_POD_CONTENT, {
      actor: 'orchestrator',
      reason:
        'system-seed:17e-starter — global researcher pod created at boot (Section 18 dependency for V-3/V-4)',
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
    (patch as Record<string, unknown>)[key] = (
      RESEARCHER_POD_CONTENT as unknown as Record<string, unknown>
    )[key];
  }
  updateAgent(existing.id as PodAgentRow['id'], patch, {
    actor: 'orchestrator',
    reason: `system-reseed: RESEARCHER_POD_CONTENT drift on fields [${drift.join(', ')}]`,
  });
  return { seeded: false, action: 'reseeded', agentId: existing.id, reseededFields: drift };
}

function collectDriftedFields(live: PodAgentRow): string[] {
  const drift: string[] = [];
  const seed = RESEARCHER_POD_CONTENT as unknown as Record<string, unknown>;
  const liveAny = live as unknown as Record<string, unknown>;
  const seedFields = [
    'prompt',
    'tools',
    'model',
    'effort',
    'maxTurns',
    'outputDestination',
    'description',
  ];
  for (const f of seedFields) {
    const a = seed[f];
    const b = liveAny[f];
    if (JSON.stringify(a) !== JSON.stringify(b)) drift.push(f);
  }
  return drift;
}

function hasUserAuthoredEdit(agentId: PodAgentRow['id']): boolean {
  const rows = listAgentAudit({ agentId, limit: 1000 });
  return rows.some((r: PodAuditRow) => !isSystemAuthored(r));
}

function isSystemAuthored(row: PodAuditRow): boolean {
  if (row.actor !== 'orchestrator') return false;
  const reason = row.reason ?? '';
  return SYSTEM_SEED_REASON_PREFIXES.some((p) => reason.startsWith(p));
}
