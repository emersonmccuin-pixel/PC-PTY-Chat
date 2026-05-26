// Section 17a.5 — Pod spawn preparation.
//
// Resolves an agent name against the pod registry and, when a live global pod
// row exists, materialises it: writes the `.claude/agents/<name>.md` into the
// worktree + a temp `mcp.json` in `scratchDir`, and returns the spawn args /
// env vars / cleanup hook the caller folds into PtySession's `mcpConfigPath`
// + `extraEnv`.
//
// Pod resolution is project-first-then-global as of Section 22.1
// (codebase-review stabilization, 2026-05-25). Callers that have a projectId
// MUST pass it so a project-scoped pod with the same name wins; callers that
// don't (genuinely global-only contexts) can omit it for the legacy lookup.
//
// 17a.5 wires this into the workflow runtime's subagent dispatch path. The
// orchestrator path stays on the existing `--append-system-prompt-file` flow
// until Section 16a flips it (orchestrator becomes a pod row at that point).
//
// When no pod row exists, the helper returns a null bundle — caller falls
// back to current behaviour (project `.mcp.json` + flat-file agent .md from
// `templates/.project-companion/agents/`). This keeps Section 3's flat-file
// globals working until 17e nukes them.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getPodForSpawn } from '@pc/db';
import type { PodMcpServerConfig, ULID } from '@pc/domain';
import { materializePod, type MaterializedPod, type PodWorkItemContext } from '@pc/runtime';
import { PC_RIG_TOOL_NAMES } from './pod-tool-catalog.ts';
import { renderAvailableAgents } from './pod-variable-renderers.ts';

export interface PreparePodSpawnInput {
  /** Agent name — looked up against the pod rows. */
  agentName: string;
  /** Project context for the dispatch. When set, a project-scoped pod with
   *  this name wins over the same-name global pod. Omit only when the
   *  dispatch is genuinely project-agnostic (no such call site exists in
   *  production today — all spawns happen within a project). */
  projectId?: ULID | null;
  /** Worktree root — `.claude/agents/<name>.md` lands under here. */
  worktreeDir: string;
  /** Per-spawn scratch dir — temp `mcp.json` lands here. Caller owns the dir
   *  lifecycle; cleanup() removes the file but NOT the dir. */
  scratchDir: string;
  /** When true, the rendered `mcp.json` is filtered to only include MCP
   *  servers referenced by the pod's tool list. Agent dispatches pass true
   *  to prevent the project-baseline `webhook` server (which never loads
   *  for agent spawns since they don't pass `--dangerously-load-development
   *  -channels`) from poisoning CC's strict-mcp-config and dropping all
   *  pc-rig tools. Orchestrator spawns leave this false: the orchestrator
   *  needs webhook in mcp.json so CC spawns its dev-channel stdio child.
   *  Defaults to false. */
  filterMcpToReferencedTools?: boolean;
  /** Section 26.4 — when the dispatch carries a work-item assignment, the
   *  materialised agent .md gains a "## Your assignment" section telling the
   *  agent to fetch the work item as its first action + surfacing the
   *  expected_output JSON. Null / undefined → no section emitted, matching
   *  today's behaviour. */
  workItem?: PodWorkItemContext;
}

export interface PodSpawnPrep {
  /** Absolute path to the materialised pod `mcp.json`. Caller passes this as
   *  PtySession's `mcpConfigPath` and SubagentSpawnRequest's `mcpConfigPath`. */
  mcpConfigPath: string;
  /** Env-var map from the pod's secrets. Caller merges into the spawn's
   *  `extraEnv`. Empty when the pod has no secrets. */
  extraEnv: Record<string, string>;
  /** Tear-down hook — removes the materialised .md + mcp.json. Caller invokes
   *  on spawn-handle resolution (success or failure). Tolerant of repeat calls. */
  cleanup(): void;
  /** Which scope `getPodForSpawn` actually resolved. Lets the caller pin
   *  downstream queries (e.g. `computePodRevision`) to the row we used —
   *  same-name project-scope pod can shadow a global. */
  podScope: 'global' | 'project';
  /** The project the resolved pod belongs to (when `podScope === 'project'`).
   *  Null for globals. */
  podProjectId: ULID | null;
}

/** Resolves the pod for `agentName` and materialises it. Returns `null` when
 *  no live global pod row exists for that name — caller falls back to the
 *  existing flat-file + project-`.mcp.json` path. */
export function preparePodSpawn(input: PreparePodSpawnInput): PodSpawnPrep | null {
  const bundle = getPodForSpawn(input.agentName, input.projectId);
  if (!bundle) return null;

  const baseline = readProjectMcpBaseline(input.worktreeDir);

  // Section 36 — pod-prompt variable substitution. Compute the DB-backed
  // roster lazily only when referenced. AVAILABLE_TOOLS is materializer-owned
  // because it must render from the final expanded tool allowlist.
  const promptBody = bundle.agent.prompt;
  const variables: Record<string, string> = {};
  if (promptBody.includes('{{AVAILABLE_AGENTS}}')) {
    variables.AVAILABLE_AGENTS = renderAvailableAgents(input.projectId ?? null);
  }

  const materialised: MaterializedPod = materializePod({
    bundle,
    worktreeDir: input.worktreeDir,
    scratchDir: input.scratchDir,
    baselineMcpServers: baseline,
    mcpToolCatalog: { 'pc-rig': PC_RIG_TOOL_NAMES },
    filterMcpToReferencedTools: input.filterMcpToReferencedTools ?? false,
    workItem: input.workItem,
    ...(Object.keys(variables).length > 0 ? { variables } : {}),
  });

  return {
    mcpConfigPath: materialised.mcpConfigPath,
    extraEnv: materialised.envVars,
    cleanup: materialised.cleanup,
    podScope: bundle.agent.scope,
    podProjectId: bundle.agent.projectId ?? null,
  };
}

/** Read the project's existing `<worktreeDir>/.mcp.json` and return its
 *  `mcpServers` map. The pod's MCP rows merge on top — pc-rig + webhook (the
 *  defaults PC scaffolds) survive unless the pod explicitly overrides them.
 *
 *  When the file is missing or malformed, returns an empty baseline. Subagents
 *  with no pod-declared MCP rows still get an empty pod mcp.json — the spawn
 *  will fail to find pc-rig, which is the right loud signal that PC's project
 *  scaffold didn't land. */
function readProjectMcpBaseline(worktreeDir: string): Record<string, PodMcpServerConfig> {
  const path = resolve(worktreeDir, '.mcp.json');
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, PodMcpServerConfig> };
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}
