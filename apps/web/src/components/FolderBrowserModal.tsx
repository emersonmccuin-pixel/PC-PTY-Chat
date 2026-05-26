// Vendored from emersonmccuin-pixel/project-companion @ 6053ad6 (MIT)
// Source: apps/web/src/components/FolderBrowserModal.tsx
// Adapted for Caisson: dropped the topCap and hasGit-per-entry badge.
// Last-browsed path persisted via localStorage directly — no
// useLocalStorageState dependency. Path bar is a typed input (D81): user can
// type/paste an absolute path and hit Enter to navigate.

import { useEffect, useState } from 'react';
import { FolderPlus } from 'lucide-react';

import { api, type BrowseResult } from '@/api/client';

interface FolderBrowserModalProps {
  initialPath?: string;
  /** When set, the picker is hard-capped to this root — `↑` stops there
   *  and typed paths outside the root are 403'd by the server. */
  gateRoot?: string;
  onCancel: () => void;
  onSelect: (absolutePath: string) => void;
}

const LAST_DIR_KEY = 'pc.last-browse-dir';

export function FolderBrowserModal({
  initialPath,
  gateRoot,
  onCancel,
  onSelect,
}: FolderBrowserModalProps) {
  const [view, setView] = useState<BrowseResult | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [drives, setDrives] = useState<string[]>([]);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderErr, setNewFolderErr] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);

  useEffect(() => {
    const remembered = readLocal(LAST_DIR_KEY);
    // When the picker is gated, the remembered path may be outside the gate
    // (e.g. it was set by an earlier unrestricted-pick). Prefer initialPath
    // if given, otherwise the gate root, otherwise the remembered path.
    const seed = initialPath ?? (gateRoot ? gateRoot : remembered ?? undefined);
    void load(seed);
    // Mount-only — subsequent nav routes through `load`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drives row appears only in ungated mode (the App Settings picker that
  // sets `projectsFolder` itself — needs cross-drive navigation).
  useEffect(() => {
    if (gateRoot) return;
    let cancelled = false;
    api.listDrives()
      .then((d) => { if (!cancelled) setDrives(d); })
      .catch(() => { /* non-blocking */ });
    return () => { cancelled = true; };
  }, [gateRoot]);

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
    setNewFolderErr(null);
    try {
      const result = await api.browseFolder(path, gateRoot);
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

  async function createFolder() {
    const name = newFolderName.trim();
    if (!view || !name || creatingFolder) return;
    setCreatingFolder(true);
    setNewFolderErr(null);
    try {
      const result = await api.createFolder({
        parentPath: view.path,
        name,
        gateRoot,
      });
      setView(result);
      setPathInput(result.path);
      writeLocal(LAST_DIR_KEY, result.path);
      setNewFolderName('');
      setNewFolderOpen(false);
    } catch (e) {
      setNewFolderErr((e as Error).message);
    } finally {
      setCreatingFolder(false);
    }
  }

  function cancelNewFolder() {
    setNewFolderOpen(false);
    setNewFolderName('');
    setNewFolderErr(null);
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
          <div>
            <h2 className="text-base font-semibold">Choose folder</h2>
            {gateRoot && (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Inside your Projects folder:{' '}
                <code className="bg-muted px-1 font-mono">{gateRoot}</code>
              </p>
            )}
          </div>
          <button
            onClick={onCancel}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        {!gateRoot && drives.length > 1 && (
          <div className="flex items-center gap-1 border-b border-border px-4 py-1.5 text-xs">
            <span className="mr-1 text-muted-foreground">Drives:</span>
            {drives.map((d) => {
              const isActive = view?.path.toLowerCase().startsWith(d.toLowerCase());
              return (
                <button
                  key={d}
                  onClick={() => void load(d)}
                  disabled={loading}
                  className={
                    'border px-2 py-0.5 font-mono hover:bg-muted disabled:opacity-50 ' +
                    (isActive
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border')
                  }
                  title={`Jump to ${d}`}
                >
                  {d.replace(/[\\/]$/, '')}
                </button>
              );
            })}
          </div>
        )}

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
          <button
            type="button"
            onClick={() => {
              setNewFolderOpen((open) => !open);
              setNewFolderErr(null);
            }}
            disabled={!view || loading}
            className="inline-flex items-center gap-1 border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
            title="Add new folder"
          >
            <FolderPlus className="h-3.5 w-3.5" aria-hidden />
            <span>New folder</span>
          </button>
        </div>

        {newFolderOpen && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void createFolder();
            }}
            className="flex flex-col gap-1 border-b border-border px-4 py-2 text-xs"
          >
            <div className="flex items-center gap-2">
              <input
                autoFocus
                type="text"
                value={newFolderName}
                onChange={(e) => {
                  setNewFolderName(e.target.value);
                  setNewFolderErr(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    cancelNewFolder();
                  }
                }}
                disabled={creatingFolder}
                spellCheck={false}
                autoComplete="off"
                placeholder="Folder name"
                aria-label="New folder name"
                className="min-w-0 flex-1 bg-muted px-2 py-1 text-foreground outline-none focus:ring-1 focus:ring-ring"
              />
              <button
                type="submit"
                disabled={!view || !newFolderName.trim() || creatingFolder}
                className="border border-border px-3 py-1 hover:bg-muted disabled:opacity-50"
              >
                {creatingFolder ? 'Creating…' : 'Create'}
              </button>
              <button
                type="button"
                onClick={cancelNewFolder}
                disabled={creatingFolder}
                className="border border-border px-3 py-1 hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
            {newFolderErr && (
              <div className="text-xs text-destructive">{newFolderErr}</div>
            )}
          </form>
        )}

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
