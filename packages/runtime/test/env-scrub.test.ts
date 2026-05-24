// Pin the env-scrub set + the FORCE_COLOR injection.
//
// IDE-integration markers ⇒ CC tries to attach to a parent IPC channel and
// silently discards the first user input. Removing them is load-bearing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IDE_INTEGRATION_ENV_KEYS,
  scrubIdeEnv,
} from '../src/env-scrub.ts';

test('scrubs every key in IDE_INTEGRATION_ENV_KEYS', () => {
  const env: Record<string, string> = {
    PATH: '/usr/bin',
    USER: 'me',
  };
  for (const key of IDE_INTEGRATION_ENV_KEYS) {
    env[key] = 'should-be-removed';
  }
  const out = scrubIdeEnv(env);
  for (const key of IDE_INTEGRATION_ENV_KEYS) {
    assert.equal(out[key], undefined, `expected ${key} to be scrubbed`);
  }
  assert.equal(out.PATH, '/usr/bin');
  assert.equal(out.USER, 'me');
});

test('always sets FORCE_COLOR=0', () => {
  const out = scrubIdeEnv({});
  assert.equal(out.FORCE_COLOR, '0');
});

test('extra env wins over base env, FORCE_COLOR included', () => {
  const out = scrubIdeEnv(
    { FOO: 'base', PATH: '/usr/bin' },
    { FOO: 'override', PC_SESSION_ID: 'abc' },
  );
  assert.equal(out.FOO, 'override');
  assert.equal(out.PATH, '/usr/bin');
  assert.equal(out.PC_SESSION_ID, 'abc');
});

test('undefined values are dropped from both base and extra', () => {
  const out = scrubIdeEnv(
    { KEEP: 'yes', DROP: undefined },
    { ALSO_DROP: undefined },
  );
  assert.equal(out.KEEP, 'yes');
  assert.equal('DROP' in out, false);
  assert.equal('ALSO_DROP' in out, false);
});

test('IDE keys in `extra` are NOT scrubbed — caller can re-inject for tests', () => {
  // Extra is intended for caller-supplied vars like PC_SESSION_ID. A
  // surprising re-injection of an IDE-marker via extra is the caller's
  // responsibility (we don't double-filter; we only scrub the base env).
  const out = scrubIdeEnv({}, { TERM_PROGRAM: 'on-purpose' });
  assert.equal(out.TERM_PROGRAM, 'on-purpose');
});
