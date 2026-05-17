import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Project, Stage, ULID } from '@pc/domain';
import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { projects } from '../schema.ts';

export interface CreateProjectInput {
  slug: string;
  name: string;
  stages: Stage[];
  folderPath: string;
  gitRemote?: string | null;
  settings?: Record<string, unknown>;
}

interface ProjectRow {
  id: ULID;
  slug: string;
  name: string;
  settings: Record<string, unknown>;
  stages: Stage[];
  folderPath: string;
  gitRemote: string | null;
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
  };
}

export function listProjects(): Project[] {
  const rows = getDb()
    .select()
    .from(projects)
    .where(isNull(projects.deletedAt))
    .orderBy(asc(projects.createdAt))
    .all() as ProjectRow[];
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
  const id = newId();
  const gitRemote = input.gitRemote ?? null;
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
  };
}

/** Update the stored stages for a project. */
export function updateProjectStages(id: ULID, stages: Stage[]): void {
  getDb()
    .update(projects)
    .set({ stages, updatedAt: Date.now() })
    .where(eq(projects.id, id))
    .run();
}
