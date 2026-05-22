// 17b follow-up — drift test for the pc-rig static tool catalog.
//
// `pod-tool-catalog.ts:PC_RIG_TOOL_NAMES` is the wildcard-expansion target
// for `mcp__pc-rig__*` in pod tool allowlists. If a tool is added to the
// MCP server's `TOOLS` array but not mirrored here, any pod relying on the
// wildcard (notably the orchestrator) silently loses access to the new
// tool — CC's `tools:` frontmatter is exact-name match only, no wildcard.
//
// This test fails loudly when drift exists, so new pc-rig tools can't ship
// without updating both files.
//
// Run via: pnpm --filter @pc/server test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS } from '../../../packages/mcp/src/server.ts';
import { PC_RIG_TOOL_NAMES } from '../src/services/pod-tool-catalog.ts';

test('PC_RIG_TOOL_NAMES covers every tool in the MCP server TOOLS array', () => {
  const fromServer = TOOLS.map((t) => `mcp__pc-rig__${t.name}`);
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
