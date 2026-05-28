// Section 36 / builder-surface — catalog drift test.
//
// Asserts that:
//   1. Every mcp__pc-rig__ grant in every stock pod AND the orchestrator
//      resolves to a real PC_RIG_TOOL_NAMES entry. No phantom/dead grants.
//   2. The 6 workspace-shaping tools (pc_create_workflow etc.) are listed in
//      caisson's tools allowlist.
//   3. PC_RIG_TOOL_NAMES is non-empty and derived from TOOLS (count parity).
//
// Generalized in Batch A of the tool-audit remediation — previously only
// checked the caisson pod, which is why the researcher's pc_node_failed
// phantom grant was never caught.
//
// Run via: pnpm --filter @pc/server test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PC_RIG_TOOL_NAMES } from '../src/services/pod-tool-catalog.ts';
import { STOCK_POD_CONTENT } from '../src/services/stock-pod-seed.ts';
import { ORCHESTRATOR_POD_CONTENT } from '../src/services/orchestrator-pod-content.ts';
import { TOOLS } from '@pc/mcp';

const caissonPod = STOCK_POD_CONTENT.find((p) => p.name === 'caisson');
assert.ok(caissonPod, 'caisson pod missing from STOCK_POD_CONTENT');

const caissonTools = caissonPod!.tools ?? [];

// All pods to check for dead grants: every stock pod + the orchestrator.
const ALL_PODS = [
  ...STOCK_POD_CONTENT,
  ORCHESTRATOR_POD_CONTENT,
];

test('PC_RIG_TOOL_NAMES is non-empty and matches TOOLS count', () => {
  assert.ok(PC_RIG_TOOL_NAMES.length > 0, 'PC_RIG_TOOL_NAMES must not be empty');
  assert.equal(
    PC_RIG_TOOL_NAMES.length,
    TOOLS.length,
    'PC_RIG_TOOL_NAMES count must equal TOOLS count',
  );
});

test('every mcp__pc-rig__ grant in every stock pod + orchestrator is a real PC_RIG_TOOL_NAMES entry', () => {
  for (const pod of ALL_PODS) {
    const rigTools = (pod.tools ?? []).filter((t: string) => t.startsWith('mcp__pc-rig__'));
    for (const name of rigTools) {
      assert.ok(
        PC_RIG_TOOL_NAMES.includes(name),
        `${pod.name} tool "${name}" is not in PC_RIG_TOOL_NAMES — dead grant`,
      );
    }
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
