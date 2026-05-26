// Section 6.6 — per-row dismissals for the activity panel's "Failed
// recently" region. Tiny table (run_id PK + dismissed_at) keyed by the
// workflow run's id. 19.12 — FK re-pointed at workflow_runs_v2 after the
// v1 table dropped (migration 0025).

import { eq, inArray } from 'drizzle-orm';

import type { ULID } from '@pc/domain';
import { getDb } from '../connection.ts';
import { failedRunDismissals, workflowRunsV2 } from '../schema.ts';

/** Returns the run-ids in `runIds` that have been dismissed. Caller filters
 *  the project's run list against the returned set. */
export function listFailedRunDismissalsForRuns(runIds: ULID[]): ULID[] {
  if (runIds.length === 0) return [];
  const rows = getDb()
    .select({ runId: failedRunDismissals.runId })
    .from(failedRunDismissals)
    .where(inArray(failedRunDismissals.runId, runIds))
    .all();
  return rows.map((r) => r.runId);
}

/** Returns all dismissed run-ids for a project. Scoped via a workflow_runs_v2
 *  join so we never leak cross-project rows. */
export function listFailedRunDismissalsForProject(projectId: ULID): ULID[] {
  const rows = getDb()
    .select({ runId: failedRunDismissals.runId })
    .from(failedRunDismissals)
    .innerJoin(workflowRunsV2, eq(workflowRunsV2.id, failedRunDismissals.runId))
    .where(eq(workflowRunsV2.projectId, projectId))
    .all();
  return rows.map((r) => r.runId);
}

/** Idempotent. Returns the dismissed_at that was actually stored (existing
 *  rows are NOT updated — the dismissal is a one-shot per run). */
export function dismissFailedRun(runId: ULID, now: number): number {
  const db = getDb();
  const existing = db
    .select({ dismissedAt: failedRunDismissals.dismissedAt })
    .from(failedRunDismissals)
    .where(eq(failedRunDismissals.runId, runId))
    .get();
  if (existing) return existing.dismissedAt;
  db.insert(failedRunDismissals)
    .values({ runId, dismissedAt: now })
    .run();
  return now;
}
