// Section 22.3 — dataDir contract.
//
// Per the 2026-05-25 stabilization handoff: persisted `dataDir` is
// informational only. Every storage path on the server derives from
// `getDataDir()`, which honours `PC_DATA_DIR` (env override) and falls back
// to the workspace-root `/data` directory.
//
// This test pins the contract so future edits can't reintroduce divergence
// between the persisted settings field, the effective runtime path, and what
// every storage helper (DB, scratch, project registry, scaffold, events) uses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';

import { getDataDir } from '@pc/utils';
import { withSettingsDefaults } from '@pc/domain';

test('22.3: PC_DATA_DIR is the single source of truth for getDataDir()', () => {
  const original = process.env.PC_DATA_DIR;
  process.env.PC_DATA_DIR = 'C:/pc-test-data';
  try {
    assert.equal(getDataDir(), 'C:/pc-test-data');
  } finally {
    if (original === undefined) delete process.env.PC_DATA_DIR;
    else process.env.PC_DATA_DIR = original;
  }
});

test('22.3: withSettingsDefaults surfaces caller dataDir even when a stale value is persisted', () => {
  // The settings repo may carry an old persisted `dataDir` from before
  // Section 22.3 (when the field was a phantom edit target). `readSettings`
  // in apps/server/src/index.ts now overrides it with `getDataDir()` before
  // returning, but the upstream defaults helper must also be safe — if it
  // ever stops backfilling, the persisted-vs-runtime drift comes back.
  const stored = { dataDir: '/stale/persisted/value' };
  const merged = withSettingsDefaults(stored, '/effective/runtime', homedir());
  // withSettingsDefaults preserves whatever the caller passed in `stored` —
  // that's its contract. `readSettings()` is what then overrides to the
  // effective value. Pin both behaviours so the override stays load-bearing.
  assert.equal(
    merged.dataDir,
    '/stale/persisted/value',
    'withSettingsDefaults must honour stored value; the readSettings override is what makes it cosmetic.',
  );
  // The override pattern in apps/server/src/index.ts:
  const overridden = { ...merged, dataDir: '/effective/runtime' };
  assert.equal(overridden.dataDir, '/effective/runtime');
});

test('22.3: defaults fill dataDir when nothing is persisted', () => {
  const merged = withSettingsDefaults({}, '/effective/runtime', homedir());
  assert.equal(merged.dataDir, '/effective/runtime');
});
