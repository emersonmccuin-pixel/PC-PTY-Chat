// Per-project agents.
//
// 17e.2 (2026-05-21) — `listResolvedAgents` now reads from the DB pod table
// (global scope only) and no longer scans
// `<folder>/.claude/agents/*.md`. v1 has no project-scope pod creation
// path, so `overrides` + `projectOnly` are always empty arrays; the response
// shape is preserved for web-client backwards compat until 17d ships the
// new Pod UI. The kind taxonomy reduces to a single value (`'global'`) in
// practice.
//
// The per-project file functions (`listProjectAgents`, `readProjectAgent`,
// `writeProjectAgent`, `deleteProjectAgent`) are retained for now — they
// still serve the PATCH / DELETE / promote-to-global routes in index.ts.
// Those routes are orphaned (the listing no longer surfaces their output),
// and 17e.4 cleanup deletes them along with the flat-file scaffolding.

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { listAgents } from '@pc/db';
import type { AgentDef, PodAgentRow } from '@pc/domain';
import { serializeAgentFile } from '@pc/domain';

import {
  type AgentEntry,
  atomicWriteFileSync,
  safeAgentName,
  toEntry,
} from './agent-library.ts';

function agentsDir(folderPath: string): string {
  return resolve(folderPath, '.claude', 'agents');
}

/** Raw scan of `<folder>/.claude/agents/*.md`. Returns every project file.
 *  Used by the PATCH / DELETE / promote-to-global endpoints to operate on
 *  per-project overrides; 17e.4 retires this path along with those routes. */
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

/** Overwrite a project agent's body. Used by the legacy edit path; in 17e
 *  this writes a file that `listResolvedAgents` no longer surfaces. The route
 *  remains wired for now and will be deleted in 17e.4. */
export function writeProjectAgent(folderPath: string, name: string, body: string): AgentEntry {
  const safe = safeAgentName(name);
  const dir = agentsDir(folderPath);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${safe}.md`);
  atomicWriteFileSync(path, body);
  return toEntry(safe, body);
}

/** Delete a project agent file. Legacy path — see `writeProjectAgent`. */
export function deleteProjectAgent(folderPath: string, name: string): void {
  const safe = safeAgentName(name);
  const path = join(agentsDir(folderPath), `${safe}.md`);
  if (!existsSync(path)) {
    throw new Error(`unknown project agent: ${safe}`);
  }
  unlinkSync(path);
}

/** Resolved view of an agent in a project context.
 *
 *  17e.2 collapse: every entry's `kind` is `'global'` in v1 (no
 *  project-scope pod creation path yet — that's 17c). The union is kept
 *  for type compatibility with the existing web client until 17d's Pod UI
 *  replaces it. */
export type ResolvedAgentKind = 'global' | 'override' | 'project';

export interface ResolvedAgent extends AgentEntry {
  kind: ResolvedAgentKind;
  /** Carry-over for the override flow; never populated post-17e.2. */
  globalBody?: string;
}

export interface ResolvedAgentList {
  globals: ResolvedAgent[];
  /** Always `[]` post-17e.2. Retained for API back-compat. */
  overrides: ResolvedAgent[];
  /** Always `[]` post-17e.2. Retained for API back-compat. */
  projectOnly: ResolvedAgent[];
}

/** Build a ResolvedAgent from a DB pod row. Synthesizes the `.md`-shaped
 *  `body` via the serializer so the existing UI's raw-view tab keeps
 *  rendering something sensible. */
function podRowToResolvedAgent(row: PodAgentRow): ResolvedAgent {
  const def: AgentDef = {
    name: row.name,
    description: row.description,
  };
  if (row.model !== null) def.model = row.model;
  if (row.effort !== null) def.effort = row.effort;
  if (row.maxTurns !== null) def.maxTurns = row.maxTurns;
  if (row.tools.length > 0) def.tools = row.tools;
  if (row.outputDestination !== null) def.pc = { outputDestination: row.outputDestination };

  const body = serializeAgentFile({ def, body: row.prompt });
  return {
    name: row.name,
    body,
    def,
    markdown: row.prompt,
    kind: 'global',
  };
}

/** Return the full agent picture for a project. In v1 this is "every live
 *  global pod" — pods are global-scope only, so no overrides or project-only
 *  entries are produced. The `_folderPath` parameter is unused but kept to
 *  preserve the route signature until 17d. */
export function listResolvedAgents(_folderPath: string): ResolvedAgentList {
  const rows = listAgents({ scope: 'global' });
  return {
    globals: rows.map(podRowToResolvedAgent),
    overrides: [],
    projectOnly: [],
  };
}
