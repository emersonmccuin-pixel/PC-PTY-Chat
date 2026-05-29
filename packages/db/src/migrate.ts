import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { defaultGlobalSettings } from '@pc/domain';
import { getDataDir } from '@pc/utils';
import { getDb, getRawDb } from './connection.ts';
import * as schema from './schema.ts';
import { settingsGlobal } from './schema.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Apply pending migrations, then ensure the settings_global singleton row exists.
 *
 *  `migrationsFolder` defaults to the package-relative `drizzle/` dir (dev/tsx).
 *  In a packaged/bundled build `__dirname` points inside the bundle, so the
 *  server passes an explicit ROOT-relative path to the staged copy. */
export function runMigrations(migrationsFolder = join(__dirname, '..', 'drizzle')): void {
  const db = getDb();
  migrate(db, { migrationsFolder });
  assertSchemaIntact();
  seedGlobalSettings();
}

/** Fail fast on migration-ledger drift. drizzle decides what to apply by the
 *  last-applied timestamp in `__drizzle_migrations`, NOT by inspecting the
 *  schema — so a ledger that records a migration as applied while its columns
 *  are absent silently skips the real ALTER, and the code crashes later with an
 *  opaque `no such column`. After migrate(), assert every column the drizzle
 *  schema declares actually exists in the DB. Source of truth is `schema.ts`
 *  (the meta snapshots are stale — migrations 0015+ are hand-authored). */
export function assertSchemaIntact(): void {
  const raw = getRawDb();
  const drift: string[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue;
    const tableName = getTableName(value);
    const info = raw.pragma(`table_info("${tableName}")`) as { name: string }[];
    if (info.length === 0) {
      drift.push(`missing table "${tableName}"`);
      continue;
    }
    const actual = new Set(info.map((c) => c.name));
    for (const column of Object.values(getTableColumns(value))) {
      if (!actual.has(column.name)) drift.push(`${tableName}.${column.name}`);
    }
  }
  if (drift.length > 0) {
    throw new Error(
      `DB schema is behind the code — ${drift.length} missing table/column(s): [${drift.join(', ')}]. ` +
        `The migration ledger records migrations as applied whose schema is absent, so runMigrations() skipped them. ` +
        `Repair the DB (apply the missing migrations' ALTERs by hand) or reset it. ` +
        `See docs/project-tracker.md "DB migration ledger drift".`,
    );
  }
}

function seedGlobalSettings(): void {
  const db = getDb();
  const existing = db.select().from(settingsGlobal).limit(1).get();
  if (existing) return;
  db.insert(settingsGlobal)
    .values({
      id: 'global',
      values: defaultGlobalSettings(getDataDir(), homedir()),
      updatedAt: Date.now(),
    })
    .run();
}
