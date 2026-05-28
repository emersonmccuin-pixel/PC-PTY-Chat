import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Project, ProjectKind, ProjectSettings, Stage, ULID } from '@pc/domain';
import { withProjectSettingsDefaults } from '@pc/domain';
import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { projects } from '../schema.ts';

export interface CreateProjectInput {
  /** Pre-generated ULID. Optional — when omitted the repo mints a new one.
   *  Used by the create-project flow so the scaffold pass (which embeds the
   *  id into hooks + .mcp.json) and the DB row share an identity. */
  id?: ULID;
  slug: string;
  name: string;
  stages: Stage[];
  folderPath: string;
  gitRemote?: string | null;
  settings?: Record<string, unknown>;
  /** Section 34 — defaults to `'standard'`. The boot-time Quick Tasks seed
   *  is the only caller that passes `'quick-tasks'`. */
  kind?: ProjectKind;
}

export interface AdoptQuickTasksProjectInput {
  id: ULID;
  name: string;
  stages: Stage[];
  folderPath: string;
}

interface ProjectRow {
  id: ULID;
  slug: string;
  name: string;
  settings: Record<string, unknown>;
  stages: Stage[];
  folderPath: string;
  gitRemote: string | null;
  kind: ProjectKind;
  callsignSeq: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

function toDomain(row: ProjectRow): Project {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    stages: row.stages,
    folderPath: row.folderPath,
    gitRemote: row.gitRemote,
    settings: withProjectSettingsDefaults(row.settings as Partial<ProjectSettings>),
    kind: row.kind ?? 'standard',
    callsignSeq: row.callsignSeq ?? 0,
  };
}

export interface ListProjectsOptions {
  /** Include soft-deleted rows. Off by default — P11's `?include_deleted=1`
   *  is the only caller that opts in. */
  includeDeleted?: boolean;
}

export function listProjects(opts: ListProjectsOptions = {}): Project[] {
  // Order by `position` asc, breaking ties on `created_at` so two rows that
  // somehow share a position stay in a deterministic order.
  const q = getDb()
    .select()
    .from(projects)
    .orderBy(asc(projects.position), asc(projects.createdAt));
  const rows = (opts.includeDeleted
    ? q.all()
    : q.where(isNull(projects.deletedAt)).all()) as ProjectRow[];
  return rows.map(toDomain);
}

export function getProjectById(id: ULID): Project | null {
  const row = getDb()
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
    .get() as ProjectRow | undefined;
  return row ? toDomain(row) : null;
}

export function getProjectBySlug(slug: string): Project | null {
  const row = getDb()
    .select()
    .from(projects)
    .where(and(eq(projects.slug, slug), isNull(projects.deletedAt)))
    .get() as ProjectRow | undefined;
  return row ? toDomain(row) : null;
}

export function createProject(input: CreateProjectInput): Project {
  const now = Date.now();
  const id = input.id ?? newId();
  const gitRemote = input.gitRemote ?? null;
  const kind: ProjectKind = input.kind ?? 'standard';
  // 5+.4 (D87) — new projects land at the bottom of the rail. Soft-deleted
  // rows still count toward `max(position)` so the position space stays gap-
  // free across the lifetime of a project (cheaper than re-compacting on
  // soft-delete).
  const maxPos = getDb()
    .select({ v: sql<number | null>`max(${projects.position})` })
    .from(projects)
    .get() as { v: number | null } | undefined;
  const position = (maxPos?.v ?? -1) + 1;
  getDb()
    .insert(projects)
    .values({
      id,
      slug: input.slug,
      name: input.name,
      stages: input.stages,
      folderPath: input.folderPath,
      gitRemote,
      settings: input.settings ?? {},
      position,
      kind,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return {
    id,
    slug: input.slug,
    name: input.name,
    stages: input.stages,
    folderPath: input.folderPath,
    gitRemote,
    settings: withProjectSettingsDefaults(input.settings as Partial<ProjectSettings> | undefined),
    kind,
    callsignSeq: 0,
  };
}

/** Section 34 — return the single live Quick Tasks project, or null if the
 *  seed hasn't run yet. `ensureQuickTasksProject` in the server-side service
 *  is the canonical write path. */
export function findQuickTasksProject(): Project | null {
  const row = getDb()
    .select()
    .from(projects)
    .where(and(eq(projects.kind, 'quick-tasks'), isNull(projects.deletedAt)))
    .get() as ProjectRow | undefined;
  return row ? toDomain(row) : null;
}

/** Promote the legacy boot-seeded Quick Tasks row created before `kind`
 *  existed. Kept explicit so arbitrary user projects are not silently
 *  reclassified by generic metadata edits. */
export function adoptProjectAsQuickTasks(input: AdoptQuickTasksProjectInput): Project | null {
  getDb()
    .update(projects)
    .set({
      name: input.name,
      stages: input.stages,
      folderPath: input.folderPath,
      kind: 'quick-tasks',
      updatedAt: Date.now(),
    })
    .where(and(eq(projects.id, input.id), isNull(projects.deletedAt)))
    .run();
  return findQuickTasksProject();
}

/** 5+.4 (D87) — drag-reorder. Rewrites the `position` column for the given
 *  IDs in order (0..N-1). Wrapped in a transaction so a partial failure can't
 *  leave the rail in a torn state. Unknown IDs are silently skipped — the API
 *  layer is the right place to enforce membership; this repo is just persist. */
export function reorderProjects(orderedIds: ULID[]): void {
  if (orderedIds.length === 0) return;
  const db = getDb();
  // Sanity-clamp against the existing membership so a stale list can't
  // promote a deleted row's position.
  const live = (db
    .select({ id: projects.id })
    .from(projects)
    .where(and(isNull(projects.deletedAt), inArray(projects.id, orderedIds)))
    .all() as { id: ULID }[]).map((r) => r.id);
  const liveSet = new Set(live);
  const finalOrder = orderedIds.filter((id) => liveSet.has(id));
  const now = Date.now();
  // Single transaction — every row moves or none do.
  db.transaction((tx) => {
    finalOrder.forEach((id, idx) => {
      tx.update(projects)
        .set({ position: idx, updatedAt: now })
        .where(eq(projects.id, id))
        .run();
    });
  });
}

/** Update the stored stages for a project. */
export function updateProjectStages(id: ULID, stages: Stage[]): void {
  getDb()
    .update(projects)
    .set({ stages, updatedAt: Date.now() })
    .where(eq(projects.id, id))
    .run();
}

/** Soft-delete a project: flip `deleted_at`. Idempotent — returns the row
 *  whether or not it was already deleted. Returns null if no such project.
 *  Filesystem is not touched (per the soft-delete contract). */
export function softDeleteProject(id: ULID): Project | null {
  const existing = getDb()
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .get() as ProjectRow | undefined;
  if (!existing) return null;
  if (existing.deletedAt === null) {
    const now = Date.now();
    getDb()
      .update(projects)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(projects.id, id))
      .run();
  }
  return toDomain({ ...existing, deletedAt: existing.deletedAt ?? Date.now() });
}

export interface UpdateProjectMetaInput {
  /** Display name. Slug stays locked — rename → slug migration is deferred. */
  name?: string;
  /** Origin URL; pass `null` to clear. Omit to leave unchanged. */
  gitRemote?: string | null;
}

/** Patch the mutable metadata for a project (name + git remote). Returns
 *  the updated Project, or null if no such project (or soft-deleted). */
export function updateProjectMeta(id: ULID, input: UpdateProjectMetaInput): Project | null {
  const patch: { name?: string; gitRemote?: string | null; updatedAt: number } = {
    updatedAt: Date.now(),
  };
  if (typeof input.name === 'string') patch.name = input.name;
  if (input.gitRemote !== undefined) patch.gitRemote = input.gitRemote;
  if (patch.name === undefined && patch.gitRemote === undefined) {
    return getProjectById(id);
  }
  getDb()
    .update(projects)
    .set(patch)
    .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
    .run();
  return getProjectById(id);
}
