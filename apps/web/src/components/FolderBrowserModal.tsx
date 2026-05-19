// Vendored from emersonmccuin-pixel/project-companion @ 6053ad6 (MIT)
// Source: apps/web/src/components/FolderBrowserModal.tsx
// Adapted for Project Companion: dropped the topCap, hasGit-per-entry badge,
// and inline mkdir (the trunk server's GET /api/fs/browse doesn't expose those
// yet). Last-browsed path persisted via localStorage directly — no
// useLocalStorageState dependency. Path bar is a typed input (D81): user can
// type/paste an absolute path and hit Enter to navigate.

import { useEffect, useState } from 'react';

import { api, type BrowseResult } from '@/api/client';

interface FolderBrowserModalProps {
  initialPath?: string;
  onCancel: () => void;
  onSelect: (absolutePath: string) => void;
}

const LAST_DIR_KEY = 'pc.last-browse-dir';

export function FolderBrowserModal({
  initialPath,
  onCancel,
  onSelect,
}: FolderBrowserModalProps) {
  const [view, setView] = useState<BrowseResult | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const remembered = readLocal(LAST_DIR_KEY);
    void load(initialPath ?? remembered ?? undefined);
    // Mount-only — subsequent nav routes through `load`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  async function load(path?: string) {
    setLoading(true);
    setErr(null);
    try {
      const result = await api.browseFolder(path);
      setView(result);
      setPathInput(result.path);
      writeLocal(LAST_DIR_KEY, result.path);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function submitPath() {
    const trimmed = pathInput.trim();
    if (!trimmed) return;
    if (view && trimmed === view.path) return;
    void load(trimmed);
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40"
      onClick={onCancel}
    >
      <div
        className="flex h-[560px] w-[640px] flex-col border border-border bg-card text-foreground"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold">Choose folder</h2>
          <button
            onClick={onCancel}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs">
          <button
            onClick={() => view?.parent && void load(view.parent)}
            disabled={!view?.parent || loading}
            className="border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-50"
            title="Parent directory"
          >
            ↑
          </button>
          <input
            type="text"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitPath();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setPathInput(view?.path ?? '');
              }
            }}
            onBlur={submitPath}
            spellCheck={false}
            autoComplete="off"
            placeholder="Type or paste an absolute path…"
            aria-label="Folder path"
            className="flex-1 truncate bg-muted px-2 py-1 font-mono text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && <div className="px-4 py-6 text-sm text-muted-foreground">Loading…</div>}
          {err && <div className="px-4 py-6 text-sm text-destructive">{err}</div>}
          {!loading && view && view.entries.length === 0 && (
            <div className="px-4 py-6 text-sm text-muted-foreground">No subdirectories.</div>
          )}
          {!loading && view && view.entries.length > 0 && (
            <ul className="divide-y divide-border">
              {view.entries
                .filter((e) => e.isDirectory)
                .map((entry) => (
                  <li key={entry.path}>
                    <button
                      onClick={() => void load(entry.path)}
                      onDoubleClick={() => onSelect(entry.path)}
                      className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm hover:bg-muted"
                      title={entry.path}
                    >
                      <span aria-hidden className="text-muted-foreground">
                        ▸
                      </span>
                      <span className="truncate">{entry.name}</span>
                      {entry.isHidden && (
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          hidden
                        </span>
                      )}
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-border px-4 py-3">
          <span className="text-xs text-muted-foreground">
            Type a path · click a row to open · double-click to select
          </span>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="border border-border px-3 py-1.5 text-sm hover:bg-muted"
            >
              Cancel
            </button>
            <button
              onClick={() => view && onSelect(view.path)}
              disabled={!view}
              className="bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Select this folder
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage may throw in private mode — non-blocking.
  }
}
