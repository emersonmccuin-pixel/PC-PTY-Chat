// Section 10 Phase 1.4 — node launcher resolution.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveNodeLauncher } from '../src/node-launcher.ts';

test('dev / plain Node → bare `node`, no extra env', () => {
  const launcher = resolveNodeLauncher({}, '/usr/bin/node', false);
  assert.equal(launcher.command, 'node');
  assert.deepEqual(launcher.env, {});
});

test('inside Electron → app binary + ELECTRON_RUN_AS_NODE', () => {
  const launcher = resolveNodeLauncher({}, 'C:/Apps/Caisson/Caisson.exe', true);
  assert.equal(launcher.command, 'C:/Apps/Caisson/Caisson.exe');
  assert.deepEqual(launcher.env, { ELECTRON_RUN_AS_NODE: '1' });
});

test('PC_NODE_LAUNCHER override wins over Electron detection', () => {
  const launcher = resolveNodeLauncher(
    { PC_NODE_LAUNCHER: '/custom/node' },
    'C:/Apps/Caisson/Caisson.exe',
    true,
  );
  assert.equal(launcher.command, '/custom/node');
  assert.deepEqual(launcher.env, {});
});

test('blank / whitespace override is ignored', () => {
  const launcher = resolveNodeLauncher({ PC_NODE_LAUNCHER: '   ' }, '/usr/bin/node', false);
  assert.equal(launcher.command, 'node');
});
