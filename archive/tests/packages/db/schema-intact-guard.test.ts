// Guard against migration-ledger drift: drizzle decides what to apply by the
// last-applied timestamp in __drizzle_migrations, not by inspecting the schema,
// so a ledger that records a migration applied while its columns are absent
// silently skips the real ALTER. assertSchemaIntact() catches that at boot.
// (Reproduces the 2026-05-29 "no such column: rev" crash-loop class.)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-db-guard-'));
process.env.PC_DATA_DIR = tmpDir;

const { getRawDb, closeDb, runMigrations, assertSchemaIntact } = await import('../src/index.ts');

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('passes on a freshly migrated DB', () => {
  assert.doesNotThrow(() => assertSchemaIntact());
});

test('throws naming the table.column when a declared column is missing', () => {
  const raw = getRawDb();
  // Simulate ledger drift: drop a column the schema still declares. The ledger
  // is untouched, so a re-migrate would NOT re-add it — exactly the drift case.
  raw.exec('ALTER TABLE `agents` DROP COLUMN `rev`');
  try {
    assert.throws(
      () => assertSchemaIntact(),
      (err: Error) => err.message.includes('agents.rev') && /missing table\/column/.test(err.message),
    );
  } finally {
    raw.exec('ALTER TABLE `agents` ADD COLUMN `rev` integer NOT NULL DEFAULT 0');
  }
});
