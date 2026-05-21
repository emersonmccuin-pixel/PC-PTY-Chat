// Section 17a.5 — Pod spawn preparation.
//
// Resolves an agent name against the pod registry and, when a live global pod
// row exists, materialises it: writes the `.claude/agents/<name>.md` into the
// worktree + a temp `mcp.json` in `scratchDir`, and returns the spawn args /
// env vars / cleanup hook the caller folds into PtySession's `mcpConfigPath`
// + `extraEnv`.
//
// v1 = global-only pod resolution (matches `getPodForSpawn`'s contract).
// 17c will overlay project-scoped rows at the repo layer; this helper does
// not need to change.
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
import type { PodMcpServerConfig } from '@pc/domain';
import { materializePod, type MaterializedPod } from '@pc/runtime';
import { PC_RIG_TOOL_NAMES } from './pod-tool-catalog.ts';

export interface PreparePodSpawnInput {
  /** Agent name — looked up against the live global pod rows. */
  agentName: string;
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
}

/** Resolves the pod for `agentName` and materialises it. Returns `null` when
 *  no live global pod row exists for that name — caller falls back to the
 *  existing flat-file + project-`.mcp.json` path. */
export function preparePodSpawn(input: PreparePodSpawnInput): PodSpawnPrep | null {
  const bundle = getPodForSpawn(input.agentName);
  if (!bundle) return null;

  const baseline = readProjectMcpBaseline(input.worktreeDir);

  const materialised: MaterializedPod = materializePod({
    bundle,
    worktreeDir: input.worktreeDir,
    scratchDir: input.scratchDir,
    baselineMcpServers: baseline,
    mcpToolCatalog: { 'pc-rig': PC_RIG_TOOL_NAMES },
    filterMcpToReferencedTools: input.filterMcpToReferencedTools ?? false,
  });

  return {
    mcpConfigPath: materialised.mcpConfigPath,
    extraEnv: materialised.envVars,
    cleanup: materialised.cleanup,
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
