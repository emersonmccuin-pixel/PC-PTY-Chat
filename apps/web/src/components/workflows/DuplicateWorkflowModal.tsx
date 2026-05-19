// 4f.2 / D63 — duplicate workflow modal.
//
// Single input for the new id (defaults to "<original>-copy"; server walks
// "-copy-2", "-copy-3", … on collision if the user leaves it blank). On
// success the modal closes and the parent opens the edit modal pre-populated
// with the new (force-disabled) clone so the user can review + adjust before
// enabling.

import { useState } from 'react';

import { api, type ULID } from '@/api/client';

interface DuplicateWorkflowModalProps {
  projectId: ULID;
  sourceWorkflowId: string;
  /** Closed without duplicating. */
  onClose: () => void;
  /** Successful duplicate; caller refetches + opens edit modal on the new id. */
  onDuplicated: (newId: string) => void;
}

export function DuplicateWorkflowModal({
  projectId,
  sourceWorkflowId,
  onClose,
  onDuplicated,
}: DuplicateWorkflowModalProps) {
  const [newId, setNewId] = useState(`${sourceWorkflowId}-copy`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDuplicate() {
    if (!newId.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const wf = await api.duplicateWorkflow(projectId, sourceWorkflowId, newId.trim());
      onDuplicated(wf.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="flex w-full max-w-md flex-col border border-border bg-card text-sm shadow-xl">
        <header className="border-b border-border bg-muted/30 px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">Duplicate workflow</h2>
          <p className="text-xs text-muted-foreground">
            Cloning <span className="font-mono text-foreground">{sourceWorkflowId}</span>. The new
            workflow will be paused until you enable it.
          </p>
        </header>

        <div className="flex flex-col gap-3 p-4">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">New workflow name</span>
            <input
              type="text"
              value={newId}
              onChange={(e) => setNewId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy && newId.trim()) {
                  e.preventDefault();
                  void handleDuplicate();
                }
              }}
              placeholder={`${sourceWorkflowId}-copy`}
              autoFocus
              className="border border-border bg-background px-2 py-1 font-mono text-sm outline-none focus:border-primary"
            />
            <span className="text-muted-foreground/70">
              Lowercase with dashes. If a name is taken, the server will reject — try another.
            </span>
          </label>

          {error && (
            <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border bg-muted/20 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="border border-border px-3 py-1 text-xs hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleDuplicate()}
            disabled={busy || !newId.trim()}
            className="bg-primary px-3 py-1 text-xs font-medium uppercase tracking-wider text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? 'Duplicating…' : 'Duplicate'}
          </button>
        </footer>
      </div>
    </div>
  );
}
