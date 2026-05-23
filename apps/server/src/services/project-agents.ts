// Per-project agents.
//
// `listResolvedAgents` returns the agents a project's orchestrator (and the
// legacy Settings panel) should see: stock specialists + this project's own
// project-scope pods. Non-stock globals (user-promoted reusables) are
// intentionally hidden — promote-to-global is a copy-source pool for the
// create-agent flow, NOT auto-availability across all projects.
//
// The per-project file functions (`listProjectAgents`, `readProjectAgent`,
// `writeProjectAgent`, `deleteProjectAgent`) are retained for now — they
// still serve the PATCH / DELETE / promote-to-global routes in index.ts.
// Those routes are orphaned (the listing no longer surfaces their output),
// and 17e.4 cleanup deletes them along with the flat-file scaffolding.

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { listAgents } from '@pc/db';
import type { AgentDef, PodAgentRow, ULID } from '@pc/domain';
import { DISPATCHABLE_STOCK_PODS, serializeAgentFile } from '@pc/domain';

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
 *  `kind` reflects where the row came from: a stock global, a project-scope
 *  pod that shadows a stock by name (override), or a project-scope pod
 *  unique to this project. */
export type ResolvedAgentKind = 'global' | 'override' | 'project';

export interface ResolvedAgent extends AgentEntry {
  kind: ResolvedAgentKind;
  /** Reserved for the override flow (would carry the stock body so the UI
   *  can show a diff). Not populated yet. */
  globalBody?: string;
}

export interface ResolvedAgentList {
  /** Stock specialists that aren't overridden by a project-scope pod of the
   *  same name. Excludes `orchestrator` (it doesn't dispatch to itself). */
  globals: ResolvedAgent[];
  /** Project-scope pods whose name matches a stock specialist — they shadow
   *  the stock pod for this project. */
  overrides: ResolvedAgent[];
  /** Project-scope pods unique to this project (name not in stock set). */
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

/** Return the agents this project's orchestrator should see: stock
 *  specialists + this project's own project-scope pods. Non-stock globals
 *  (user-promoted reusables) are hidden — they're a copy-source pool for
 *  the create-agent flow, not auto-availability. A project-scope pod whose
 *  name matches a stock specialist shadows the stock; both ends up in
 *  `overrides` and the shadowed stock entry is omitted from `globals`. */
export function listResolvedAgents(projectId: ULID): ResolvedAgentList {
  const rows = listAgents({ projectId, includeGlobals: true });

  const stockRows: PodAgentRow[] = [];
  const projectRows: PodAgentRow[] = [];
  for (const row of rows) {
    if (row.scope === 'global' && DISPATCHABLE_STOCK_PODS.has(row.name)) {
      stockRows.push(row);
    } else if (row.scope === 'project') {
      projectRows.push(row);
    }
    // Non-stock globals and the orchestrator stock row are intentionally
    // dropped here.
  }

  const overrides: ResolvedAgent[] = [];
  const projectOnly: ResolvedAgent[] = [];
  const overriddenNames = new Set<string>();
  for (const row of projectRows) {
    const entry = podRowToResolvedAgent(row);
    if (DISPATCHABLE_STOCK_PODS.has(row.name)) {
      entry.kind = 'override';
      overrides.push(entry);
      overriddenNames.add(row.name);
    } else {
      entry.kind = 'project';
      projectOnly.push(entry);
    }
  }

  const globals = stockRows
    .filter((row) => !overriddenNames.has(row.name))
    .map(podRowToResolvedAgent);

  return { globals, overrides, projectOnly };
}
