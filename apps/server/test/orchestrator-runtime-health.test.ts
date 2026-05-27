import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveRuntimeHealth,
  deriveRuntimeWaitPoint,
} from '../src/services/orchestrator-runtime-health.ts';

test('runtime health maps an absent PTY to not_spawned', () => {
  assert.equal(deriveRuntimeHealth({ ptyState: null }), 'not_spawned');
  assert.equal(deriveRuntimeHealth({ ptyState: 'stopped' }), 'not_spawned');
});

test('runtime health maps PTY thinking/busy to busy', () => {
  assert.equal(deriveRuntimeHealth({ ptyState: 'thinking' }), 'busy');
  assert.equal(deriveRuntimeHealth({ ptyState: 'busy' }), 'busy');
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

test('runtime health maps failed wrapper state to failed resume health', () => {
  assert.equal(deriveRuntimeHealth({ ptyState: 'failed' }), 'failed_resume');
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

test('runtime wait point identifies missing session before process state', () => {
  assert.equal(
    deriveRuntimeWaitPoint({
      sessionId: null,
      health: 'ready',
    }),
    'session',
  );
});

test('runtime wait point prioritizes provider resume failures', () => {
  assert.equal(
    deriveRuntimeWaitPoint({
      sessionId: 'session-1',
      health: 'provider_missing',
      queueDepth: 2,
    }),
    'provider_resume',
  );
  assert.equal(
    deriveRuntimeWaitPoint({
      sessionId: 'session-1',
      health: 'failed_resume',
    }),
    'provider_resume',
  );
});

test('runtime wait point exposes queue before spawn or busy state', () => {
  assert.equal(
    deriveRuntimeWaitPoint({
      sessionId: 'session-1',
      health: 'spawning',
      queueDepth: 1,
    }),
    'queue',
  );
  assert.equal(
    deriveRuntimeWaitPoint({
      sessionId: 'session-1',
      health: 'busy',
      queueDepth: 1,
      rawJsonlExists: true,
      lastJsonlAt: Date.now(),
    }),
    'queue',
  );
});

test('runtime wait point distinguishes spawn, jsonl, active turn, and ready', () => {
  assert.equal(
    deriveRuntimeWaitPoint({
      sessionId: 'session-1',
      health: 'respawning',
    }),
    'spawn',
  );
  assert.equal(
    deriveRuntimeWaitPoint({
      sessionId: 'session-1',
      health: 'busy',
      rawJsonlExists: false,
      lastJsonlAt: null,
    }),
    'jsonl',
  );
  assert.equal(
    deriveRuntimeWaitPoint({
      sessionId: 'session-1',
      health: 'busy',
      rawJsonlExists: true,
      lastJsonlAt: Date.now(),
    }),
    'ready_state',
  );
  assert.equal(
    deriveRuntimeWaitPoint({
      sessionId: 'session-1',
      health: 'ready',
    }),
    'none',
  );
});
