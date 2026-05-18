// Agent library — global pool of agent .md files at ~/.project-companion/agents/.
// Each project copies (and may diverge) library files into <project>/.claude/agents/.
// Files-on-disk are the registry; no DB row (same shape as workflows).
//
// Reads go through `parseAgentFile`; writes go through `serializeAgentFile`
// (round-trip-preserving) plus an atomic temp-file + rename. Callers see the
// raw file text under `body` for backwards compat with the existing UI,
// alongside the parsed `def` for code that wants the typed view.

import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { parseAgentFile, type AgentDef, type AgentParseError } from '@pc/domain';

export interface AgentEntry {
  name: string;
  /** Full file text as on disk (frontmatter + body). Preserved name for
   *  backwards compat with the existing UI / API. */
  body: string;
  /** Parsed typed view. Omitted when the file failed to parse. */
  def?: AgentDef;
  /** Markdown body below the closing `---`. Omitted when the file failed to parse. */
  markdown?: string;
  /** Structured parse error, when applicable. */
  parseError?: AgentParseError;
}

export class AgentLibrary {
  constructor(
    private readonly libraryDir: string,
    private readonly templateDir: string,
  ) {}

  /** Copy seed agents from templates/ into the library dir if it is empty/missing. */
  bootstrap(): void {
    mkdirSync(this.libraryDir, { recursive: true });
    const existing = readdirSync(this.libraryDir).filter((f) => f.endsWith('.md'));
    if (existing.length > 0) return;
    if (!existsSync(this.templateDir)) return;
    for (const f of readdirSync(this.templateDir)) {
      if (!f.endsWith('.md')) continue;
      copyFileSync(join(this.templateDir, f), join(this.libraryDir, f));
    }
  }

  list(): AgentEntry[] {
    if (!existsSync(this.libraryDir)) return [];
    return readdirSync(this.libraryDir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => toEntry(f.replace(/\.md$/, ''), readFileSync(join(this.libraryDir, f), 'utf-8')));
  }

  read(name: string): AgentEntry | null {
    const path = this.pathFor(name);
    if (!path || !existsSync(path)) return null;
    return toEntry(name, readFileSync(path, 'utf-8'));
  }

  /** Write a new library agent. Throws if the name is taken. */
  write(name: string, body: string): AgentEntry {
    const safe = this.safeName(name);
    const path = join(this.libraryDir, safe + '.md');
    if (existsSync(path)) throw new Error(`agent already exists: ${safe}`);
    mkdirSync(this.libraryDir, { recursive: true });
    atomicWriteFileSync(path, body);
    return toEntry(safe, body);
  }

  /** Resolve a library agent name to its absolute path; null if name is unsafe. */
  pathFor(name: string): string | null {
    const safe = this.safeName(name, { allowMissing: true });
    if (!safe) return null;
    return join(this.libraryDir, safe + '.md');
  }

  /** Slug guard: alnum / dash / dot / underscore. Strips a trailing .md if present. */
  private safeName(name: string, opts: { allowMissing?: boolean } = {}): string {
    return safeAgentName(name, opts);
  }
}

/** Module-level form of the safe-name guard so both AgentLibrary and the
 *  per-project agents service share the same rule. */
export function safeAgentName(name: string, opts: { allowMissing?: boolean } = {}): string {
  const trimmed = String(name ?? '').trim().replace(/\.md$/, '');
  if (!trimmed) {
    if (opts.allowMissing) return '';
    throw new Error('agent name required');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(`invalid agent name: ${trimmed}`);
  }
  return trimmed;
}

/** Default library dir: `~/.project-companion/agents/`. Overridable via PC_AGENT_LIBRARY_DIR. */
export function defaultLibraryDir(): string {
  return process.env.PC_AGENT_LIBRARY_DIR
    ? resolve(process.env.PC_AGENT_LIBRARY_DIR)
    : join(homedir(), '.project-companion', 'agents');
}

/** Build an AgentEntry from a name + raw file text. Parses for the typed
 *  view; on parse error, surfaces `parseError` and leaves `def` unset. */
export function toEntry(name: string, body: string): AgentEntry {
  const parsed = parseAgentFile(body);
  if (!parsed.ok) {
    return { name, body, parseError: parsed };
  }
  return { name, body, def: parsed.def, markdown: parsed.body };
}

/** Atomic write — temp-file + rename. Avoids mid-write corruption if the
 *  process crashes between open and close. */
export function atomicWriteFileSync(path: string, contents: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents, 'utf-8');
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}
