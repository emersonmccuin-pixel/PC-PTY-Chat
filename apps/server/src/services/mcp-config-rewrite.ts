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

const OLD_TSX_SUFFIX = '/packages/mcp/src/server.ts';
const NEW_BUNDLE_SUFFIX = '/packages/mcp/dist/server.mjs';

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
