// Worktree service. Wraps @pc/runtime's git helpers with an in-memory cache
// (for UI polls) and DB-side tracking (for forward-compat work-item / run
// bindings). Replaced the data/worktrees.json shape with sqlite.

import { resolve } from 'node:path';

import {
  attachWorktree,
  createWorktree,
  destroyWorktree,
  listWorktrees,
  pruneWorktrees,
  type WorktreeEntry,
} from '@pc/runtime';
import { markWorktreeDestroyed, upsertWorktree } from '@pc/db';

export interface WorktreeRegistry {
  updatedAt: string;
  worktrees: WorktreeEntry[];
}

export class WorktreeService {
  private cache: WorktreeRegistry = { updatedAt: new Date(0).toISOString(), worktrees: [] };

  constructor(private readonly workspaceDir: string) {}

  async list(): Promise<WorktreeEntry[]> {
    const entries = await listWorktrees(this.workspaceDir);
    this.cache = { updatedAt: new Date().toISOString(), worktrees: entries };
    // Reconcile DB rows with git's view. Main repo (entries[0]) is the
    // workspace itself; don't track it.
    for (const entry of entries.slice(1)) {
      const name = nameFromPath(entry.path);
      if (name) upsertWorktree({ name, path: entry.path });
    }
    return entries;
  }

  async create(name: string): Promise<WorktreeEntry> {
    const entry = await createWorktree(this.workspaceDir, name);
    upsertWorktree({ name, path: entry.path });
    await this.refresh();
    return entry;
  }

  async destroy(target: string, force = false): Promise<void> {
    await destroyWorktree(this.workspaceDir, target, { force });
    const name = isAbsolutePath(target) ? nameFromPath(target) : target;
    if (name) markWorktreeDestroyed(name);
    await this.refresh();
  }

  /**
   * Idempotent "ensure a worktree named `name` exists". 8b orphan-recovery:
   * prune stale registrations, return the existing entry if the dir is already
   * attached, else try a fresh create, falling back to `git worktree add` (no
   * `-b`) if the branch already exists from a previous failed dispatch.
   */
  async ensureWorktree(name: string): Promise<WorktreeEntry> {
    await pruneWorktrees(this.workspaceDir);
    const wtPath = resolve(this.workspaceDir, '..', 'worktrees', name);
    const existing = await listWorktrees(this.workspaceDir);
    const match = existing.find((e) => normalize(e.path) === normalize(wtPath));
    if (match) {
      this.cache = { updatedAt: new Date().toISOString(), worktrees: existing };
      upsertWorktree({ name, path: match.path });
      return match;
    }
    try {
      return await this.create(name);
    } catch (err) {
      const msg = (err as Error).message;
      if (!/already exists|already used by worktree|already checked out/i.test(msg)) {
        throw err;
      }
      const entry = await attachWorktree(this.workspaceDir, name);
      upsertWorktree({ name, path: entry.path });
      await this.refresh();
      return entry;
    }
  }

  /** Cached read for polling endpoints. Empty until the first list() / mutate(). */
  readCached(): WorktreeRegistry {
    return this.cache;
  }

  private async refresh(): Promise<void> {
    try {
      await this.list();
    } catch {
      /* best-effort */
    }
  }
}

function normalize(p: string): string {
  return resolve(p).toLowerCase();
}

function nameFromPath(p: string): string | null {
  const segments = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return segments[segments.length - 1] ?? null;
}

function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/');
}
