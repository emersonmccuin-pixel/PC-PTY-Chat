// Worktree primitive. Shells out to git from the workspace cwd.
// Both @pc/mcp (orchestrator-facing tools) and @pc/server (UI-facing API)
// call into this.
//
// In PC this will sit alongside pty-session.ts as a runtime primitive; the
// apps/server service layer wraps it with persistence.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const exec = promisify(execFile);

export interface WorktreeEntry {
  /** Absolute path on disk. */
  path: string;
  /** Short branch ref the worktree is checked out on, or null for detached. */
  branch: string | null;
  /** Commit SHA. */
  head: string;
}

/**
 * Create a worktree as a sibling of the workspace dir. `name` is used as both
 * the directory name (under `<workspace>/../worktrees/`) and the branch name.
 */
export async function createWorktree(workspaceDir: string, name: string): Promise<WorktreeEntry> {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error(`invalid worktree name: ${JSON.stringify(name)} (must match [a-zA-Z0-9._-]+)`);
  }
  const wsAbs = resolve(workspaceDir);
  const wtPath = resolve(wsAbs, '..', 'worktrees', name);
  await exec('git', ['worktree', 'add', wtPath, '-b', name], { cwd: wsAbs });
  const all = await listWorktrees(wsAbs);
  const entry = all.find((w) => normalize(w.path) === normalize(wtPath));
  if (!entry) throw new Error(`worktree created but not found in list: ${wtPath}`);
  return entry;
}

export async function listWorktrees(workspaceDir: string): Promise<WorktreeEntry[]> {
  const { stdout } = await exec('git', ['worktree', 'list', '--porcelain'], {
    cwd: resolve(workspaceDir),
  });
  return parsePorcelain(stdout);
}

/**
 * Remove a worktree. `target` can be an absolute path or a name relative to
 * `<workspace>/../worktrees/`.
 */
export async function destroyWorktree(
  workspaceDir: string,
  target: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const wsAbs = resolve(workspaceDir);
  const isAbs = /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith('/');
  const wtPath = isAbs ? target : resolve(wsAbs, '..', 'worktrees', target);
  const args = ['worktree', 'remove'];
  if (opts.force) args.push('--force');
  args.push(wtPath);
  await exec('git', args, { cwd: wsAbs });
}

/** Clean up worktree registrations for paths that no longer exist on disk. */
export async function pruneWorktrees(workspaceDir: string): Promise<void> {
  await exec('git', ['worktree', 'prune'], { cwd: resolve(workspaceDir) });
}

/**
 * Attach an existing branch as a worktree (no `-b`). Used to recover from
 * "branch exists but worktree dir is gone" — i.e. orphaned branch from a
 * failed prior dispatch. Workspace dir = git root.
 */
export async function attachWorktree(
  workspaceDir: string,
  name: string,
): Promise<WorktreeEntry> {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error(`invalid worktree name: ${JSON.stringify(name)} (must match [a-zA-Z0-9._-]+)`);
  }
  const wsAbs = resolve(workspaceDir);
  const wtPath = resolve(wsAbs, '..', 'worktrees', name);
  await exec('git', ['worktree', 'add', wtPath, name], { cwd: wsAbs });
  const all = await listWorktrees(wsAbs);
  const entry = all.find((w) => normalize(w.path) === normalize(wtPath));
  if (!entry) throw new Error(`worktree attached but not found in list: ${wtPath}`);
  return entry;
}

function parsePorcelain(stdout: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let cur: Partial<WorktreeEntry> = {};
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (cur.path) out.push(finalize(cur));
      cur = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length);
      cur.branch = ref.replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.branch = null;
    }
  }
  if (cur.path) out.push(finalize(cur));
  return out;
}

function finalize(c: Partial<WorktreeEntry>): WorktreeEntry {
  return { path: c.path!, branch: c.branch ?? null, head: c.head ?? '' };
}

function normalize(p: string): string {
  return resolve(p).toLowerCase();
}
