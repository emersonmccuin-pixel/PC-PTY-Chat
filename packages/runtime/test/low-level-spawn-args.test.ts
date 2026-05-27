import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLowLevelSpawnArgs,
  type LowLevelSpawnInput,
} from '../src/low-level-spawn.ts';

function input(overrides: Partial<LowLevelSpawnInput> = {}): LowLevelSpawnInput {
  return {
    podDefinition: { name: 'pc-runtime:researcher' },
    worktreePath: 'E:/worktree',
    env: {},
    ccProviderSessionId: '00000000-0000-4000-8000-000000000000',
    mode: 'fresh',
    ...overrides,
  };
}

test('buildLowLevelSpawnArgs requests remote-control for ReadyGate init-complete', () => {
  const args = buildLowLevelSpawnArgs(input(), 'E:/scratch/mcp.json');

  assert.ok(args.includes('--remote-control'));
  assert.equal(args.filter((arg) => arg === '--remote-control').length, 1);
  assert.deepEqual(args.slice(0, 8), [
    '--dangerously-skip-permissions',
    '--agent',
    'pc-runtime:researcher',
    '--mcp-config',
    'E:/scratch/mcp.json',
    '--strict-mcp-config',
    '--remote-control',
    '--session-id',
  ]);
});

test('buildLowLevelSpawnArgs preserves session-local settings and empty setting sources', () => {
  const args = buildLowLevelSpawnArgs(input({
    settingsPath: 'E:/scratch/.claude/settings.json',
    settingSources: '',
    pluginDirs: ['E:/scratch/claude-plugin'],
    mode: 'resume',
  }));

  assert.deepEqual(args.slice(args.indexOf('--settings'), args.indexOf('--settings') + 2), [
    '--settings',
    'E:/scratch/.claude/settings.json',
  ]);
  assert.deepEqual(
    args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2),
    ['--setting-sources', ''],
  );
  assert.deepEqual(args.slice(args.indexOf('--plugin-dir'), args.indexOf('--plugin-dir') + 2), [
    '--plugin-dir',
    'E:/scratch/claude-plugin',
  ]);
  assert.deepEqual(args.slice(-2), ['--resume', '00000000-0000-4000-8000-000000000000']);
});
