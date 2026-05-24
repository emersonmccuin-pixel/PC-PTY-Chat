// Pin the path-resolution contract — CLAUDE_CONFIG_DIR override, CWD encoding,
// JSONL path composition. Path resolution is load-bearing across the rebuild
// (Section 25 design § 3.9, § 11.2) and the recurring trap is the labs path:
// production code historically hardcoded `~/.claude` and missed CC's
// CLAUDE_CONFIG_DIR env honor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  claudeConfigDir,
  claudeProjectsRoot,
  encodeCwdForClaude,
  jsonlPathFor,
  projectDirFor,
} from '../src/path-resolver.ts';

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const prior = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
}

test('claudeConfigDir defaults to ~/.claude when CLAUDE_CONFIG_DIR unset', () => {
  withEnv('CLAUDE_CONFIG_DIR', undefined, () => {
    assert.equal(claudeConfigDir(), join(homedir(), '.claude'));
  });
});

test('claudeConfigDir honors CLAUDE_CONFIG_DIR env var', () => {
  withEnv('CLAUDE_CONFIG_DIR', 'E:\\custom\\claude', () => {
    assert.equal(claudeConfigDir(), 'E:\\custom\\claude');
  });
});

test('claudeProjectsRoot composes correctly under both modes', () => {
  withEnv('CLAUDE_CONFIG_DIR', undefined, () => {
    assert.equal(claudeProjectsRoot(), join(homedir(), '.claude', 'projects'));
  });
  withEnv('CLAUDE_CONFIG_DIR', 'D:\\cc', () => {
    assert.equal(claudeProjectsRoot(), join('D:\\cc', 'projects'));
  });
});

test('encodeCwdForClaude collapses non-[A-Za-z0-9._-] to "-"', () => {
  // Empirical samples from Section 0.
  assert.equal(
    encodeCwdForClaude('E:\\Projects\\Caisson'),
    'E--Claude-Code-Projects-Personal-PC-PTY-Chat',
  );
  assert.equal(
    encodeCwdForClaude('C:\\Users\\example\\AppData\\Local\\Temp\\cc-stream-test'),
    'C--Users-emers-AppData-Local-Temp-cc-stream-test',
  );
  // Dot, underscore, hyphen preserved.
  assert.equal(encodeCwdForClaude('a.b_c-d/e f'), 'a.b_c-d-e-f');
});

test('encodeCwdForClaude is idempotent on safe input', () => {
  const safe = 'just-A-Plain.Path_thing';
  assert.equal(encodeCwdForClaude(safe), safe);
});

test('projectDirFor and jsonlPathFor compose the deterministic on-disk shape', () => {
  withEnv('CLAUDE_CONFIG_DIR', 'X:\\cc', () => {
    const cwd = 'X:\\work space';
    const sessionId = '00000000-0000-0000-0000-000000000001';
    assert.equal(projectDirFor(cwd), join('X:\\cc', 'projects', 'X--work-space'));
    assert.equal(
      jsonlPathFor(cwd, sessionId),
      join('X:\\cc', 'projects', 'X--work-space', `${sessionId}.jsonl`),
    );
  });
});
