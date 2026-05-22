// Pins the tool catalog (17b.2). Catalog is the single source of truth for
// friendly tool names + descriptions; web UI + MCP layer both import from
// here.
//
// Run via:  pnpm --filter @pc/domain test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOL_CATALOG,
  descriptionOf,
  friendlyName,
  lookupTool,
} from '../src/index.ts';

test('catalog has at least one entry per source', () => {
  const sources = new Set(TOOL_CATALOG.map((e) => e.source));
  assert.ok(sources.has('cc-builtin'), 'cc-builtin missing');
  assert.ok(sources.has('pc-rig'), 'pc-rig missing');
});

test('slugs are unique', () => {
  const slugs = TOOL_CATALOG.map((e) => e.slug);
  const dupes = slugs.filter((s, i) => slugs.indexOf(s) !== i);
  assert.deepEqual(dupes, [], `duplicate slugs: ${dupes.join(', ')}`);
});

test('every entry has a label + description', () => {
  for (const entry of TOOL_CATALOG) {
    assert.ok(entry.label.length > 0, `${entry.slug}: empty label`);
    assert.ok(
      entry.description.length > 0,
      `${entry.slug}: empty description`,
    );
  }
});

test('CC built-ins are all 10 standard slugs', () => {
  const builtins = TOOL_CATALOG.filter((e) => e.source === 'cc-builtin').map(
    (e) => e.slug,
  );
  assert.deepEqual(
    [...builtins].sort(),
    [
      'Bash',
      'Edit',
      'Glob',
      'Grep',
      'NotebookEdit',
      'Read',
      'Task',
      'WebFetch',
      'WebSearch',
      'Write',
    ],
  );
});

test('pc-rig tools cover the 17b CRUD additions', () => {
  const slugs = new Set(TOOL_CATALOG.map((e) => e.slug));
  // Spot-check the 17b-added wrappers
  assert.ok(slugs.has('mcp__pc-rig__pc_create_agent'));
  assert.ok(slugs.has('mcp__pc-rig__pc_update_agent_prompt'));
  assert.ok(slugs.has('mcp__pc-rig__pc_get_agent'));
  assert.ok(slugs.has('mcp__pc-rig__pc_knowledge_read'));
  assert.ok(slugs.has('mcp__pc-rig__pc_list_agent_audit'));
});

test('friendlyName returns the label for cataloged slugs', () => {
  assert.equal(friendlyName('Read'), 'Read files');
  assert.equal(friendlyName('mcp__pc-rig__pc_log'), 'Log to project (PC)');
});

test('friendlyName falls through to the raw slug for unknowns', () => {
  assert.equal(friendlyName('mcp__gmail__send'), 'mcp__gmail__send');
});

test('descriptionOf returns null for unknown slugs', () => {
  assert.equal(descriptionOf('mcp__unknown__tool'), null);
});

test('lookupTool returns full entry or null', () => {
  const entry = lookupTool('Read');
  assert.ok(entry, 'expected Read entry to be cataloged');
  assert.equal(entry?.source, 'cc-builtin');
  assert.equal(lookupTool('does-not-exist'), null);
});
