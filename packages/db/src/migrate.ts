import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { defaultGlobalSettings } from '@pc/domain';
import { getDataDir } from '@pc/utils';
import { getDb } from './connection.ts';
import { settingsGlobal } from './schema.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Apply pending migrations, then ensure the settings_global singleton row exists. */
export function runMigrations(): void {
  const db = getDb();
  migrate(db, { migrationsFolder: join(__dirname, '..', 'drizzle') });
  seedGlobalSettings();
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
