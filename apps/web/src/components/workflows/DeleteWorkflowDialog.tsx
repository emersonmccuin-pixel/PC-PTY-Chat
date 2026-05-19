// 4f.2 / D60 — delete workflow confirm dialog.
//
// Two-stage: regular confirm first; if the server returns 409 with an
// in-flight-runs list, swap to a "cancel <N> runs and delete" confirm with
// the count surfaced. Per [[modals-explicit-close-only]] this dialog has no
// Escape / backdrop dismissal — Cancel button only.

import { useState } from 'react';

import {
  api,
  WorkflowInFlightRunsError,
  type ULID,
} from '@/api/client';

interface DeleteWorkflowDialogProps {
  projectId: ULID;
  workflowId: string;
  onClose: () => void;
  onDeleted: () => void;
}

export function DeleteWorkflowDialog({
  projectId,
  workflowId,
  onClose,
  onDeleted,
}: DeleteWorkflowDialogProps) {
  const [busy, setBusy] = useState(false);
  const [inFlightRunIds, setInFlightRunIds] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteWorkflow(projectId, workflowId);
      onDeleted();
    } catch (e) {
      if (e instanceof WorkflowInFlightRunsError) {
        setInFlightRunIds(e.inFlightRunIds);
      } else {
        setError((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelAndDelete() {
    setBusy(true);
    setError(null);
    try {
      await api.cancelRunsAndDeleteWorkflow(projectId, workflowId, 'workflow deleted');
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const inFlight = inFlightRunIds ?? [];
  const askCancelAndDelete = inFlight.length > 0;

  return (
    <div
      role="dialog"
      aria-modal
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="flex w-full max-w-md flex-col border border-border bg-card text-sm shadow-xl">
        <header className="border-b border-border bg-muted/30 px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            {askCancelAndDelete ? 'Cancel runs and delete?' : 'Delete workflow?'}
          </h2>
        </header>

        <div className="flex flex-col gap-3 p-4 text-sm">
          {askCancelAndDelete ? (
            <>
              <p>
                <span className="font-mono">{workflowId}</span> has{' '}
                <strong>
                  {inFlight.length} run{inFlight.length === 1 ? '' : 's'}
                </strong>{' '}
                still in flight. To delete it now, cancel the in-flight runs first.
              </p>
              <p className="text-xs text-muted-foreground">
                Cancelled runs stay in history with a "workflow deleted" reason. Subagent
                processes for each run will be killed.
              </p>
            </>
          ) : (
            <>
              <p>
                Delete <span className="font-mono">{workflowId}</span>?
              </p>
              <p className="text-xs text-muted-foreground">
                The YAML file is removed from disk. Historical run rows stay accessible by
                runId, but the workflow disappears from this list.
              </p>
            </>
          )}

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
            onClick={() =>
              askCancelAndDelete ? void handleCancelAndDelete() : void handleDelete()
            }
            disabled={busy}
            className="bg-destructive px-3 py-1 text-xs font-medium uppercase tracking-wider text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
          >
            {busy
              ? 'Working…'
              : askCancelAndDelete
                ? `Cancel ${inFlight.length} run${inFlight.length === 1 ? '' : 's'} and delete`
                : 'Delete'}
          </button>
        </footer>
      </div>
    </div>
  );
}
