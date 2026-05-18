// Worktree service. Per-project: bound to one repo's workspace cwd and one
// trunk-side base dir under the data dir (`<data_dir>/worktrees/<slug>/`).
// Wraps @pc/runtime's git primitives with an in-memory cache (for UI polls)
// and DB-side tracking (for work-item / run bindings).
//
// Multi-tenancy (P6): path policy lives here. `<workspace>/../worktrees/` is
// dead — every worktree lives under the data dir, namespaced by project slug,
// so multiple projects don't fight for the same `worktrees/` dir and so
// nothing leaks into the user's actual repo.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

/** 4a.8 / D18. Scratch sweep threshold. Configurability deferred to Section 9
 *  (Global settings); for now this is the trunk default. */
export const SCRATCH_SWEEP_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export class WorktreeService {
  private cache: WorktreeRegistry = { updatedAt: new Date(0).toISOString(), worktrees: [] };

  /**
   * @param workspaceDir Absolute path to the project's git repo (cwd for git ops).
   * @param baseDir Absolute path under which this project's worktrees live —
   *   `<data_dir>/worktrees/<slug>/` per `docs/design/multi-tenancy.md` §4. Each
   *   worktree directory becomes `<baseDir>/<name>/`.
   */
  constructor(
    private readonly workspaceDir: string,
    private readonly baseDir: string,
  ) {}

  async list(): Promise<WorktreeEntry[]> {
    const entries = await listWorktrees(this.workspaceDir);
    this.cache = { updatedAt: new Date().toISOString(), worktrees: entries };
    // Reconcile DB rows with git's view. Main repo (entries[0]) is the
    // workspace itself; don't track it. Filter to entries under this project's
    // baseDir so a stray repo-local worktree doesn't end up in our table.
    const baseNorm = normalize(this.baseDir);
    for (const entry of entries.slice(1)) {
      if (!normalize(entry.path).startsWith(baseNorm)) continue;
      const name = nameFromPath(entry.path);
      if (name) upsertWorktree({ name, path: entry.path });
    }
    return entries;
  }

  async create(name: string): Promise<WorktreeEntry> {
    const wtPath = resolve(this.baseDir, name);
    const entry = await createWorktree(this.workspaceDir, wtPath, name);
    upsertWorktree({ name, path: entry.path });
    await this.refresh();
    return entry;
  }

  async destroy(target: string, force = false): Promise<void> {
    const wtPath = isAbsolutePath(target) ? target : resolve(this.baseDir, target);
    await destroyWorktree(this.workspaceDir, wtPath, { force });
    const name = nameFromPath(wtPath);
    if (name) markWorktreeDestroyed(name);
    await this.refresh();
  }

  /**
   * Idempotent "ensure a worktree named `name` exists" under this project's
   * baseDir. Orphan-recovery: prune stale registrations, return the existing
   * entry if the dir is already attached, else try a fresh create, falling
   * back to `git worktree add` (no `-b`) if the branch already exists from a
   * previous failed dispatch.
   */
  async ensureWorktree(name: string): Promise<WorktreeEntry> {
    await pruneWorktrees(this.workspaceDir);
    const wtPath = resolve(this.baseDir, name);
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
      const entry = await attachWorktree(this.workspaceDir, wtPath, name);
      upsertWorktree({ name, path: entry.path });
      await this.refresh();
      return entry;
    }
  }

  /** Cached read for polling endpoints. Empty until the first list() / mutate(). */
  readCached(): WorktreeRegistry {
    return this.cache;
  }

  /** 4a.8 / D18. Ensure `<worktreePath>/scratch/` exists + has a `.gitignore`
   *  with `*` so its contents are never tracked. Idempotent. Called from the
   *  runtime's dispatch path the first time a workflow targets the worktree. */
  ensureScratchDir(worktreePath: string): string {
    const scratchPath = resolve(worktreePath, 'scratch');
    mkdirSync(scratchPath, { recursive: true });
    const gitignore = resolve(scratchPath, '.gitignore');
    if (!existsSync(gitignore)) {
      writeFileSync(gitignore, '*\n!.gitignore\n', 'utf-8');
    }
    return scratchPath;
  }

  /** 4a.8 / D18. Wipe `<worktreePath>/scratch/`. Idempotent. Called on
   *  workflow terminal status when the workflow declares `scratch_cleanup:
   *  auto`. Re-creates the dir + .gitignore after removal so the next run
   *  starts clean without further setup. */
  wipeScratchDir(worktreePath: string): void {
    const scratchPath = resolve(worktreePath, 'scratch');
    if (existsSync(scratchPath)) {
      rmSync(scratchPath, { recursive: true, force: true });
    }
    this.ensureScratchDir(worktreePath);
  }

  /** 4a.8 / D18. Boot-time sweep. Walks this project's baseDir for first-
   *  level worktree dirs, removes top-level entries inside their `scratch/`
   *  whose mtime is older than the threshold. Top-level entries only — no
   *  recursive stat — pragmatic for v1; if dir-with-fresh-children needs to
   *  survive, the workflow author touches a sentinel file at the top level. */
  sweepStaleScratch(maxAgeMs: number = SCRATCH_SWEEP_MAX_AGE_MS): {
    removed: string[];
  } {
    const removed: string[] = [];
    if (!existsSync(this.baseDir)) return { removed };
    const cutoff = Date.now() - maxAgeMs;
    let worktreeDirs: string[] = [];
    try {
      worktreeDirs = readdirSync(this.baseDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => resolve(this.baseDir, e.name));
    } catch {
      return { removed };
    }
    for (const wt of worktreeDirs) {
      const scratchPath = resolve(wt, 'scratch');
      if (!existsSync(scratchPath)) continue;
      let entries: string[];
      try {
        entries = readdirSync(scratchPath);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (name === '.gitignore') continue;
        const entryPath = resolve(scratchPath, name);
        try {
          const stat = statSync(entryPath);
          if (stat.mtimeMs < cutoff) {
            rmSync(entryPath, { recursive: true, force: true });
            removed.push(entryPath);
          }
        } catch {
          /* best-effort */
        }
      }
    }
    return { removed };
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
