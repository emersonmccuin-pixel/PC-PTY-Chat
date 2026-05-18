// Per-project agents. Lives at `<folder>/.claude/agents/*.md` — claude.exe
// loads from cwd, so these are the LIVE files.
//
// Per Section 3 D2: globals (the 5 PC-shipped agents in AgentLibrary) are
// always surfaced in every project's agent list as "Global" entries — they
// are NOT physically pre-copied at project create. Editing a global from
// inside a project creates a per-project override file in `.claude/agents/`
// that shadows the global by name. Deleting that override is the
// "reset to global" affordance.

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
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

/** Raw scan of `<folder>/.claude/agents/*.md`. Returns every project file —
 *  the resolver in `listResolvedAgents` decides which of these are overrides
 *  of a global vs. project-only. */
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

/** Overwrite a project agent's body. Used by the "edit" path. If the name
 *  matches a global, this creates / updates the per-project override; the
 *  global stays untouched. Write is atomic (temp-file + rename). */
export function writeProjectAgent(folderPath: string, name: string, body: string): AgentEntry {
  const safe = safeAgentName(name);
  const dir = agentsDir(folderPath);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${safe}.md`);
  atomicWriteFileSync(path, body);
  return toEntry(safe, body);
}

/** Delete a project agent file. When the deleted file shadowed a global,
 *  this is the "reset to global" path — subsequent reads see the global
 *  again. When the file was project-only, this fully removes the agent.
 *  Caller is responsible for distinguishing the two via `listResolvedAgents`
 *  before calling. */
export function deleteProjectAgent(folderPath: string, name: string): void {
  const safe = safeAgentName(name);
  const path = join(agentsDir(folderPath), `${safe}.md`);
  if (!existsSync(path)) {
    throw new Error(`unknown project agent: ${safe}`);
  }
  unlinkSync(path);
}

/** Resolved view of an agent in a project context. `kind` says what surface
 *  this entry represents:
 *
 *  - `global` — served from the library; no per-project file.
 *  - `override` — per-project file with the same name as a global. The
 *    library version stays untouched; `globalBody` carries it for diff /
 *    reset.
 *  - `project` — per-project file with no matching global. Fully decoupled
 *    from the library. */
export type ResolvedAgentKind = 'global' | 'override' | 'project';

export interface ResolvedAgent extends AgentEntry {
  kind: ResolvedAgentKind;
  /** Library agent body when `kind === 'override'`. Lets the UI surface a
   *  "diverged from global" diff + a Reset action. */
  globalBody?: string;
}

export interface ResolvedAgentList {
  globals: ResolvedAgent[];
  overrides: ResolvedAgent[];
  projectOnly: ResolvedAgent[];
}

/** Return the full agent picture for a project: globals (library entries
 *  with no per-project shadow), overrides (per-project files shadowing a
 *  global), and project-only (per-project files with no matching global).
 *
 *  Resolution rule: a per-project file by name `X` shadows a library entry
 *  by name `X`. There is no project-side merge — the override is a full
 *  replacement file, fully decoupled from the global. */
export function listResolvedAgents(
  library: AgentLibrary,
  folderPath: string,
): ResolvedAgentList {
  const libraryEntries = library.list();
  const projectEntries = listProjectAgents(folderPath);

  const libraryByName = new Map(libraryEntries.map((e) => [e.name, e]));
  const projectByName = new Map(projectEntries.map((e) => [e.name, e]));

  const globals: ResolvedAgent[] = [];
  const overrides: ResolvedAgent[] = [];
  const projectOnly: ResolvedAgent[] = [];

  for (const entry of libraryEntries) {
    const shadow = projectByName.get(entry.name);
    if (shadow) {
      overrides.push({ ...shadow, kind: 'override', globalBody: entry.body });
    } else {
      globals.push({ ...entry, kind: 'global' });
    }
  }

  for (const entry of projectEntries) {
    if (libraryByName.has(entry.name)) continue;
    projectOnly.push({ ...entry, kind: 'project' });
  }

  return { globals, overrides, projectOnly };
}
