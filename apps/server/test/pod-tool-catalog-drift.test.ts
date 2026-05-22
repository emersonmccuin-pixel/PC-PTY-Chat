// 17b follow-up — drift test for the pc-rig static tool catalog.
//
// `pod-tool-catalog.ts:PC_RIG_TOOL_NAMES` is the wildcard-expansion target
// for `mcp__pc-rig__*` in pod tool allowlists. If a tool is added to the
// MCP server's `TOOLS` array but not mirrored here, any pod relying on the
// wildcard (notably the orchestrator) silently loses access to the new
// tool — CC's `tools:` frontmatter is exact-name match only, no wildcard.
//
// Implementation note: parsing the MCP source as TEXT rather than importing
// it. The MCP server's top-level `await server.connect(new
// StdioServerTransport())` blocks any test process that imports the module.
// A regex over the TOOLS array is sufficient — every entry is
// `name: 'pc_*'` and the formatting is stable.
//
// Run via: pnpm --filter @pc/server test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PC_RIG_TOOL_NAMES } from '../src/services/pod-tool-catalog.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = resolve(
  HERE,
  '..',
  '..',
  '..',
  'packages',
  'mcp',
  'src',
  'server.ts',
);

function extractToolsFromMcpSource(): string[] {
  const src = readFileSync(MCP_SERVER_PATH, 'utf8');
  const out: string[] = [];
  // Tool entries open with `name: 'pc_<...>',`. Match the literal so a
  // future field rename (description? other top-level prop?) doesn't drag in
  // unrelated strings.
  const re = /name:\s*'(pc_[a-z0-9_]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  if (out.length === 0) {
    throw new Error(
      `extractToolsFromMcpSource matched 0 names in ${MCP_SERVER_PATH} — regex may be out of sync with the TOOLS array shape`,
    );
  }
  return out;
}

test('PC_RIG_TOOL_NAMES covers every tool in the MCP server TOOLS array', () => {
  const fromServer = extractToolsFromMcpSource().map(
    (n) => `mcp__pc-rig__${n}`,
  );
  const fromCatalog = [...PC_RIG_TOOL_NAMES] as string[];

  const missing = fromServer.filter((name) => !fromCatalog.includes(name));
  assert.deepEqual(
    missing,
    [],
    `pod-tool-catalog.ts is missing tools that exist in packages/mcp/src/server.ts TOOLS: ${missing.join(', ')}. ` +
      'Add them to PC_RIG_TOOL_NAMES so the orchestrator wildcard expansion includes them.',
  );

  const stale = fromCatalog.filter((name) => !fromServer.includes(name));
  assert.deepEqual(
    stale,
    [],
    `pod-tool-catalog.ts lists tools that no longer exist in packages/mcp/src/server.ts TOOLS: ${stale.join(', ')}. ` +
      'Remove them from PC_RIG_TOOL_NAMES.',
  );
});
