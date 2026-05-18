// Per-project agents. Lives at `<folder>/.claude/agents/*.md` — claude.exe
// loads from cwd, so these are the LIVE files. Project-create copies the
// user's library agents into here; edits diverge from the library per
// docs/design/multi-tenancy.md §5.
//
// AgentLibrary owns the global pool at `~/.project-companion/agents/`; this
// module owns the per-project surface only.

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  type AgentEntry,
  AgentLibrary,
  atomicWriteFileSync,
  safeAgentName,
  toEntry,
} from './agent-library.ts';

function agentsDir(folderPath: string): string {
  return resolve(folderPath, '.claude', 'agents');
}

export function listProjectAgents(folderPath: string): AgentEntry[] {
  const dir = agentsDir(folderPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => toEntry(f.replace(/\.md$/, ''), readFileSync(join(dir, f), 'utf-8')));
}

export function readProjectAgent(folderPath: string, name: string): AgentEntry | null {
  const safe = safeAgentName(name);
  const path = join(agentsDir(folderPath), `${safe}.md`);
  if (!existsSync(path)) return null;
  return toEntry(safe, readFileSync(path, 'utf-8'));
}

/** Overwrite a project agent's body. Used by the "edit" path — the project
 *  copy diverges from the library version, which stays untouched. Write is
 *  atomic (temp-file + rename). */
export function writeProjectAgent(folderPath: string, name: string, body: string): AgentEntry {
  const safe = safeAgentName(name);
  const dir = agentsDir(folderPath);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${safe}.md`);
  atomicWriteFileSync(path, body);
  return toEntry(safe, body);
}

/** Copy a library agent into the project. Refuses if the project already has
 *  one by that name — UI offers an explicit "overwrite" affordance later. */
export function copyLibraryAgentToProject(
  library: AgentLibrary,
  folderPath: string,
  name: string,
): AgentEntry {
  const safe = safeAgentName(name);
  const source = library.read(safe);
  if (!source) throw new Error(`library agent not found: ${safe}`);
  const dir = agentsDir(folderPath);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${safe}.md`);
  if (existsSync(dest)) {
    throw new Error(`project already has an agent named ${safe}`);
  }
  atomicWriteFileSync(dest, source.body);
  return toEntry(safe, source.body);
}
