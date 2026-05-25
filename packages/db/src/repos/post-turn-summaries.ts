// Section 31.12 — post-turn summary log repo. Write-mostly today; reads land
// when the UI surface is designed (deferred per buildout). Listing helpers
// included for ad-hoc inspection + future surface.

import { and, desc, eq } from 'drizzle-orm';

import type { ULID } from '@pc/domain';
import { getDb } from '../connection.ts';
import { postTurnSummaries } from '../schema.ts';

export interface InsertPostTurnSummaryInput {
  id: ULID;
  projectId: ULID;
  sessionId: string | null;
  summarizesUuid: string | null;
  statusCategory: string | null;
  statusDetail: string | null;
  isNoteworthy: boolean;
  title: string | null;
  description: string | null;
  recentAction: string | null;
  needsAction: boolean;
  artifactUrls: unknown;
  timestamp: string | null;
  createdAt: number;
  raw: unknown;
}

export interface PostTurnSummaryRow {
  id: ULID;
  projectId: ULID;
  sessionId: string | null;
  summarizesUuid: string | null;
  statusCategory: string | null;
  statusDetail: string | null;
  isNoteworthy: boolean;
  title: string | null;
  description: string | null;
  recentAction: string | null;
  needsAction: boolean;
  artifactUrls: unknown;
  timestamp: string | null;
  createdAt: number;
  raw: unknown;
}

/** Insert a row. Idempotent on `summarizesUuid` within `projectId` — if CC
 *  re-emits the same summary on replay we silently skip. */
export function insertPostTurnSummary(input: InsertPostTurnSummaryInput): void {
  const db = getDb();
  if (input.summarizesUuid) {
    const existing = db
      .select({ id: postTurnSummaries.id })
      .from(postTurnSummaries)
      .where(
        and(
          eq(postTurnSummaries.projectId, input.projectId),
          eq(postTurnSummaries.summarizesUuid, input.summarizesUuid),
        ),
      )
      .get();
    if (existing) return;
  }
  db.insert(postTurnSummaries)
    .values({
      id: input.id,
      projectId: input.projectId,
      sessionId: input.sessionId,
      summarizesUuid: input.summarizesUuid,
      statusCategory: input.statusCategory,
      statusDetail: input.statusDetail,
      isNoteworthy: input.isNoteworthy ? 1 : 0,
      title: input.title,
      description: input.description,
      recentAction: input.recentAction,
      needsAction: input.needsAction ? 1 : 0,
      artifactUrls: input.artifactUrls === null || input.artifactUrls === undefined
        ? null
        : JSON.stringify(input.artifactUrls),
      timestamp: input.timestamp,
      createdAt: input.createdAt,
      raw: JSON.stringify(input.raw),
    })
    .run();
}

/** Most-recent summaries for a project, newest first. `limit` defaults to 50. */
export function listPostTurnSummariesForProject(
  projectId: ULID,
  limit = 50,
): PostTurnSummaryRow[] {
  const rows = getDb()
    .select()
    .from(postTurnSummaries)
    .where(eq(postTurnSummaries.projectId, projectId))
    .orderBy(desc(postTurnSummaries.createdAt))
    .limit(limit)
    .all();
  return rows.map(rowToDomain);
}

/** All summaries for a single CC session, newest first. */
export function listPostTurnSummariesForSession(
  sessionId: string,
  limit = 200,
): PostTurnSummaryRow[] {
  const rows = getDb()
    .select()
    .from(postTurnSummaries)
    .where(eq(postTurnSummaries.sessionId, sessionId))
    .orderBy(desc(postTurnSummaries.createdAt))
    .limit(limit)
    .all();
  return rows.map(rowToDomain);
}

function rowToDomain(row: typeof postTurnSummaries.$inferSelect): PostTurnSummaryRow {
  return {
    id: row.id,
    projectId: row.projectId,
    sessionId: row.sessionId,
    summarizesUuid: row.summarizesUuid,
    statusCategory: row.statusCategory,
    statusDetail: row.statusDetail,
    isNoteworthy: row.isNoteworthy === 1,
    title: row.title,
    description: row.description,
    recentAction: row.recentAction,
    needsAction: row.needsAction === 1,
    artifactUrls: parseJsonOrNull(row.artifactUrls),
    timestamp: row.timestamp,
    createdAt: row.createdAt,
    raw: parseJsonOrNull(row.raw),
  };
}

function parseJsonOrNull(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
