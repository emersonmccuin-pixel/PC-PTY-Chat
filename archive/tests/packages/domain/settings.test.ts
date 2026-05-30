// Section 33 — pin the claudeConfigDir profile-override contract: the field
// defaults to null (inherit shell env), survives the backfill of old envelopes,
// and the env-resolution helper enforces "override wins, else restore the
// captured shell value (which may be undefined)".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultGlobalSettings,
  normalizeOrchestratorSurfacePreference,
  resolveClaudeConfigDirEnv,
  withSettingsDefaults,
} from '../src/settings.ts';

const DATA = 'E:\\data';
const HOME = 'C:\\Users\\me';

test('defaultGlobalSettings seeds claudeConfigDir as null (inherit shell)', () => {
  assert.equal(defaultGlobalSettings(DATA, HOME).claudeConfigDir, null);
});

test('defaultGlobalSettings seeds defaultOrchestratorSurface as chat', () => {
  assert.equal(defaultGlobalSettings(DATA, HOME).defaultOrchestratorSurface, 'chat');
});

test('withSettingsDefaults backfills claudeConfigDir on a pre-Section-33 envelope', () => {
  // Old row that predates the field entirely.
  const merged = withSettingsDefaults({ telemetryOptIn: true }, DATA, HOME);
  assert.equal(merged.claudeConfigDir, null);
});

test('withSettingsDefaults backfills defaultOrchestratorSurface on old envelopes', () => {
  const merged = withSettingsDefaults({ telemetryOptIn: true }, DATA, HOME);
  assert.equal(merged.defaultOrchestratorSurface, 'chat');
});

test('withSettingsDefaults preserves valid defaultOrchestratorSurface values', () => {
  assert.equal(
    withSettingsDefaults({ defaultOrchestratorSurface: 'terminal' }, DATA, HOME)
      .defaultOrchestratorSurface,
    'terminal',
  );
  assert.equal(
    withSettingsDefaults({ defaultOrchestratorSurface: 'chat' }, DATA, HOME)
      .defaultOrchestratorSurface,
    'chat',
  );
});

test('normalizeOrchestratorSurfacePreference rejects invalid values', () => {
  assert.equal(normalizeOrchestratorSurfacePreference('terminal', 'chat'), 'terminal');
  assert.equal(normalizeOrchestratorSurfacePreference('chat', 'terminal'), 'chat');
  assert.equal(normalizeOrchestratorSurfacePreference('bogus', 'terminal'), 'terminal');
  assert.equal(normalizeOrchestratorSurfacePreference(undefined, 'chat'), 'chat');
});

test('withSettingsDefaults preserves a stored override', () => {
  const merged = withSettingsDefaults(
    { claudeConfigDir: 'C:\\Users\\me\\.claude-alt' },
    DATA,
    HOME,
  );
  assert.equal(merged.claudeConfigDir, 'C:\\Users\\me\\.claude-alt');
});

test('resolveClaudeConfigDirEnv: non-null override always wins', () => {
  assert.equal(resolveClaudeConfigDirEnv('D:\\cc', undefined), 'D:\\cc');
  assert.equal(resolveClaudeConfigDirEnv('D:\\cc', 'C:\\shell\\.claude'), 'D:\\cc');
});

test('resolveClaudeConfigDirEnv: null override restores the captured shell value', () => {
  assert.equal(resolveClaudeConfigDirEnv(null, 'C:\\shell\\.claude'), 'C:\\shell\\.claude');
});

test('resolveClaudeConfigDirEnv: null override + no shell value → undefined (unset)', () => {
  assert.equal(resolveClaudeConfigDirEnv(null, undefined), undefined);
});

test('resolveClaudeConfigDirEnv: empty-string override is treated as no override', () => {
  // The PATCH route already coerces blank input to null, but guard the helper
  // too — an empty string must not become an empty CLAUDE_CONFIG_DIR.
  assert.equal(resolveClaudeConfigDirEnv('', 'C:\\shell\\.claude'), 'C:\\shell\\.claude');
});
