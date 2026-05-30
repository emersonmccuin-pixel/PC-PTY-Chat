// Pins the closed-world variable catalog (Section 4h / D75). The catalog is
// the contract every port schema (4h.2) and YAML wire (4h.3 / 4h.4) resolves
// against — anyone bumping the roster bumps this test.
//
// Run via:  pnpm --filter @pc/domain test
// Or:       pnpm test:unit  (from repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CatalogEntry, CatalogName, CatalogType } from '../src/index.ts';
import {
  CATALOG_TYPES,
  WORKFLOW_CATALOG,
  WORKFLOW_CATALOG_NAMES,
  catalogNameHasSource,
  getCatalogEntry,
  isCatalogName,
} from '../src/index.ts';

// --- roster -----------------------------------------------------------------

test('catalog roster matches the locked D75 list', () => {
  assert.deepEqual(
    [...WORKFLOW_CATALOG_NAMES].sort(),
    [
      'projectId',
      'runId',
      'sessionId',
      'stageId',
      'webhookBody',
      'webhookHeaders',
      'webhookQuery',
      'webhookSource',
      'workItemId',
      'worktreePath',
    ],
  );
});

test('every entry self-identifies (name field === map key)', () => {
  for (const name of WORKFLOW_CATALOG_NAMES) {
    assert.equal(WORKFLOW_CATALOG[name].name, name);
  }
});

test('every entry carries a non-empty description', () => {
  for (const name of WORKFLOW_CATALOG_NAMES) {
    assert.ok(WORKFLOW_CATALOG[name].description.trim().length > 0, name);
  }
});

test('every entry has at least one source', () => {
  for (const name of WORKFLOW_CATALOG_NAMES) {
    assert.ok(WORKFLOW_CATALOG[name].sources.length > 0, name);
  }
});

// --- type vocabulary --------------------------------------------------------

test('every entry type is in CATALOG_TYPES', () => {
  for (const name of WORKFLOW_CATALOG_NAMES) {
    const t: CatalogType = WORKFLOW_CATALOG[name].type;
    assert.ok(CATALOG_TYPES.includes(t), `${name}: ${t}`);
  }
});

test('CATALOG_TYPES holds the D78 vocabulary', () => {
  assert.deepEqual(
    [...CATALOG_TYPES].sort(),
    ['array', 'bool', 'int', 'object', 'string', 'text', 'ulid'],
  );
});

// --- pinned types per D75 table --------------------------------------------

test('workItemId is a ulid sourced from trigger + node-output', () => {
  const e = WORKFLOW_CATALOG.workItemId;
  assert.equal(e.type, 'ulid');
  assert.deepEqual([...e.sources].sort(), ['node-output', 'trigger']);
});

test('stageId is a string sourced from trigger only', () => {
  const e = WORKFLOW_CATALOG.stageId;
  assert.equal(e.type, 'string');
  assert.deepEqual([...e.sources], ['trigger']);
});

test('runtime-sourced entries match D75', () => {
  for (const name of ['projectId', 'runId', 'sessionId', 'worktreePath'] as const) {
    assert.ok(WORKFLOW_CATALOG[name].sources.includes('runtime'), name);
  }
  assert.equal(WORKFLOW_CATALOG.projectId.type, 'ulid');
  assert.equal(WORKFLOW_CATALOG.runId.type, 'ulid');
  assert.equal(WORKFLOW_CATALOG.sessionId.type, 'string');
  assert.equal(WORKFLOW_CATALOG.worktreePath.type, 'string');
});

test('webhook* entries are trigger-sourced with the D75 types', () => {
  assert.equal(WORKFLOW_CATALOG.webhookBody.type, 'text');
  assert.equal(WORKFLOW_CATALOG.webhookQuery.type, 'object');
  assert.equal(WORKFLOW_CATALOG.webhookHeaders.type, 'object');
  assert.equal(WORKFLOW_CATALOG.webhookSource.type, 'string');
  for (const name of [
    'webhookBody',
    'webhookQuery',
    'webhookHeaders',
    'webhookSource',
  ] as const) {
    assert.deepEqual([...WORKFLOW_CATALOG[name].sources], ['trigger']);
  }
});

// --- helpers ----------------------------------------------------------------

test('isCatalogName narrows known names', () => {
  assert.equal(isCatalogName('workItemId'), true);
  assert.equal(isCatalogName('projectId'), true);
  assert.equal(isCatalogName(''), false);
  assert.equal(isCatalogName('not-a-real-name'), false);
  assert.equal(isCatalogName('__proto__'), false);
  assert.equal(isCatalogName('toString'), false);
});

test('getCatalogEntry returns the entry for known names, undefined otherwise', () => {
  const entry: CatalogEntry | undefined = getCatalogEntry('workItemId');
  assert.ok(entry, 'expected workItemId to be a catalog entry');
  assert.equal(entry?.name, 'workItemId');
  assert.equal(getCatalogEntry('not-real'), undefined);
});

test('catalogNameHasSource reflects the entry.sources array', () => {
  assert.equal(catalogNameHasSource('workItemId', 'trigger'), true);
  assert.equal(catalogNameHasSource('workItemId', 'node-output'), true);
  assert.equal(catalogNameHasSource('workItemId', 'runtime'), false);
  assert.equal(catalogNameHasSource('projectId', 'runtime'), true);
  assert.equal(catalogNameHasSource('projectId', 'trigger'), false);
  assert.equal(catalogNameHasSource('not-real', 'runtime'), false);
});

// --- type-level smoke -------------------------------------------------------

test('CatalogName is the union of catalog keys', () => {
  // Compile-time check; if WORKFLOW_CATALOG keys drift, this will fail to
  // typecheck (which `pnpm typecheck` will catch).
  const sample: CatalogName = 'workItemId';
  assert.equal(typeof sample, 'string');
});
