import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveRuntimeHealth } from '../src/services/orchestrator-runtime-health.ts';

test('runtime health maps an absent PTY to not_spawned', () => {
  assert.equal(deriveRuntimeHealth({ ptyState: null }), 'not_spawned');
});

test('runtime health maps PTY thinking to busy', () => {
  assert.equal(deriveRuntimeHealth({ ptyState: 'thinking' }), 'busy');
});

test('runtime health distinguishes first spawn from respawn', () => {
  assert.equal(deriveRuntimeHealth({ ptyState: 'spawning' }), 'spawning');
  assert.equal(
    deriveRuntimeHealth({ ptyState: 'spawning', lastExitAt: Date.now() }),
    'respawning',
  );
});

test('runtime health preserves terminal PTY exit', () => {
  assert.equal(deriveRuntimeHealth({ ptyState: 'exited' }), 'exited');
});

test('runtime health failures override transient PTY state', () => {
  assert.equal(
    deriveRuntimeHealth({
      ptyState: 'spawning',
      failureHealth: 'provider_missing',
    }),
    'provider_missing',
  );
  assert.equal(
    deriveRuntimeHealth({
      ptyState: 'ready',
      failureHealth: 'failed_resume',
    }),
    'failed_resume',
  );
});
