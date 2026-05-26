// Section 20.A.2 — Boot-time .mcp.json rewriter.
//
// Per-project .mcp.json files baked the pc-rig MCP server command as
// `npx -y tsx packages/mcp/src/server.ts`. Cold-spawn under back-to-back
// dispatch load (4 agents in <30s) blew past CC's MCP ack window. 20.A.1
// pre-built the server to `packages/mcp/dist/server.mjs`; this rewriter
// migrates existing project files from npx → node in-place at server boot.
//
// Idempotent: re-runs on every boot, no-ops when pc-rig is already on the
// bundle path or when the file shape is unrecognised.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NodeLauncher } from '@pc/runtime';

const OLD_TSX_SUFFIX = '/packages/mcp/src/server.ts';
const NEW_BUNDLE_SUFFIX = '/packages/mcp/dist/server.mjs';

// Section 10 Phase 1.4 — the Node scripts PC scaffolds into every project's
// `.mcp.json`. An mcpServer entry is PC-node-launched iff one of its args ends
// with one of these (matched by suffix so it's robust to the absolute prefix
// changing between dev and a packaged/relocated install).
const PC_NODE_SCRIPT_SUFFIXES = [
  '/packages/mcp/dist/server.mjs',
  '/channel-server/server.js',
] as const;

export interface RewriteResult {
  projectsScanned: number;
  rewritten: string[];
  skipped: Array<{ folderPath: string; reason: string }>;
}

interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
}

interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Scan each project folder for a stale .mcp.json pc-rig command and rewrite
 *  it to use the pre-built bundle. Caller passes the project folder paths so
 *  this module stays I/O-free w.r.t. the DB and easy to unit-test. */
export function rewriteStaleMcpConfigs(folderPaths: readonly string[]): RewriteResult {
  const result: RewriteResult = { projectsScanned: 0, rewritten: [], skipped: [] };
  for (const folderPath of folderPaths) {
    result.projectsScanned++;
    const mcpPath = resolve(folderPath, '.mcp.json');
    if (!existsSync(mcpPath)) {
      result.skipped.push({ folderPath, reason: 'no .mcp.json' });
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(mcpPath, 'utf-8');
    } catch (err) {
      result.skipped.push({ folderPath, reason: `read failed: ${(err as Error).message}` });
      continue;
    }
    let parsed: McpConfig;
    try {
      parsed = JSON.parse(raw) as McpConfig;
    } catch {
      result.skipped.push({ folderPath, reason: 'malformed JSON' });
      continue;
    }
    const pcRig = parsed.mcpServers?.['pc-rig'];
    if (!pcRig || !Array.isArray(pcRig.args)) {
      result.skipped.push({ folderPath, reason: 'no pc-rig entry' });
      continue;
    }
    const tsxEntry = pcRig.args.find(
      (a) => typeof a === 'string' && a.endsWith(OLD_TSX_SUFFIX),
    );
    if (!tsxEntry) {
      // Already rewritten (or some unrecognised variant) — no-op.
      continue;
    }
    const trunkPath = tsxEntry.slice(0, -OLD_TSX_SUFFIX.length);
    pcRig.command = 'node';
    pcRig.args = [`${trunkPath}${NEW_BUNDLE_SUFFIX}`];
    try {
      writeFileSync(mcpPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
      result.rewritten.push(folderPath);
    } catch (err) {
      result.skipped.push({ folderPath, reason: `write failed: ${(err as Error).message}` });
    }
  }
  return result;
}

/**
 * Section 10 Phase 1.4 — rewrite every PC-node-launched mcpServer entry in a
 * parsed `.mcp.json` object to use `launcher`. Mutates `config` in place;
 * returns whether anything changed (so callers can skip rewriting unchanged
 * files). Idempotent.
 *
 * For each PC node server (matched by script-path suffix — pc-rig + webhook):
 *   - `command` ← `launcher.command`
 *   - `launcher.env` keys merged into `entry.env`
 *   - any env key the launcher does NOT set is reconciled: a stale
 *     `ELECTRON_RUN_AS_NODE` left by a prior packaged run is stripped when the
 *     current launcher is plain `node`, so a project scaffolded by the
 *     installed app still works when later opened under tsx dev.
 *
 * Foreign mcpServers (a user- or pod-added python/other server) are never
 * touched — only entries pointing at PC's own bundled scripts.
 */
export function applyNodeLauncher(config: McpConfig, launcher: NodeLauncher): boolean {
  const servers = config.mcpServers;
  if (!servers) return false;
  let changed = false;
  for (const entry of Object.values(servers)) {
    if (!isPcNodeServer(entry)) continue;
    if (entry.command !== launcher.command) {
      entry.command = launcher.command;
      changed = true;
    }
    const env = (entry.env ??= {});
    for (const [key, value] of Object.entries(launcher.env)) {
      if (env[key] !== value) {
        env[key] = value;
        changed = true;
      }
    }
    // Strip a stale Node-mode flag the launcher no longer sets (packaged →
    // dev transition). Only ELECTRON_RUN_AS_NODE is launcher-owned.
    if (!('ELECTRON_RUN_AS_NODE' in launcher.env) && 'ELECTRON_RUN_AS_NODE' in env) {
      delete env.ELECTRON_RUN_AS_NODE;
      changed = true;
    }
  }
  return changed;
}

function isPcNodeServer(entry: McpServerEntry): boolean {
  return (
    Array.isArray(entry.args) &&
    entry.args.some(
      (a) => typeof a === 'string' && PC_NODE_SCRIPT_SUFFIXES.some((s) => a.endsWith(s)),
    )
  );
}

/**
 * Boot-time pass: apply `launcher` to every project's `.mcp.json`. Under tsx
 * dev (launcher = `node`, no env) this is a near no-op; in a packaged Electron
 * app it rewrites the command to the app binary + ELECTRON_RUN_AS_NODE so MCP
 * children spawn without a system `node`. Mirrors `rewriteStaleMcpConfigs`'s
 * I/O shape (folder paths in, structured result out) and is equally
 * crash-resistant — a bad file is skipped, never thrown.
 */
export function applyNodeLauncherToProjects(
  folderPaths: readonly string[],
  launcher: NodeLauncher,
): RewriteResult {
  const result: RewriteResult = { projectsScanned: 0, rewritten: [], skipped: [] };
  for (const folderPath of folderPaths) {
    result.projectsScanned++;
    const mcpPath = resolve(folderPath, '.mcp.json');
    if (!existsSync(mcpPath)) {
      result.skipped.push({ folderPath, reason: 'no .mcp.json' });
      continue;
    }
    let parsed: McpConfig;
    try {
      parsed = JSON.parse(readFileSync(mcpPath, 'utf-8')) as McpConfig;
    } catch {
      result.skipped.push({ folderPath, reason: 'malformed JSON' });
      continue;
    }
    if (!applyNodeLauncher(parsed, launcher)) continue;
    try {
      writeFileSync(mcpPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
      result.rewritten.push(folderPath);
    } catch (err) {
      result.skipped.push({ folderPath, reason: `write failed: ${(err as Error).message}` });
    }
  }
  return result;
}
