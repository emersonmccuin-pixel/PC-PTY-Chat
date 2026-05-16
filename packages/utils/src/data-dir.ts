import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the PC data directory.
 *
 * Override via `PC_DATA_DIR` (launch-only; restart required if changed mid-run).
 * Rig-phase default: `<cwd>/data` — when the user runs `pnpm dev` from the repo
 * root, this lands at `<repo-root>/data`, matching what the JSON-file readers
 * used. When chassis work moves to shipped form, switch the default to
 * `~/.project-companion/` per the locked stack.
 */
export function getDataDir(): string {
  const env = process.env.PC_DATA_DIR;
  if (env && env !== 'undefined') return expandTilde(env);
  return join(process.cwd(), 'data');
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}
