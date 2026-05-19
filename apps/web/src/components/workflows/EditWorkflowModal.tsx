// 4f.2 / D61 — raw-YAML edit modal (PM escape hatch).
//
// The conversational edit path is a separate follow-up (4f.2b — needs
// workflow-creator-prompt updates + a `pc_edit_workflow` MCP tool). For 4f.2
// the PM tab is wired end-to-end: GET the workflow → render YAML in a
// textarea → PUT yamlText on save → server validates + serializes round-trip.
//
// Validation errors render inline at the top with the full `{ path, message }`
// list per D74 supplementary-form-side. Explicit close only per
// `feedback_modals_explicit_close_only` — no Escape, no backdrop click.

import { useEffect, useRef, useState } from 'react';

import {
  api,
  WorkflowInFlightRunsError as _WIFE,
  WorkflowValidationError,
  type ULID,
} from '@/api/client';
import { useWorkflowDrawer } from '@/store/workflow-drawer';

// silence ts unused — kept for symmetry with the other lifecycle errors
void _WIFE;

interface EditWorkflowModalProps {
  projectId: ULID;
  workflowId: string;
  /** Closed without a save. Caller decides what to refetch. */
  onClose: () => void;
  /** Saved successfully. Caller refetches the list. */
  onSaved: () => void;
}

export function EditWorkflowModal({ projectId, workflowId, onClose, onSaved }: EditWorkflowModalProps) {
  const [yamlText, setYamlText] = useState<string>('');
  const [originalYaml, setOriginalYaml] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ path: string; message: string }[]>([]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Carry workflow's disabled state into the drawer header live — when the user
  // disables/enables from within the edit modal (by flipping disabled in the
  // YAML), the drawer's banner reflects it. The WS broadcast handles other
  // surfaces automatically.
  void useWorkflowDrawer;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadErr(null);
    api
      .getWorkflow(projectId, workflowId)
      .then((r) => {
        if (cancelled) return;
        setYamlText(r.yamlText);
        setOriginalYaml(r.yamlText);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setLoadErr((e as Error).message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, workflowId]);

  async function handleSave() {
    setSaving(true);
    setSaveErr(null);
    setFieldErrors([]);
    try {
      await api.editWorkflow(projectId, workflowId, { yamlText });
      onSaved();
    } catch (e) {
      if (e instanceof WorkflowValidationError) {
        setFieldErrors(e.errors);
        setSaveErr(e.message);
      } else {
        setSaveErr((e as Error).message);
      }
    } finally {
      setSaving(false);
    }
  }

  const dirty = yamlText !== originalYaml;
  const canSave = dirty && !saving && !loading;

  return (
    <div
      role="dialog"
      aria-modal
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="flex h-[85vh] w-full max-w-4xl flex-col border border-border bg-card text-sm shadow-xl">
        <header className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold uppercase tracking-wide">
              Edit workflow
            </h2>
            <p className="truncate text-xs text-muted-foreground">
              {workflowId} — raw YAML. Save validates the same way as a fresh workflow.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => closeRef.current()}
              className="border border-border px-2 py-1 text-xs hover:bg-muted"
            >
              {dirty ? 'Discard changes' : 'Close'}
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!canSave}
              className="bg-primary px-3 py-1 text-xs font-medium uppercase tracking-wider text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </header>

        {(saveErr || fieldErrors.length > 0) && (
          <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive">
            <div className="font-medium">{saveErr ?? 'Invalid workflow'}</div>
            {fieldErrors.length > 0 && (
              <ul className="mt-1 list-disc pl-5 font-mono">
                {fieldErrors.map((e, i) => (
                  <li key={i}>
                    <span className="text-foreground/80">{e.path}</span>: {e.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {loadErr && (
          <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive">
            Failed to load workflow: {loadErr}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-hidden">
          {loading ? (
            <div className="flex h-full items-center justify-center text-xs italic text-muted-foreground">
              Loading…
            </div>
          ) : (
            <textarea
              value={yamlText}
              onChange={(e) => setYamlText(e.target.value)}
              spellCheck={false}
              className="h-full w-full resize-none border-0 bg-background p-4 font-mono text-xs leading-relaxed outline-none focus:bg-background"
            />
          )}
        </div>
      </div>
    </div>
  );
}
