// 5+.2 — read-only file tree + per-file preview for the LeftRail Files tab.
// D90 / D91 / D92: recursive walk of the project root; hard-skip the noisy
// dirs; layer .gitignore on top via the `ignore` package; 1 MB preview cap;
// no editing. The renderer decides what to do with each kind.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import ignore, { type Ignore } from 'ignore';

const HARD_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'data',
  'dist',
  'build',
  '.next',
  '.cache',
  'coverage',
  'playwright-report',
  'test-results',
  '.vite',
  '.turbo',
]);

/** 1 MB hard cap. Files larger than this return `kind: 'oversized'`. */
export const PREVIEW_BYTE_CAP = 1_000_000;

/** Image extensions that get streamed back as a base64 data URI. */
const IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.ico',
]);

const MARKDOWN_EXTS = new Set(['.md', '.markdown']);
const HTML_EXTS = new Set(['.html', '.htm']);

export interface FileTreeNode {
  name: string;
  /** Posix-style path relative to the project root. Empty string for root. */
  path: string;
  kind: 'file' | 'dir';
  children?: FileTreeNode[];
  /** File size in bytes. Only present on files. */
  size?: number;
}

export type FilePreview =
  | { kind: 'markdown'; content: string; byteSize: number }
  | { kind: 'html'; content: string; byteSize: number }
  | { kind: 'image'; dataUri: string; byteSize: number }
  | { kind: 'text'; content: string; byteSize: number }
  | { kind: 'binary'; byteSize: number }
  | { kind: 'oversized'; byteSize: number };

export class FilePathOutsideProjectError extends Error {
  constructor(public relPath: string) {
    super(`path escapes project root: ${relPath}`);
    this.name = 'FilePathOutsideProjectError';
  }
}

export class FileNotFoundError extends Error {
  constructor(public relPath: string) {
    super(`file not found: ${relPath}`);
    this.name = 'FileNotFoundError';
  }
}

/** Walks `folderPath` and returns the full tree. Applies HARD_SKIP_DIRS and
 *  the project's nearest .gitignore. Hidden files (leading dot) are kept by
 *  default — useful for READMEs, .env.example, etc. */
export async function getFilesTree(folderPath: string): Promise<FileTreeNode[]> {
  const ig = await loadGitignore(folderPath);
  return walkDir(folderPath, '', ig);
}

async function walkDir(
  rootAbs: string,
  relParent: string,
  ig: Ignore,
): Promise<FileTreeNode[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(join(rootAbs, relParent), { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: FileTreeNode[] = [];
  for (const ent of entries) {
    const name = ent.name;
    if (ent.isDirectory() && HARD_SKIP_DIRS.has(name)) continue;
    const relPath = relParent ? `${relParent}/${name}` : name;
    // `ignore` expects posix-style paths; we already build them that way.
    // Dirs MUST be tested with a trailing slash to match .gitignore semantics.
    const testPath = ent.isDirectory() ? `${relPath}/` : relPath;
    if (ig.ignores(testPath)) continue;

    if (ent.isDirectory()) {
      const children = await walkDir(rootAbs, relPath, ig);
      nodes.push({ name, path: relPath, kind: 'dir', children });
    } else if (ent.isFile()) {
      let size = 0;
      try {
        const s = await stat(join(rootAbs, relPath));
        size = s.size;
      } catch {
        // Race vs deletion / symlink loops — just report size:0 and move on.
      }
      nodes.push({ name, path: relPath, kind: 'file', size });
    }
    // Symlinks, sockets, etc. are intentionally skipped.
  }
  // Dirs first, then files, alpha within each group. Matches the user's
  // mental model of "look at folders, then drill in."
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

async function loadGitignore(folderPath: string): Promise<Ignore> {
  const ig = ignore();
  // Always ignore .git in addition to hard-skip — defensive, in case .git
  // got removed from the hard-skip set.
  ig.add('.git/');
  try {
    const raw = await readFile(join(folderPath, '.gitignore'), 'utf8');
    ig.add(raw);
  } catch {
    // No .gitignore at root — that's fine, we keep walking with just the
    // hard-skip list applied.
  }
  return ig;
}

/** Reads `relPath` (relative to the project root) and classifies it for the
 *  viewer. Path is normalized + bounds-checked so a malicious `..` segment
 *  can't escape the project root. */
export async function previewFile(
  folderPath: string,
  relPath: string,
): Promise<FilePreview> {
  const folderAbs = resolve(folderPath);
  const absPath = resolve(folderAbs, relPath);
  // Reject anything that resolves outside the project root. `+ sep` so the
  // root dir itself can't be previewed and look-alikes (folderAbs="foo",
  // absPath="foobar/...") can't slip through.
  if (absPath !== folderAbs && !absPath.startsWith(folderAbs + sep)) {
    throw new FilePathOutsideProjectError(relPath);
  }

  let size: number;
  try {
    const s = await stat(absPath);
    if (!s.isFile()) throw new FileNotFoundError(relPath);
    size = s.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FileNotFoundError(relPath);
    }
    throw err;
  }

  if (size > PREVIEW_BYTE_CAP) {
    return { kind: 'oversized', byteSize: size };
  }

  const ext = extOf(relPath);

  if (IMAGE_EXTS.has(ext)) {
    const buf = await readFile(absPath);
    const mime = mimeForImageExt(ext);
    const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
    return { kind: 'image', dataUri, byteSize: size };
  }

  // Read as a buffer first so we can sniff for binary content. Anything with
  // an embedded NUL in the first 8 KB is treated as binary.
  const buf = await readFile(absPath);
  if (looksBinary(buf)) {
    return { kind: 'binary', byteSize: size };
  }

  const content = buf.toString('utf8');
  if (MARKDOWN_EXTS.has(ext)) {
    return { kind: 'markdown', content, byteSize: size };
  }
  if (HTML_EXTS.has(ext)) {
    return { kind: 'html', content, byteSize: size };
  }
  return { kind: 'text', content, byteSize: size };
}

function extOf(path: string): string {
  const i = path.lastIndexOf('.');
  if (i < 0) return '';
  return path.slice(i).toLowerCase();
}

function mimeForImageExt(ext: string): string {
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.bmp':
      return 'image/bmp';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}

function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

