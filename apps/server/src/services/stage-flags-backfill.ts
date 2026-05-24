// Section 27.3 — one-time stage-flag backfill for existing projects.
//
// Idempotent: skips any project that already has at least one flag set on any
// stage. For untouched projects:
//   - `is_new` lands on every project's stages[0] (sorted by order) — no
//     ambiguity, every project has a first stage.
//   - `is_done` lands on a stage whose name matches /^done$/i IF exactly one
//     such stage exists. Skipped on zero matches or multiple matches.
//   - No `is_cancelled` backfill — existing projects don't have a cancelled
//     stage; user adds one manually if they want it.

import { listProjects, updateProjectStages } from '@pc/db';
import type { Stage } from '@pc/domain';

export interface BackfillResult {
  scanned: number;
  /** Projects whose stages were rewritten. */
  updated: number;
  /** Projects skipped because at least one flag was already set. */
  skipped: number;
}

export function backfillStageFlags(): BackfillResult {
  const projects = listProjects();
  let updated = 0;
  let skipped = 0;

  for (const project of projects) {
    const stages = [...project.stages];
    const anyFlagSet = stages.some((s) => s.isDone || s.isCancelled || s.isNew);
    if (anyFlagSet) {
      skipped += 1;
      continue;
    }

    const sorted = stages.slice().sort((a, b) => a.order - b.order);
    if (sorted.length === 0) continue;

    const next: Stage[] = sorted.map((s, idx) => ({ ...s, order: idx }));

    // is_new on stages[0].
    next[0]!.isNew = true;

    // is_done on a single stage named "Done" (case-insensitive). Skip on
    // ambiguity.
    const doneMatches = next.filter((s) => /^done$/i.test(s.name));
    if (doneMatches.length === 1) {
      doneMatches[0]!.isDone = true;
    }

    updateProjectStages(project.id, next);
    updated += 1;
  }

  return { scanned: projects.length, updated, skipped };
}
