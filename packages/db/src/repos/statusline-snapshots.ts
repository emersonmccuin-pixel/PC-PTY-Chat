// Section 31.11 — statusline snapshot repo. Write-heavy (1 row per turn);
// reads drive the Global Settings Usage tab + future cross-section
// aggregations. The in-memory `latestStatuslineByProject` Map in apps/server
// stays as the source for the live left-rail caps panel — this table is the
// historical record + the basis for daily / weekly / monthly rollups.

import { and, desc, eq, gte, sql } from 'drizzle-orm';

import type { ULID } from '@pc/domain';
import { getDb } from '../connection.ts';
import { statuslineSnapshots } from '../schema.ts';

export interface InsertStatuslineSnapshotInput {
  id: ULID;
  projectId: ULID;
  pcSessionId: string;
  ccSessionId: string | null;
  receivedAt: number;
  modelId: string | null;
  modelDisplayName: string | null;
  fiveHourPct: number | null;
  fiveHourResetsAt: string | null;
  sevenDayPct: number | null;
  sevenDayResetsAt: string | null;
  totalCostUsd: number | null;
  totalDurationMs: number | null;
  totalApiDurationMs: number | null;
  contextCurrentUsage: number | null;
  contextWindowSize: number | null;
  contextUsedPercentage: number | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
}

export interface StatuslineSnapshotRow extends InsertStatuslineSnapshotInput {}

export function insertStatuslineSnapshot(input: InsertStatuslineSnapshotInput): void {
  getDb().insert(statuslineSnapshots).values(input).run();
}

/** Latest snapshot per `pcSessionId` within a time window. The cost +
 *  token fields on the latest snapshot are end-of-session running totals —
 *  sum across sessions to get the period total. */
export function listLatestSnapshotPerSession(
  sinceMs: number,
): Pick<
  StatuslineSnapshotRow,
  | 'pcSessionId'
  | 'projectId'
  | 'receivedAt'
  | 'totalCostUsd'
  | 'modelId'
  | 'totalInputTokens'
  | 'totalOutputTokens'
>[] {
  // sqlite ROW_NUMBER() partition over (pc_session_id) ordered by received_at
  // desc; take rn=1 = latest. Drizzle's typed select doesn't cover window
  // functions natively — go raw for this one.
  const rows = getDb().all<{
    pc_session_id: string;
    project_id: string;
    received_at: number;
    total_cost_usd: number | null;
    model_id: string | null;
    total_input_tokens: number | null;
    total_output_tokens: number | null;
  }>(sql`
    SELECT pc_session_id, project_id, received_at, total_cost_usd, model_id,
           total_input_tokens, total_output_tokens
    FROM (
      SELECT
        pc_session_id,
        project_id,
        received_at,
        total_cost_usd,
        model_id,
        total_input_tokens,
        total_output_tokens,
        ROW_NUMBER() OVER (
          PARTITION BY pc_session_id
          ORDER BY received_at DESC
        ) AS rn
      FROM statusline_snapshots
      WHERE received_at >= ${sinceMs}
    ) ranked
    WHERE rn = 1
    ORDER BY received_at DESC
  `);
  return rows.map((r) => ({
    pcSessionId: r.pc_session_id,
    projectId: r.project_id as ULID,
    receivedAt: r.received_at,
    totalCostUsd: r.total_cost_usd,
    modelId: r.model_id,
    totalInputTokens: r.total_input_tokens,
    totalOutputTokens: r.total_output_tokens,
  }));
}

/** Most-recent snapshot for a project (any session). Drives the initial-
 *  fetch path so the rail caps don't blank on first paint. */
export function getLatestSnapshotForProject(
  projectId: ULID,
): StatuslineSnapshotRow | null {
  const row = getDb()
    .select()
    .from(statuslineSnapshots)
    .where(eq(statuslineSnapshots.projectId, projectId))
    .orderBy(desc(statuslineSnapshots.receivedAt))
    .limit(1)
    .get();
  return row ? rowToDomain(row) : null;
}

/** All snapshots for a session, newest first. Forensic / sub-buildout future. */
export function listSnapshotsForSession(
  pcSessionId: string,
  limit = 500,
): StatuslineSnapshotRow[] {
  const rows = getDb()
    .select()
    .from(statuslineSnapshots)
    .where(eq(statuslineSnapshots.pcSessionId, pcSessionId))
    .orderBy(desc(statuslineSnapshots.receivedAt))
    .limit(limit)
    .all();
  return rows.map(rowToDomain);
}

/** Snapshots within a project + time window, newest first. */
export function listSnapshotsForProjectSince(
  projectId: ULID,
  sinceMs: number,
  limit = 5000,
): StatuslineSnapshotRow[] {
  const rows = getDb()
    .select()
    .from(statuslineSnapshots)
    .where(
      and(
        eq(statuslineSnapshots.projectId, projectId),
        gte(statuslineSnapshots.receivedAt, sinceMs),
      ),
    )
    .orderBy(desc(statuslineSnapshots.receivedAt))
    .limit(limit)
    .all();
  return rows.map(rowToDomain);
}

function rowToDomain(
  row: typeof statuslineSnapshots.$inferSelect,
): StatuslineSnapshotRow {
  return {
    id: row.id,
    projectId: row.projectId,
    pcSessionId: row.pcSessionId,
    ccSessionId: row.ccSessionId,
    receivedAt: row.receivedAt,
    modelId: row.modelId,
    modelDisplayName: row.modelDisplayName,
    fiveHourPct: row.fiveHourPct,
    fiveHourResetsAt: row.fiveHourResetsAt,
    sevenDayPct: row.sevenDayPct,
    sevenDayResetsAt: row.sevenDayResetsAt,
    totalCostUsd: row.totalCostUsd,
    totalDurationMs: row.totalDurationMs,
    totalApiDurationMs: row.totalApiDurationMs,
    contextCurrentUsage: row.contextCurrentUsage,
    contextWindowSize: row.contextWindowSize,
    contextUsedPercentage: row.contextUsedPercentage,
    totalInputTokens: row.totalInputTokens,
    totalOutputTokens: row.totalOutputTokens,
  };
}
