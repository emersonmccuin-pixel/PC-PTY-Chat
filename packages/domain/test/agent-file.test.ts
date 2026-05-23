// Round-trip + parse coverage for agent .md files. Pins the byte-for-byte
// fidelity contract: parse → serialize without changes returns the original
// file unchanged, including comments, key order, and unknown fields.
//
// Run via:  pnpm --filter @pc/domain test
// Or:       pnpm test:unit  (from repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAgentFile,
  serializeAgentFile,
  type AgentDef,
  type AgentParseOk,
} from '../src/index.ts';

function parseOk(text: string): AgentParseOk {
  const r = parseAgentFile(text);
  if (!r.ok) throw new Error(`parse failed: ${r.reason} — ${r.message}`);
  return r;
}

// --- unknown-field preservation --------------------------------------------

test('parse + serialize: unknown frontmatter keys are preserved verbatim', () => {
  const text = [
    '---',
    'name: probe',
    'description: a probe agent',
    'tools:',
    '  - Read',
    'pc.custom: { keep: this }', // unknown to AgentDef
    'someOtherKey: 42',
    '---',
    'body text here',
    '',
  ].join('\n');

  const parsed = parseOk(text);
  // Mutating a known field shouldn't drop unknowns.
  const next: AgentDef = { ...parsed.def, model: 'sonnet' };
  const out = serializeAgentFile({ def: next, body: parsed.body, original: text });

  assert.ok(out.includes('pc.custom:'), 'pc.custom key was lost');
  assert.ok(out.includes('someOtherKey: 42'), 'someOtherKey was lost');
  assert.ok(out.includes('model: sonnet'), 'new model field not added');
});

test('parse + serialize: comments and key order are preserved', () => {
  const text = [
    '---',
    '# top-of-file comment',
    'name: probe',
    'description: a probe agent',
    '# above tools',
    'tools:',
    '  - Read',
    '  - Glob',
    'model: sonnet',
    '---',
    'body',
    '',
  ].join('\n');

  const parsed = parseOk(text);
  const out = serializeAgentFile({ def: parsed.def, body: parsed.body, original: text });
  assert.equal(out, text);
});

// --- error shape -----------------------------------------------------------

test('parse: missing frontmatter opener returns no-frontmatter error', () => {
  const r = parseAgentFile('hello world\n');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'no-frontmatter');
});

test('parse: unterminated frontmatter returns unterminated-frontmatter error', () => {
  const r = parseAgentFile('---\nname: probe\ndescription: x\n');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'unterminated-frontmatter');
});

test('parse: malformed YAML returns yaml-error', () => {
  const r = parseAgentFile('---\nname: [unterminated\n---\nbody\n');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'yaml-error');
});

// --- fresh serialize (no original) -----------------------------------------

test('serialize: fresh file with no original emits a parseable result', () => {
  const def: AgentDef = {
    name: 'fresh',
    description: 'a freshly-authored agent',
    model: 'sonnet',
    tools: ['Read', 'Glob'],
    maxTurns: 20,
  };
  const out = serializeAgentFile({ def, body: '# fresh agent\n\nDoes the thing.\n' });
  const reparsed = parseOk(out);
  assert.equal(reparsed.def.name, 'fresh');
  assert.equal(reparsed.def.model, 'sonnet');
  assert.deepEqual(reparsed.def.tools, ['Read', 'Glob']);
  assert.equal(reparsed.def.maxTurns, 20);
});

// --- CRLF tolerance --------------------------------------------------------

test('round-trip: CRLF line endings survive a no-op round-trip', () => {
  const text = '---\r\nname: probe\r\ndescription: x\r\nmodel: sonnet\r\n---\r\nbody\r\n';
  const parsed = parseOk(text);
  const out = serializeAgentFile({ def: parsed.def, body: parsed.body, original: text });
  // The closer line preserves \r\n; we don't promise the YAML region keeps
  // CRLF (yaml lib normalizes to \n), but the opener/closer/body do.
  assert.ok(out.startsWith('---\r\n'));
  assert.ok(out.includes('\r\n---\r\n') || out.endsWith('---\r\nbody\r\n'));
  assert.ok(out.endsWith('body\r\n'));
});
