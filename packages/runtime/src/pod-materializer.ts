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
  ExpectedOutput,
  PodAgentRow,
  PodKnowledgeRow,
  PodMcpServerConfig,
  PodMcpServerRow,
  PodSecretRow,
  PodSpawnBundle,
} from '@pc/domain';
import { mergeRequiredAgentTools } from '@pc/domain';

/** Work-item context the orchestrator forwards via `pc_invoke_agent.workItemId`.
 *  When supplied, the materialiser appends a "## Your assignment" section to
 *  the rendered agent .md so the agent's first instruction is to fetch the
 *  work item. The user-message input stays clean — no magic tokens in the
 *  conversation (Section 26.4 lock: workItemId travels via the harness). */
export interface PodWorkItemContext {
  workItemId: string;
  expectedOutput: ExpectedOutput;
}

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
  /** When true, the rendered `mcp.json` is filtered to only include MCP
   *  servers actually referenced by the pod's tool list (i.e. names appearing
   *  in `mcp__<server>__<tool>` entries). Agent-dispatch callers set this
   *  true so unreferenced baseline servers like `webhook` (which silently
   *  refuse to load without `--dangerously-load-development-channels` and
   *  cause CC's `--strict-mcp-config` to drop ALL MCP tools) don't poison
   *  the agent's tool surface. Orchestrator-spawn callers leave this false:
   *  the orchestrator depends on `webhook` being in mcp.json so CC spawns
   *  its dev-channel-registered stdio child. Defaults to false. */
  filterMcpToReferencedTools?: boolean;
  /** Optional work-item assignment. When supplied, the rendered agent .md
   *  carries a "## Your assignment" section telling the agent to fetch
   *  `workItemId` via `pc_get_work_item` as its first action, plus the
   *  `expected_output` JSON below. Section 26.4 contract. */
  workItem?: PodWorkItemContext;
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

  // Section 26 load-bearing safety net — guarantee the work-item contract
  // tools are present in the spawned agent's frontmatter no matter what.
  // The repo layer already merges these at create/update time, but a
  // hand-edited row, a row from before this guard shipped, or a future code
  // path that bypasses `createAgent` would otherwise yield an agent that
  // can't fetch / update its assignment. Idempotent — duplicates from the
  // wildcard expansion below are deduped by `mergeRequiredAgentTools`.
  const expandedTools = mergeRequiredAgentTools(
    expandToolWildcards(bundle.agent.tools, catalog),
  );

  const agentMdPath = resolve(worktreeDir, '.claude', 'agents', `${bundle.agent.name}.md`);
  mkdirSync(dirname(agentMdPath), { recursive: true });
  writeFileSync(
    agentMdPath,
    renderAgentMd(bundle.agent, expandedTools, bundle.knowledge, opts.workItem),
    'utf8',
  );

  const mcpConfigPath = resolve(scratchDir, 'mcp.json');
  mkdirSync(scratchDir, { recursive: true });
  const referencedServers = opts.filterMcpToReferencedTools
    ? collectReferencedMcpServers(expandedTools)
    : undefined;
  writeFileSync(
    mcpConfigPath,
    renderMcpConfig(bundle.mcpServers, baselineMcp, referencedServers),
    'utf8',
  );

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

/** The MCP tool agents call to fetch a knowledge doc's full content. The
 *  materializer only emits the knowledge footer when this tool is present
 *  in the agent's expanded tool list — otherwise the footer would tell the
 *  agent to call a tool it doesn't have access to. */
const KNOWLEDGE_READ_TOOL = 'mcp__pc-rig__pc_knowledge_read';

/** Render the `.claude/agents/<name>.md` body. Frontmatter mirrors PC's
 *  flat-file agent shape: name, description, tools (comma-separated), model,
 *  effort, maxTurns. Empty/null fields are omitted.
 *
 *  When `knowledge` rows exist AND the agent has `pc_knowledge_read` in its
 *  expanded tool list, appends a "Knowledge available" footer listing each
 *  doc + its id + a short summary. Worker agents pull full content at
 *  runtime via `pc_knowledge_read`. Pods with zero knowledge docs OR pods
 *  without the read tool get no footer (the latter prevents silently telling
 *  an agent to call a tool it can't reach). */
export function renderAgentMd(
  agent: PodAgentRow,
  tools: readonly string[],
  knowledge: readonly PodKnowledgeRow[] = [],
  workItem?: PodWorkItemContext,
): string {
  const fm: string[] = ['---', `name: ${agent.name}`];
  if (agent.description.trim() !== '') fm.push(`description: ${agent.description}`);
  if (tools.length > 0) fm.push(`tools: ${tools.join(', ')}`);
  if (agent.model) fm.push(`model: ${agent.model}`);
  if (agent.effort) fm.push(`effort: ${agent.effort}`);
  if (agent.maxTurns !== null) fm.push(`maxTurns: ${agent.maxTurns}`);
  fm.push('---');
  const body = agent.prompt.trim();
  const assignment = workItem ? renderAssignment(workItem) : '';
  const canReadKnowledge = tools.includes(KNOWLEDGE_READ_TOOL);
  const footer = canReadKnowledge ? renderKnowledgeFooter(agent.id, knowledge) : '';
  return `${fm.join('\n')}\n\n${body}${assignment}${footer}\n`;
}

/** "## Your assignment" section appended to the agent body when the dispatch
 *  carries a work-item id. Tells the agent its first tool call must fetch the
 *  work item, plus surfaces the expected_output JSON so the model can plan
 *  the shape of its output. Workflow / contract details (acceptance_criteria,
 *  attachments) live on the work item itself — the agent reads them via
 *  `pc_get_work_item`. Section 26.4. */
export function renderAssignment(workItem: PodWorkItemContext): string {
  const expected = JSON.stringify(workItem.expectedOutput, null, 2);
  return [
    '',
    '',
    '## Your assignment',
    '',
    `You are assigned to work item \`${workItem.workItemId}\`. Your FIRST tool call must be:`,
    '',
    '```',
    `pc_get_work_item({ id: "${workItem.workItemId}" })`,
    '```',
    '',
    "Read its `body` (your task), `acceptance_criteria` (what \"done\" means), `attachments`, and `parent`. The orchestrator already wrote the task into the body — the dispatch input is intentionally trivial.",
    '',
    '### Expected output',
    '',
    'Shape the orchestrator wants:',
    '',
    '```json',
    expected,
    '```',
    '',
    'When you complete the work, persist the deliverable on the work item (body / fields / attachments) so the acceptance-criteria evaluator can verify it.',
  ].join('\n');
}

/** Knowledge access footer appended to the rendered .md when the pod has
 *  knowledge docs. Lists ids + names + a short summary so the agent can
 *  decide which docs to read; full content is pulled at runtime via
 *  `pc_knowledge_read`. */
export function renderKnowledgeFooter(
  agentId: string,
  knowledge: readonly PodKnowledgeRow[],
): string {
  if (knowledge.length === 0) return '';
  const lines: string[] = [
    '',
    '',
    '## Knowledge available',
    '',
    `You have ${knowledge.length} reference document${knowledge.length === 1 ? '' : 's'} attached to your pod. Read any of them at runtime with:`,
    '',
    '```',
    `pc_knowledge_read({ agentId: "${agentId}", knowledgeId: "<one of the ids below>" })`,
    '```',
    '',
    'Available docs:',
    '',
  ];
  for (const doc of knowledge) {
    const summary = summariseKnowledge(doc.content);
    lines.push(`- **${doc.name}** (\`${doc.id}\`) — ${summary}`);
  }
  return lines.join('\n');
}

function summariseKnowledge(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '(empty)';
  // First non-empty / non-heading line; cap at 120 chars.
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    return line.length > 120 ? `${line.slice(0, 117)}...` : line;
  }
  // All lines are headings; take the first
  const firstHeading = trimmed.split(/\r?\n/)[0]?.replace(/^#+\s*/, '').trim();
  return firstHeading || '(content)';
}

/** Render the temp `mcp.json` content. Pod's MCP rows merge on top of the
 *  caller-supplied baseline (pod wins per-server-name on conflict). When
 *  `referencedServers` is supplied, the final mcpServers map is filtered
 *  to only that set — used to avoid CC's strict-mcp-config fail-closed when
 *  unreferenced servers in the baseline (e.g. webhook) can't load. */
export function renderMcpConfig(
  podMcpServers: readonly PodMcpServerRow[],
  baseline: Record<string, PodMcpServerConfig>,
  referencedServers?: ReadonlySet<string>,
): string {
  const merged: Record<string, PodMcpServerConfig> = { ...baseline };
  for (const row of podMcpServers) {
    merged[row.name] = row.config;
  }
  const mcpServers: Record<string, PodMcpServerConfig> = referencedServers
    ? Object.fromEntries(
        Object.entries(merged).filter(([name]) => referencedServers.has(name)),
      )
    : merged;
  return JSON.stringify({ mcpServers }, null, 2);
}

/** Scan an agent's expanded tool list for `mcp__<server>__<tool>` patterns
 *  and return the unique set of server names referenced. Used by the
 *  materialiser to filter the agent's mcp.json down to only the MCP
 *  servers actually needed. */
export function collectReferencedMcpServers(tools: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const t of tools) {
    if (!t.startsWith('mcp__')) continue;
    const rest = t.slice('mcp__'.length);
    const sep = rest.indexOf('__');
    if (sep < 1) continue;
    out.add(rest.slice(0, sep));
  }
  return out;
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
