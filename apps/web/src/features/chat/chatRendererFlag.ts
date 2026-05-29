// Feature flag for the JSONL-canonical chat renderer
// (docs/chat-canonical-source-redesign.md). Off by default. While both render
// paths coexist (Stages 2–5) this selects between them so the legacy path stays
// the trustworthy A/B baseline.
//
// Resolution order: localStorage override (live-toggleable in DevControls,
// survives reload) > VITE_CHAT_JSONL_CANONICAL build env > default (false).

const STORAGE_KEY = 'caisson.chat.jsonlCanonical';

function envDefault(): boolean {
  const raw = (import.meta.env as Record<string, string | undefined>).VITE_CHAT_JSONL_CANONICAL;
  return raw === '1' || raw === 'true';
}

/** True when the JSONL-canonical chat renderer should be used. Read at render
 *  time; the localStorage override wins so it can be flipped without a rebuild. */
export function isJsonlCanonicalChat(): boolean {
  try {
    const override = localStorage.getItem(STORAGE_KEY);
    if (override === '1' || override === 'true') return true;
    if (override === '0' || override === 'false') return false;
  } catch {
    // localStorage unavailable (SSR / privacy mode) — fall back to env.
  }
  return envDefault();
}

/** Set or clear the override (null clears, reverting to the env default). */
export function setJsonlCanonicalChatOverride(value: boolean | null): void {
  try {
    if (value === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    // no-op when storage is unavailable
  }
}
