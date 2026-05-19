// Folder browser for the create-project picker UI. Lists one directory at a
// time so the UI can drill into subfolders. Default landing path is the
// user's home dir.
//
// No allowlist gate (D81, 2026-05-19): PC is single-user local-only, so any
// absolute existing directory is browsable. `~` expands to the user's home
// for ergonomic typed-path entry. `parent` is null only at the filesystem
// root — stops the picker from walking past `C:\` on Windows or `/` on POSIX.

import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

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
  /** Parent path, or null when at the filesystem root. */
  parent: string | null;
  /** Sorted dirs-first, then files; case-insensitive within each group. */
  entries: BrowseEntry[];
}

export interface BrowseOptions {
  /** Override the user's home dir (test seam). */
  homeDir?: string;
}

/** List the directory at `input` (defaults to ~/). */
export function browseFolder(input: string | null | undefined, opts: BrowseOptions = {}): BrowseResult {
  const home = opts.homeDir ?? homedir();

  const raw = (input ?? '').trim();
  const expanded = raw ? expandHome(raw, home) : home;
  if (!isAbsolute(expanded)) {
    throw new BrowseError(`path must be absolute (got: ${JSON.stringify(input)})`, 'invalid');
  }
  const path = resolve(expanded);

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

  const parentPath = dirname(path);
  const parent = parentPath === path ? null : parentPath;

  return { path, parent, entries };
}

export type BrowseErrorKind = 'invalid' | 'not_found' | 'not_directory';

export class BrowseError extends Error {
  constructor(message: string, public readonly kind: BrowseErrorKind) {
    super(message);
  }
}

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2));
  return p;
}
