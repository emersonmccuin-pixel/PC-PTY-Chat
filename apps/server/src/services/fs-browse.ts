// Folder browser for the create-project picker UI. Lists one directory at a
// time so the UI can drill into subfolders. Default landing path is the
// user's home dir.
//
// Allowlist: by default the user can browse anywhere under their home dir.
// Extra roots (e.g. an external drive) can be opted-in via the
// `PC_FS_BROWSE_ALLOW` env var — comma-separated absolute paths. Outside
// roots are 403'd rather than 200'd-with-empty so the UI can surface a
// clear "not allowed" preview.
//
// `parent` is null when the listed path equals one of the allowlist roots —
// stops the picker from walking out of the allowed surface.

import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

export interface BrowseEntry {
  name: string;
  /** Absolute path. */
  path: string;
  isDirectory: boolean;
  /** True iff the name starts with a `.`. Hidden entries are still listed —
   *  the UI decides whether to show them. */
  isHidden: boolean;
}

export interface BrowseResult {
  /** Absolute path that was listed (after ~ expansion + normalize). */
  path: string;
  /** Parent path, or null when at an allowlist root. */
  parent: string | null;
  /** Sorted dirs-first, then files; case-insensitive within each group. */
  entries: BrowseEntry[];
}

export interface BrowseOptions {
  /** Override the user's home dir (test seam). */
  homeDir?: string;
  /** Override the env-driven allowlist (test seam). */
  extraAllowRoots?: string[];
}

/** List the directory at `input` (defaults to ~/). */
export function browseFolder(input: string | null | undefined, opts: BrowseOptions = {}): BrowseResult {
  const home = opts.homeDir ?? homedir();
  const allowRoots = [home, ...(opts.extraAllowRoots ?? readEnvAllowRoots())].map((r) => resolve(r));

  const raw = (input ?? '').trim();
  const expanded = raw ? expandHome(raw, home) : home;
  if (!isAbsolute(expanded)) {
    throw new BrowseError(`path must be absolute (got: ${JSON.stringify(input)})`, 'invalid');
  }
  const path = resolve(expanded);

  if (!isInsideAnyRoot(path, allowRoots)) {
    throw new BrowseError(`path not allowed: ${path}`, 'forbidden');
  }
  if (!existsSync(path)) {
    throw new BrowseError(`path does not exist: ${path}`, 'not_found');
  }
  if (!statSync(path).isDirectory()) {
    throw new BrowseError(`path is not a directory: ${path}`, 'not_directory');
  }

  const dirents: Dirent[] = readdirSync(path, { withFileTypes: true });
  const entries: BrowseEntry[] = dirents
    .map((d) => ({
      name: d.name,
      path: join(path, d.name),
      isDirectory: d.isDirectory(),
      isHidden: d.name.startsWith('.'),
    }))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

  const atRoot = allowRoots.some((root) => normalize(path) === normalize(root));
  const parent = atRoot ? null : dirname(path);

  return { path, parent, entries };
}

export type BrowseErrorKind = 'invalid' | 'forbidden' | 'not_found' | 'not_directory';

export class BrowseError extends Error {
  constructor(message: string, public readonly kind: BrowseErrorKind) {
    super(message);
  }
}

function isInsideAnyRoot(path: string, roots: string[]): boolean {
  const norm = normalize(path);
  return roots.some((root) => {
    const rNorm = normalize(root);
    return norm === rNorm || norm.startsWith(rNorm + sep);
  });
}

/** Case-fold on Windows for the comparison; preserve case on POSIX. */
function normalize(p: string): string {
  const r = resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2));
  return p;
}

function readEnvAllowRoots(): string[] {
  const raw = process.env.PC_FS_BROWSE_ALLOW ?? '';
  return raw
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}
