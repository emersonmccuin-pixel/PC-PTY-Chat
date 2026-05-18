// Truth table for validateAgentDef. Pins the field-level error contract the
// form editor (3d) + write endpoints rely on.
//
// Run via:  pnpm --filter @pc/domain test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateAgentDef, type AgentDef } from '../src/index.ts';

function base(): AgentDef {
  return { name: 'probe', description: 'a probe agent' };
}

function errFor(field: string, def: AgentDef): string | undefined {
  const r = validateAgentDef(def);
  if (r.ok) return undefined;
  return r.errors.find((e) => e.field === field)?.message;
}

test('ok: minimum viable def passes', () => {
  const r = validateAgentDef(base());
  assert.equal(r.ok, true);
});

// --- name ------------------------------------------------------------------

test('name: missing fails', () => {
  const d = base();
  (d as { name?: string }).name = '';
  assert.ok(errFor('name', d));
});

test('name: uppercase fails (kebab-case rule)', () => {
  assert.ok(errFor('name', { ...base(), name: 'Probe' }));
});

test('name: dot allowed-in-file-slug but rejected by kebab-case validator', () => {
  // safeAgentName accepts dots in file slugs but the typed validator enforces
  // strict kebab-case for the on-disk name. Keep these contracts independent.
  assert.ok(errFor('name', { ...base(), name: 'pro.be' }));
});

test('name: too long fails', () => {
  assert.ok(errFor('name', { ...base(), name: 'a'.repeat(65) }));
});

test('name: kebab-case with digits passes', () => {
  const r = validateAgentDef({ ...base(), name: 'agent-v2' });
  assert.equal(r.ok, true);
});

// --- description -----------------------------------------------------------

test('description: missing fails', () => {
  const d = base();
  (d as { description?: string }).description = '';
  assert.ok(errFor('description', d));
});

test('description: long but under soft cap passes', () => {
  const r = validateAgentDef({ ...base(), description: 'x'.repeat(280) });
  assert.equal(r.ok, true);
});

test('description: over soft cap fails', () => {
  assert.ok(errFor('description', { ...base(), description: 'x'.repeat(281) }));
});

// --- color / model / effort enums -----------------------------------------

test('color: invalid value fails', () => {
  assert.ok(errFor('color', { ...base(), color: 'mauve' as never }));
});

test('color: valid value passes', () => {
  const r = validateAgentDef({ ...base(), color: 'cyan' });
  assert.equal(r.ok, true);
});

test('model: empty string fails', () => {
  assert.ok(errFor('model', { ...base(), model: '' }));
});

test('model: full custom ID passes', () => {
  const r = validateAgentDef({ ...base(), model: 'claude-opus-4-7' });
  assert.equal(r.ok, true);
});

test('effort: invalid value fails', () => {
  assert.ok(errFor('effort', { ...base(), effort: 'turbo' as never }));
});

// --- maxTurns --------------------------------------------------------------

test('maxTurns: 0 fails', () => {
  assert.ok(errFor('maxTurns', { ...base(), maxTurns: 0 }));
});

test('maxTurns: non-integer fails', () => {
  assert.ok(errFor('maxTurns', { ...base(), maxTurns: 1.5 }));
});

test('maxTurns: positive integer passes', () => {
  const r = validateAgentDef({ ...base(), maxTurns: 20 });
  assert.equal(r.ok, true);
});

// --- tools / disallowedTools ----------------------------------------------

test('tools: non-array fails', () => {
  assert.ok(errFor('tools', { ...base(), tools: 'Read' as never }));
});

test('tools: empty entry fails', () => {
  assert.ok(errFor('tools[1]', { ...base(), tools: ['Read', ''] }));
});

test('tools: valid list passes', () => {
  const r = validateAgentDef({ ...base(), tools: ['Read', 'Glob', 'Grep'] });
  assert.equal(r.ok, true);
});

// --- isolation -------------------------------------------------------------

test('isolation: wrong value fails', () => {
  assert.ok(errFor('isolation', { ...base(), isolation: 'sandbox' as never }));
});

test('isolation: worktree passes', () => {
  const r = validateAgentDef({ ...base(), isolation: 'worktree' });
  assert.equal(r.ok, true);
});

// --- mcpServers ------------------------------------------------------------

test('mcpServers: string entry passes', () => {
  const r = validateAgentDef({ ...base(), mcpServers: ['pc-rig'] });
  assert.equal(r.ok, true);
});

test('mcpServers: inline object passes', () => {
  const r = validateAgentDef({
    ...base(),
    mcpServers: [{ command: 'node', args: ['x.js'] }],
  });
  assert.equal(r.ok, true);
});

test('mcpServers: invalid entry fails', () => {
  assert.ok(errFor('mcpServers[0]', { ...base(), mcpServers: [42 as never] }));
});

// --- hooks -----------------------------------------------------------------

test('hooks: well-formed passes', () => {
  const r = validateAgentDef({
    ...base(),
    hooks: { PreToolUse: [{ matcher: 'Bash', command: 'echo' }] },
  });
  assert.equal(r.ok, true);
});

test('hooks: missing command fails', () => {
  assert.ok(
    errFor('hooks.PreToolUse[0]', {
      ...base(),
      hooks: { PreToolUse: [{ matcher: 'Bash' } as never] },
    }),
  );
});

// --- memory / permissionMode / initialPrompt -------------------------------

test('memory: invalid value fails', () => {
  assert.ok(errFor('memory', { ...base(), memory: 'global' as never }));
});

test('permissionMode: invalid value fails', () => {
  assert.ok(errFor('permissionMode', { ...base(), permissionMode: 'yolo' as never }));
});

test('initialPrompt: empty string fails', () => {
  assert.ok(errFor('initialPrompt', { ...base(), initialPrompt: '' }));
});

// --- composite -------------------------------------------------------------

test('errors: multiple field issues return as a list, none lost', () => {
  const r = validateAgentDef({
    ...base(),
    name: 'Bad-Name',
    color: 'mauve' as never,
    maxTurns: -1,
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  const fields = r.errors.map((e) => e.field).sort();
  assert.deepEqual(fields, ['color', 'maxTurns', 'name']);
});
