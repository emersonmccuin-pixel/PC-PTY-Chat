// Section 36 / builder-surface — catalog drift test.
//
// Asserts that:
//   1. Every tool in CAISSON_POD_CONTENT.tools is a valid PC_RIG_TOOL_NAMES entry
//      or a non-pc-rig tool (Read, Bash, etc.). No silently-dead mcp__pc-rig__ grants.
//   2. The 6 new workspace-shaping tools (pc_create_workflow etc.) are listed in
//      caisson's tools allowlist.
//   3. PC_RIG_TOOL_NAMES is non-empty and derived from TOOLS (count parity).
//
// Run via: pnpm --filter @pc/server test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PC_RIG_TOOL_NAMES } from '../src/services/pod-tool-catalog.ts';
import { STOCK_POD_CONTENT } from '../src/services/stock-pod-seed.ts';
import { TOOLS } from '@pc/mcp';

const caissonPod = STOCK_POD_CONTENT.find((p) => p.name === 'caisson');
assert.ok(caissonPod, 'caisson pod missing from STOCK_POD_CONTENT');

const caissonTools = caissonPod!.tools ?? [];

test('PC_RIG_TOOL_NAMES is non-empty and matches TOOLS count', () => {
  assert.ok(PC_RIG_TOOL_NAMES.length > 0, 'PC_RIG_TOOL_NAMES must not be empty');
  assert.equal(
    PC_RIG_TOOL_NAMES.length,
    TOOLS.length,
    'PC_RIG_TOOL_NAMES count must equal TOOLS count',
  );
});

test('every mcp__pc-rig__ tool in caisson allowlist is a real PC_RIG_TOOL_NAMES entry', () => {
  const rigTools = caissonTools.filter((t: string) => t.startsWith('mcp__pc-rig__'));
  for (const name of rigTools) {
    assert.ok(
      PC_RIG_TOOL_NAMES.includes(name),
      `caisson tool "${name}" is not in PC_RIG_TOOL_NAMES — dead grant`,
    );
  }
});

test('caisson allowlist includes the 6 new workspace-shaping tools', () => {
  const required = [
    'mcp__pc-rig__pc_create_workflow',
    'mcp__pc-rig__pc_update_workflow',
    'mcp__pc-rig__pc_delete_workflow',
    'mcp__pc-rig__pc_get_workflow',
    'mcp__pc-rig__pc_replace_stages',
    'mcp__pc-rig__pc_replace_field_schemas',
  ];
  for (const name of required) {
    assert.ok(
      caissonTools.includes(name),
      `caisson tools missing "${name}"`,
    );
  }
});
