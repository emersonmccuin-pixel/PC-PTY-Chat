import { and, eq } from 'drizzle-orm';
import type { ULID, Worktree, WorktreeStatus } from '@pc/domain';
import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { worktrees } from '../schema.ts';

interface WorktreeRow {
  id: ULID;
  name: string;
  path: string;
  workItemId: ULID | null;
  workflowRunId: ULID | null;
  status: WorktreeStatus;
  createdAt: number;
  destroyedAt: number | null;
}

export function listActiveWorktrees(): Worktree[] {
  return getDb()
    .select()
    .from(worktrees)
    .where(eq(worktrees.status, 'active'))
    .all() as Worktree[];
}

export function getActiveWorktreeByName(name: string): Worktree | null {
  const row = getDb()
    .select()
    .from(worktrees)
    .where(and(eq(worktrees.name, name), eq(worktrees.status, 'active')))
    .get() as WorktreeRow | undefined;
  return row ?? null;
}

export interface UpsertWorktreeInput {
  name: string;
  path: string;
  workItemId?: ULID | null;
  workflowRunId?: ULID | null;
}

/** Insert a new active worktree row, or no-op if one already exists with the
 *  same name + path. Used by the worktree service after `git worktree add` succeeds. */
export function upsertWorktree(input: UpsertWorktreeInput): Worktree {
  const existing = getActiveWorktreeByName(input.name);
  if (existing && existing.path === input.path) return existing;
  // Different path or missing → mark any active row by name as destroyed first.
  if (existing) markWorktreeDestroyed(input.name);
  const now = Date.now();
  const row: WorktreeRow = {
    id: newId(),
    name: input.name,
    path: input.path,
    workItemId: input.workItemId ?? null,
    workflowRunId: input.workflowRunId ?? null,
    status: 'active',
    createdAt: now,
    destroyedAt: null,
  };
  getDb().insert(worktrees).values(row).run();
  return row;
}

export function markWorktreeDestroyed(name: string): void {
  getDb()
    .update(worktrees)
    .set({ status: 'destroyed', destroyedAt: Date.now() })
    .where(and(eq(worktrees.name, name), eq(worktrees.status, 'active')))
    .run();
}
