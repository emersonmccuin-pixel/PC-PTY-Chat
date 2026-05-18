// Unit tests for the pure retry-decision helpers (4a.7 / D17). The runtime's
// `tryRetry` composes these with side-effects (nodeOutput mutation +
// setTimeout); the side-effect path is exercised end-to-end by the section's
// integration test.
//
// Run via:  pnpm --filter @pc/server test
// Or:       pnpm test:unit  (from repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { RetryPolicy } from '@pc/domain';

import { detectRetryCause, shouldRetry } from '../src/services/retry-policy.ts';

function nodeWith(retry?: RetryPolicy): { retry?: RetryPolicy } {
  return retry ? { retry } : {};
}

// ── shouldRetry decision matrix ────────────────────────────────────────────

test('shouldRetry: no retry block → never retry', () => {
  assert.equal(shouldRetry(nodeWith(), 1, 'failed'), false);
  assert.equal(shouldRetry(nodeWith(), 1, 'timeout'), false);
});

test('shouldRetry: attempt < max + cause matches default `failed` → retry', () => {
  assert.equal(
    shouldRetry(nodeWith({ max_attempts: 3 }), 1, 'failed'),
    true,
  );
});

test('shouldRetry: attempt at max → do not retry', () => {
  assert.equal(
    shouldRetry(nodeWith({ max_attempts: 3 }), 3, 'failed'),
    false,
  );
});

test('shouldRetry: max_attempts: 1 → never retry (single-attempt opt-out)', () => {
  assert.equal(
    shouldRetry(nodeWith({ max_attempts: 1 }), 1, 'failed'),
    false,
  );
});

test('shouldRetry: default `on` is [failed] — timeout does NOT retry without opt-in', () => {
  assert.equal(
    shouldRetry(nodeWith({ max_attempts: 3 }), 1, 'timeout'),
    false,
  );
});

test('shouldRetry: explicit `on: [timeout]` retries timeouts only', () => {
  assert.equal(
    shouldRetry(nodeWith({ max_attempts: 3, on: ['timeout'] }), 1, 'timeout'),
    true,
  );
  assert.equal(
    shouldRetry(nodeWith({ max_attempts: 3, on: ['timeout'] }), 1, 'failed'),
    false,
  );
});

test('shouldRetry: explicit `on: [failed, timeout]` retries both', () => {
  assert.equal(
    shouldRetry(
      nodeWith({ max_attempts: 3, on: ['failed', 'timeout'] }),
      1,
      'failed',
    ),
    true,
  );
  assert.equal(
    shouldRetry(
      nodeWith({ max_attempts: 3, on: ['failed', 'timeout'] }),
      1,
      'timeout',
    ),
    true,
  );
});

// ── detectRetryCause string-detection rules ─────────────────────────────────

test('detectRetryCause: error starting with "timeout (" → timeout', () => {
  assert.equal(detectRetryCause('timeout (5000ms exceeded)'), 'timeout');
  assert.equal(detectRetryCause('timeout (10000ms exceeded)'), 'timeout');
});

test('detectRetryCause: anything else → failed', () => {
  assert.equal(detectRetryCause(undefined), 'failed');
  assert.equal(detectRetryCause(''), 'failed');
  assert.equal(detectRetryCause('exit 1: command failed'), 'failed');
  assert.equal(detectRetryCause('ECONNREFUSED'), 'failed');
  // Even a string that contains "timeout" later doesn't count — only the
  // explicit prefix is meaningful. Pragmatic for v1.
  assert.equal(detectRetryCause('socket: timeout after read'), 'failed');
});
