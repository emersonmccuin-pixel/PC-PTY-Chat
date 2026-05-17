// Agent library — global pool of agent .md files at ~/.project-companion/agents/.
// Each project copies (and may diverge) library files into <project>/.claude/agents/.
// Files-on-disk are the registry; no DB row (same shape as workflows).

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface AgentEntry {
  name: string;
  body: string;
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
      .map((f) => ({
        name: f.replace(/\.md$/, ''),
        body: readFileSync(join(this.libraryDir, f), 'utf-8'),
      }));
  }

  read(name: string): AgentEntry | null {
    const path = this.pathFor(name);
    if (!path || !existsSync(path)) return null;
    return { name, body: readFileSync(path, 'utf-8') };
  }

  /** Write a new library agent. Throws if the name is taken. */
  write(name: string, body: string): AgentEntry {
    const safe = this.safeName(name);
    const path = join(this.libraryDir, safe + '.md');
    if (existsSync(path)) throw new Error(`agent already exists: ${safe}`);
    mkdirSync(this.libraryDir, { recursive: true });
    writeFileSync(path, body, 'utf-8');
    return { name: safe, body };
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
