// Resolution-order + override-handling tests for the claude binary resolver.
// PATH/homedir probes are injected so tests never touch the real machine's
// `where claude` (which would find the dev's actual install and defeat the
// fallthrough cases).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveClaudeBinary,
  requireClaudeBinary,
  setConfiguredClaudeExe,
  clearClaudeProbeCache,
} from '../src/claude-resolver.ts';

beforeEach(() => {
  setConfiguredClaudeExe(null);
  clearClaudeProbeCache();
  delete process.env.CLAUDE_EXE;
});

test('per-call override wins over config + env', () => {
  setConfiguredClaudeExe('/config/claude');
  process.env.CLAUDE_EXE = '/env/claude';
  const r = resolveClaudeBinary({ override: '/explicit/claude' });
  assert.equal(r.path, '/explicit/claude');
  assert.equal(r.source, 'override');
});

test('config override beats env', () => {
  setConfiguredClaudeExe('/config/claude');
  process.env.CLAUDE_EXE = '/env/claude';
  const r = resolveClaudeBinary();
  assert.equal(r.path, '/config/claude');
  assert.equal(r.source, 'config');
});

test('env CLAUDE_EXE used when no override/config', () => {
  process.env.CLAUDE_EXE = '/env/claude';
  const r = resolveClaudeBinary({ probePath: () => '/should/not/reach' });
  assert.equal(r.path, '/env/claude');
  assert.equal(r.source, 'env');
});

test('PATH probe used when no override/config/env', () => {
  const r = resolveClaudeBinary({
    probePath: () => '/usr/bin/claude',
    probeHomedir: () => null,
  });
  assert.equal(r.path, '/usr/bin/claude');
  assert.equal(r.source, 'path');
});

test('homedir fallback when PATH empty', () => {
  const r = resolveClaudeBinary({
    probePath: () => null,
    probeHomedir: () => '/home/u/.local/bin/claude',
  });
  assert.equal(r.path, '/home/u/.local/bin/claude');
  assert.equal(r.source, 'homedir');
});

test('not-found when every source is empty', () => {
  const r = resolveClaudeBinary({ probePath: () => null, probeHomedir: () => null });
  assert.equal(r.path, null);
  assert.equal(r.source, 'not-found');
});

test('whitespace-only override is ignored, falls through to config', () => {
  setConfiguredClaudeExe('/config/claude');
  const r = resolveClaudeBinary({ override: '   ' });
  assert.equal(r.source, 'config');
});

test('setConfiguredClaudeExe trims; empty clears the override', () => {
  setConfiguredClaudeExe('  /c/claude  ');
  assert.equal(resolveClaudeBinary().path, '/c/claude');
  setConfiguredClaudeExe('   ');
  const r = resolveClaudeBinary({ probePath: () => null, probeHomedir: () => null });
  assert.equal(r.source, 'not-found');
});

test('requireClaudeBinary returns an explicit override path', () => {
  assert.equal(requireClaudeBinary('/x/claude'), '/x/claude');
});
