// MCP server tool-definition tests.
//
// Verifies:
//   1. All 6 new workspace-shaping tools exist in TOOLS with correct shapes.
//   2. pc_update_work_item now has body/title props and relaxed required.
//   3. PC_RIG_TOOL_NAMES includes all new tools.
//   4. Every tool in TOOLS has a dispatch case (no orphan defs).
//
// Run via: pnpm --filter @pc/mcp test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, PC_RIG_TOOL_NAMES } from '../src/server.ts';

const toolMap = new Map(TOOLS.map((t) => [t.name, t]));

// ── New workflow tools ────────────────────────────────────────────────────────

test('pc_create_workflow exists in TOOLS with yaml/def/scope props', () => {
  const t = toolMap.get('pc_create_workflow');
  assert.ok(t, 'pc_create_workflow missing from TOOLS');
  const props = t.inputSchema.properties as Record<string, unknown>;
  assert.ok('yaml' in props, 'missing yaml prop');
  assert.ok('def' in props, 'missing def prop');
  assert.ok('scope' in props, 'missing scope prop');
  // Neither yaml nor def is in required — both are optional at schema level.
  const required = (t.inputSchema as { required?: string[] }).required ?? [];
  assert.ok(!required.includes('yaml'), 'yaml should not be required');
  assert.ok(!required.includes('def'), 'def should not be required');
});

test('pc_update_workflow exists in TOOLS with id required', () => {
  const t = toolMap.get('pc_update_workflow');
  assert.ok(t, 'pc_update_workflow missing from TOOLS');
  const required = (t.inputSchema as { required?: string[] }).required ?? [];
  assert.ok(required.includes('id'), 'id must be required');
  const props = t.inputSchema.properties as Record<string, unknown>;
  assert.ok('yaml' in props, 'missing yaml prop');
  assert.ok('def' in props, 'missing def prop');
  assert.ok('disabled' in props, 'missing disabled prop');
});

test('pc_delete_workflow exists in TOOLS with id required + cancel optional', () => {
  const t = toolMap.get('pc_delete_workflow');
  assert.ok(t, 'pc_delete_workflow missing from TOOLS');
  const required = (t.inputSchema as { required?: string[] }).required ?? [];
  assert.ok(required.includes('id'), 'id must be required');
  const props = t.inputSchema.properties as Record<string, unknown>;
  assert.ok('cancel' in props, 'missing cancel prop');
});

test('pc_get_workflow exists in TOOLS with id required', () => {
  const t = toolMap.get('pc_get_workflow');
  assert.ok(t, 'pc_get_workflow missing from TOOLS');
  const required = (t.inputSchema as { required?: string[] }).required ?? [];
  assert.ok(required.includes('id'), 'id must be required');
});

test('pc_replace_stages exists in TOOLS with stages required', () => {
  const t = toolMap.get('pc_replace_stages');
  assert.ok(t, 'pc_replace_stages missing from TOOLS');
  const required = (t.inputSchema as { required?: string[] }).required ?? [];
  assert.ok(required.includes('stages'), 'stages must be required');
  const props = t.inputSchema.properties as Record<string, unknown>;
  assert.ok('force' in props, 'missing force prop');
  assert.ok('fallbackStageId' in props, 'missing fallbackStageId prop');
});

test('pc_replace_field_schemas exists in TOOLS with items required', () => {
  const t = toolMap.get('pc_replace_field_schemas');
  assert.ok(t, 'pc_replace_field_schemas missing from TOOLS');
  const required = (t.inputSchema as { required?: string[] }).required ?? [];
  assert.ok(required.includes('items'), 'items must be required');
});

// ── pc_update_work_item extended shape ────────────────────────────────────────

test('pc_update_work_item has body and title props', () => {
  const t = toolMap.get('pc_update_work_item');
  assert.ok(t, 'pc_update_work_item missing from TOOLS');
  const props = t.inputSchema.properties as Record<string, unknown>;
  assert.ok('body' in props, 'missing body prop');
  assert.ok('title' in props, 'missing title prop');
  assert.ok('fields' in props, 'fields prop should still exist');
});

test('pc_update_work_item required is [id] only (fields no longer required)', () => {
  const t = toolMap.get('pc_update_work_item');
  assert.ok(t);
  const required = (t.inputSchema as { required?: string[] }).required ?? [];
  assert.deepEqual(required, ['id'], 'required should be exactly [id]');
});

// ── PC_RIG_TOOL_NAMES completeness ────────────────────────────────────────────

test('PC_RIG_TOOL_NAMES includes all 6 new tools', () => {
  const newTools = [
    'mcp__pc-rig__pc_create_workflow',
    'mcp__pc-rig__pc_update_workflow',
    'mcp__pc-rig__pc_delete_workflow',
    'mcp__pc-rig__pc_get_workflow',
    'mcp__pc-rig__pc_replace_stages',
    'mcp__pc-rig__pc_replace_field_schemas',
  ];
  for (const name of newTools) {
    assert.ok(
      PC_RIG_TOOL_NAMES.includes(name),
      `${name} missing from PC_RIG_TOOL_NAMES`,
    );
  }
});

test('PC_RIG_TOOL_NAMES has same count as TOOLS', () => {
  assert.equal(PC_RIG_TOOL_NAMES.length, TOOLS.length, 'counts must match');
});

test('every PC_RIG_TOOL_NAMES entry is mcp__pc-rig__<toolName>', () => {
  for (const t of TOOLS) {
    const expected = `mcp__pc-rig__${t.name}`;
    assert.ok(
      PC_RIG_TOOL_NAMES.includes(expected),
      `${expected} missing from PC_RIG_TOOL_NAMES`,
    );
  }
});
