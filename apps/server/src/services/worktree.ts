// Worktree service. Wraps @pc/runtime's git helpers with persistence to
// data/worktrees.json. The rig UI reads that file via /api/worktrees; the
// MCP server (separate process) also keeps it fresh after orchestrator-driven
// operations.
//
// In PC this becomes apps/server/src/services/worktree.ts with the JSON
// persistence swapped for a Drizzle table — same shape.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  attachWorktree,
  createWorktree,
  destroyWorktree,
  listWorktrees,
  pruneWorktrees,
  type WorktreeEntry,
} from '@pc/runtime';

export interface WorktreeRegistry {
  updatedAt: string;
  worktrees: WorktreeEntry[];
}

export class WorktreeService {
  constructor(
    private readonly workspaceDir: string,
    private readonly registryFile: string,
  ) {}

  async list(): Promise<WorktreeEntry[]> {
    const entries = await listWorktrees(this.workspaceDir);
    this.persist(entries);
    return entries;
  }

  async create(name: string): Promise<WorktreeEntry> {
    const entry = await createWorktree(this.workspaceDir, name);
    await this.refresh();
    return entry;
  }

  async destroy(target: string, force = false): Promise<void> {
    await destroyWorktree(this.workspaceDir, target, { force });
    await this.refresh();
  }

  /**
   * Idempotent "ensure a worktree named `name` exists". 8b orphan-recovery
   * pattern: prune stale registrations, return the existing entry if the dir
   * is already attached, else try a fresh create, falling back to
   * `git worktree add <path> <name>` (no `-b`) if the branch already exists
   * from a previous failed dispatch.
   */
  async ensureWorktree(name: string): Promise<WorktreeEntry> {
    await pruneWorktrees(this.workspaceDir);
    const wtPath = resolve(this.workspaceDir, '..', 'worktrees', name);
    const existing = await listWorktrees(this.workspaceDir);
    const match = existing.find((e) => normalize(e.path) === normalize(wtPath));
    if (match) {
      this.persist(existing);
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
      await this.refresh();
      return entry;
    }
  }

  /** Cached read — used by polling endpoints. Falls back to live git on miss. */
  readCached(): WorktreeRegistry {
    if (existsSync(this.registryFile)) {
      try {
        return JSON.parse(readFileSync(this.registryFile, 'utf-8')) as WorktreeRegistry;
      } catch {
        /* fall through */
      }
    }
    return { updatedAt: new Date(0).toISOString(), worktrees: [] };
  }

  private async refresh(): Promise<void> {
    try {
      const entries = await listWorktrees(this.workspaceDir);
      this.persist(entries);
    } catch {
      /* best-effort */
    }
  }

  private persist(entries: WorktreeEntry[]): void {
    try {
      mkdirSync(dirname(this.registryFile), { recursive: true });
      writeFileSync(
        this.registryFile,
        JSON.stringify({ updatedAt: new Date().toISOString(), worktrees: entries }, null, 2),
      );
    } catch {
      /* best-effort */
    }
  }
}

function normalize(p: string): string {
  return resolve(p).toLowerCase();
}
