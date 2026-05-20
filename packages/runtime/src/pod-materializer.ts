// Section 17a.3 — Pod materialisation writer.
//
// Reads a `PodSpawnBundle` (from getPodForSpawn) and writes the on-disk
// shape claude.exe consumes:
//   - `<worktree>/.claude/agents/<name>.md` (frontmatter + prompt body)
//   - a temp `mcp.json` (pod-declared MCP servers, merged on top of a caller-
//     supplied baseline like PC's pc-rig server)
// Returns the env-var map built from the pod's secrets — caller folds it into
// the spawn env.
//
// Wildcard tool expansion is PC-side: claude.exe's `tools:` frontmatter is
// exact-name match only, so `mcp__<server>__*` is expanded to the explicit
// per-tool list from the supplied `mcpToolCatalog`. Pattern targeting an
// unknown server throws — pod creators must either declare the explicit names
// or supply a matching catalog entry.
//
// Scope: pure data → files + envs. Spawn lifecycle (kill / restart / `--resume`
// on pod edit) is the 16b deliverable; wiring `materializePod` into PC's
// orchestrator + subagent spawn paths is 17a.5.
//
// Reference shape: `pod-validation/harness/materialize.ts` +
// `harness/pc-rig-tools.ts`. The harness validated this exact contract against
// real claude.exe (8 contract scenarios + 1 full-fidelity orchestrator run).

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  PodAgentRow,
  PodMcpServerConfig,
  PodMcpServerRow,
  PodSecretRow,
  PodSpawnBundle,
} from '@pc/domain';

export interface MaterializePodOptions {
  bundle: PodSpawnBundle;
  /** Worktree root. `.claude/agents/<name>.md` lands under here. */
  worktreeDir: string;
  /** Directory the temp `mcp.json` is written to. Caller mints + creates. */
  scratchDir: string;
  /** Baseline MCP servers always included alongside the pod's own declarations.
   *  Typical use: PC's `pc-rig` server. Pod-declared rows win per-name on
   *  conflict — the pod's local override beats the baseline. */
  baselineMcpServers?: Record<string, PodMcpServerConfig>;
  /** Resolution table for `mcp__<server>__*` tool wildcards. Each key is an
   *  MCP server name; each value is the explicit tool list to expand into. */
  mcpToolCatalog?: Record<string, readonly string[]>;
}

export interface MaterializedPod {
  agentMdPath: string;
  mcpConfigPath: string;
  envVars: Record<string, string>;
  /** Best-effort: removes the agent .md and the temp mcp.json. Caller owns
   *  `.claude/` and `scratchDir` themselves. Tolerates ENOENT. */
  cleanup(): void;
}

export function materializePod(opts: MaterializePodOptions): MaterializedPod {
  const { bundle, worktreeDir, scratchDir } = opts;
  const baselineMcp = opts.baselineMcpServers ?? {};
  const catalog = opts.mcpToolCatalog ?? {};

  const expandedTools = expandToolWildcards(bundle.agent.tools, catalog);

  const agentMdPath = resolve(worktreeDir, '.claude', 'agents', `${bundle.agent.name}.md`);
  mkdirSync(dirname(agentMdPath), { recursive: true });
  writeFileSync(agentMdPath, renderAgentMd(bundle.agent, expandedTools), 'utf8');

  const mcpConfigPath = resolve(scratchDir, 'mcp.json');
  mkdirSync(scratchDir, { recursive: true });
  writeFileSync(mcpConfigPath, renderMcpConfig(bundle.mcpServers, baselineMcp), 'utf8');

  return {
    agentMdPath,
    mcpConfigPath,
    envVars: buildEnvMap(bundle.secrets),
    cleanup() {
      tryUnlink(agentMdPath);
      tryUnlink(mcpConfigPath);
    },
  };
}

/** Render the `.claude/agents/<name>.md` body. Frontmatter mirrors PC's
 *  flat-file agent shape: name, description, tools (comma-separated), model,
 *  effort, maxTurns. Empty/null fields are omitted. */
export function renderAgentMd(agent: PodAgentRow, tools: readonly string[]): string {
  const fm: string[] = ['---', `name: ${agent.name}`];
  if (agent.description.trim() !== '') fm.push(`description: ${agent.description}`);
  if (tools.length > 0) fm.push(`tools: ${tools.join(', ')}`);
  if (agent.model) fm.push(`model: ${agent.model}`);
  if (agent.effort) fm.push(`effort: ${agent.effort}`);
  if (agent.maxTurns !== null) fm.push(`maxTurns: ${agent.maxTurns}`);
  fm.push('---');
  const body = agent.prompt.trim();
  return `${fm.join('\n')}\n\n${body}\n`;
}

/** Render the temp `mcp.json` content. Pod's MCP rows merge on top of the
 *  caller-supplied baseline (pod wins per-server-name on conflict). */
export function renderMcpConfig(
  podMcpServers: readonly PodMcpServerRow[],
  baseline: Record<string, PodMcpServerConfig>,
): string {
  const mcpServers: Record<string, PodMcpServerConfig> = { ...baseline };
  for (const row of podMcpServers) {
    mcpServers[row.name] = row.config;
  }
  return JSON.stringify({ mcpServers }, null, 2);
}

/** Build the env-var map the spawn caller folds into the child env. v1 = plain
 *  passthrough of `valuePlaintext`; v2 will decrypt here (DPAPI). */
export function buildEnvMap(secrets: readonly PodSecretRow[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const s of secrets) env[s.envVarName] = s.valuePlaintext;
  return env;
}

/** Expand `mcp__<server>__*` patterns against the supplied catalog. Non-pattern
 *  entries pass through unchanged. Order is preserved; duplicates are deduped.
 *  Pattern targeting an unknown server throws — loud failure beats a silent
 *  `tools:` allowlist that claude.exe quietly rejects at spawn. */
export function expandToolWildcards(
  tools: readonly string[],
  catalog: Record<string, readonly string[]>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push(name);
  };
  for (const entry of tools) {
    if (entry.startsWith('mcp__') && entry.endsWith('__*')) {
      const server = entry.slice('mcp__'.length, entry.length - '__*'.length);
      const list = catalog[server];
      if (!list) {
        throw new Error(
          `expandToolWildcards: unknown MCP server "${server}" for pattern "${entry}" — ` +
            `caller must supply mcpToolCatalog[${JSON.stringify(server)}]`,
        );
      }
      for (const tool of list) push(tool);
      continue;
    }
    push(entry);
  }
  return out;
}

function tryUnlink(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort */
  }
}
