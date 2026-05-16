import { eq } from 'drizzle-orm';
import type { GlobalSettings } from '@pc/domain';
import { getDb } from '../connection.ts';
import { settingsGlobal } from '../schema.ts';

interface SettingsRow {
  id: string;
  values: GlobalSettings;
  updatedAt: number;
}

export function getGlobalSettings(): GlobalSettings | null {
  const row = getDb()
    .select()
    .from(settingsGlobal)
    .where(eq(settingsGlobal.id, 'global'))
    .get() as SettingsRow | undefined;
  return row?.values ?? null;
}

export function setGlobalSettings(values: GlobalSettings): void {
  getDb()
    .update(settingsGlobal)
    .set({ values, updatedAt: Date.now() })
    .where(eq(settingsGlobal.id, 'global'))
    .run();
}
