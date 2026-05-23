// Generic "seed pod with drift-reseed" helper.
//
// Pulled out of orchestrator-pod-seed.ts (16a.2) so all stock pods can share
// the same trust model: insert if missing, auto-update if the live row has
// drifted from the seed and has only system-authored audit rows, skip + warn
// if the user has edited it.
//
// User edits are preserved by design — `hasUserAuthoredEdit` returns true if
// any audit row was written by something other than the orchestrator with a
// `system-seed:` / `system-reseed:` reason prefix. Once a user touches a
// stock pod through the UI, the seed stops updating it; source changes have
// to be applied manually via "Reset to default."

import {
  createAgent,
  getAgentByName,
  listAgentAudit,
  updateAgent,
  type CreateAgentInput,
  type UpdateAgentInput,
} from '@pc/db';
import type { PodAgentRow, PodAuditRow } from '@pc/domain';

export type SeedPodAction = 'inserted' | 'unchanged' | 'reseeded' | 'skipped-user-edited';

export interface SeedPodResult {
  action: SeedPodAction;
  agentId: string;
  /** Fields that drifted from the seed. Populated on `reseeded` (the fields
   *  just updated) and `skipped-user-edited` (the fields we *would* have
   *  updated had the row not been user-edited). */
  reseededFields: string[];
}

export interface SeedPodOptions {
  /** Tag prepended to the audit-log `reason` so boot-time log readers can tell
   *  what triggered the seed (e.g., `"16a.1"`, `"17e"`). */
  reasonTag: string;
}

const SYSTEM_SEED_REASON_PREFIXES = ['system-seed:', 'system-reseed:'];

/** Insert `content` if no row by that name+scope exists; otherwise update any
 *  drifted fields (unless the row has user-authored audit rows, in which case
 *  the live row is left alone and the drift is reported). */
export function seedPodWithDriftReseed(
  content: CreateAgentInput,
  opts: SeedPodOptions,
): SeedPodResult {
  const existing = getAgentByName({ name: content.name, scope: content.scope });
  if (!existing) {
    const row = createAgent(content, {
      actor: 'orchestrator',
      reason: `system-seed:${opts.reasonTag} — ${content.scope} ${content.name} pod created at boot`,
    });
    return { action: 'inserted', agentId: row.id, reseededFields: [] };
  }

  const drift = collectDriftedFields(existing, content);
  if (drift.length === 0) {
    return { action: 'unchanged', agentId: existing.id, reseededFields: [] };
  }

  if (hasUserAuthoredEdit(existing.id as PodAgentRow['id'])) {
    return { action: 'skipped-user-edited', agentId: existing.id, reseededFields: drift };
  }

  const patch: UpdateAgentInput = {};
  for (const key of drift) {
    (patch as Record<string, unknown>)[key] = (content as unknown as Record<string, unknown>)[key];
  }
  updateAgent(existing.id as PodAgentRow['id'], patch, {
    actor: 'orchestrator',
    reason: `system-reseed:${opts.reasonTag} — ${content.name} drift on fields [${drift.join(', ')}]`,
  });
  return { action: 'reseeded', agentId: existing.id, reseededFields: drift };
}

const SEED_OWNED_FIELDS = [
  'prompt',
  'tools',
  'model',
  'effort',
  'maxTurns',
  'outputDestination',
  'description',
] as const;

function collectDriftedFields(live: PodAgentRow, content: CreateAgentInput): string[] {
  const drift: string[] = [];
  const seed = content as unknown as Record<string, unknown>;
  const liveAny = live as unknown as Record<string, unknown>;
  for (const f of SEED_OWNED_FIELDS) {
    if (JSON.stringify(seed[f]) !== JSON.stringify(liveAny[f])) drift.push(f);
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
