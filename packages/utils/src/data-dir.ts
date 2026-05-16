import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Resolve the PC data directory.
 *
 * Override via `PC_DATA_DIR` (launch-only; restart required if changed mid-run).
 * Rig-phase default: walk up from cwd to find `pnpm-workspace.yaml` and use
 * `<workspace-root>/data`. This makes the path robust to `pnpm --filter` cwd
 * changes (which point process.cwd() at the filtered package's dir, not the
 * workspace root). Falls back to `<cwd>/data` if no workspace root is found.
 * When chassis work moves to shipped form, switch the default to
 * `~/.project-companion/` per the locked stack.
 */
export function getDataDir(): string {
  const env = process.env.PC_DATA_DIR;
  if (env && env !== 'undefined') return expandTilde(env);
  const root = findWorkspaceRoot(process.cwd());
  return join(root, 'data');
}

function findWorkspaceRoot(start: string): string {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}
