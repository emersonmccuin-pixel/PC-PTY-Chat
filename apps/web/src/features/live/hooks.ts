export const PROJECT_CHANGED_CURSOR_STORAGE_KEY = 'pc.live.projectChanged.cursor';

export interface CursorStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readStoredProjectChangedCursor(
  storage: CursorStorageLike | null = browserStorage(),
): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(PROJECT_CHANGED_CURSOR_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeStoredProjectChangedCursor(
  cursor: string | null,
  storage: CursorStorageLike | null = browserStorage(),
): void {
  if (!cursor || !storage) return;
  try {
    storage.setItem(PROJECT_CHANGED_CURSOR_STORAGE_KEY, cursor);
  } catch {
    /* best-effort */
  }
}

function browserStorage(): CursorStorageLike | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}
