// 4f.3 / D64 — Run-now modal.
//
// Layout adapts to the workflow's Work Contract (`attached_to_work_item`):
//   required  → card picker; submit disabled until a card is picked.
//   optional  → card picker + "Run standalone (no card)" toggle. Default
//               depends on whether the workflow declares a `workItemId` input
//               (declared → card mode; not declared → standalone mode).
//   forbidden → no card UI; one-click Run.
//
// Additional declared `inputs:` keys (anything other than the natural-context
// keys workItemId / stageId) render as labeled text fields. The runtime fills
// natural context for declared keys; explicit user inputs layer on top.
//
// Explicit close only ([[modals-explicit-close-only]]) — no backdrop / Escape
// dismissal. Errors render verbatim from the server's plain-English message
// ([[plain-english-decisions]] + D74 translation surface).

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  api,
  WorkflowFireError,
  type AttachedToWorkItem,
  type Project,
  type WorkItem,
  type Workflow,
} from '@/api/client';

interface RunNowModalProps {
  project: Project;
  workflowId: string;
  /** Closed without firing. */
  onClose: () => void;
  /** Fire succeeded; caller closes + opens drawer to the new run's detail. */
  onFired: (runId: string) => void;
}

const NATURAL_INPUT_KEYS = new Set(['workItemId', 'stageId']);

export function RunNowModal({ project, workflowId, onClose, onFired }: RunNowModalProps) {
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [pickedWorkItemId, setPickedWorkItemId] = useState<string>('');
  const [runStandalone, setRunStandalone] = useState(false);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [fireError, setFireError] = useState<string | null>(null);
  /** 4f.4 / D71. Declared-but-unsupplied input keys from the server's
   *  structured 400 response. The modal highlights each named field. */
  const [missingInputKeys, setMissingInputKeys] = useState<Set<string>>(() => new Set());

  // Initial load: workflow def + project work items.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [wfRes, items] = await Promise.all([
          api.getWorkflow(project.id, workflowId),
          api.workItems(project.id),
        ]);
        if (cancelled) return;
        setWorkflow(wfRes.workflow);
        // Active cards only — archived ones don't make sense to fire on.
        setWorkItems(items.filter((wi) => wi.deletedAt === null));
        // Default standalone-mode toggle for `optional` contract: ON iff the
        // workflow doesn't declare `workItemId` in its inputs (i.e. there's
        // no natural-context fill that needs a card).
        const declaresWorkItem =
          wfRes.workflow.inputs && 'workItemId' in wfRes.workflow.inputs;
        setRunStandalone(!declaresWorkItem);
      } catch (e) {
        if (!cancelled) setLoadError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project.id, workflowId]);

  const attached: AttachedToWorkItem = workflow?.attached_to_work_item ?? 'optional';

  // Extra inputs to expose as text fields: anything declared in `inputs:`
  // that isn't natural-context (workItemId / stageId).
  const extraInputKeys = useMemo(() => {
    if (!workflow?.inputs) return [];
    return Object.keys(workflow.inputs).filter((k) => !NATURAL_INPUT_KEYS.has(k));
  }, [workflow]);

  // Stage lookup for the card-picker grouping.
  const stageById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of project.stages) m.set(s.id, s.name);
    return m;
  }, [project.stages]);

  const cardsByStage = useMemo(() => {
    const groups = new Map<string, WorkItem[]>();
    for (const stage of project.stages) groups.set(stage.id, []);
    for (const wi of workItems) {
      const bucket = groups.get(wi.stageId);
      if (bucket) bucket.push(wi);
      else groups.set(wi.stageId, [wi]); // orphans
    }
    return groups;
  }, [project.stages, workItems]);

  const willAttachCard =
    attached === 'required' || (attached === 'optional' && !runStandalone);

  const canSubmit = useMemo(() => {
    if (!workflow || busy) return false;
    if (willAttachCard && !pickedWorkItemId) return false;
    // 4f.4 / D71. Every declared extra-input is required at fire-time —
    // block submit when any field is empty so the user gets the hint up
    // front instead of bouncing off a 400 round-trip.
    for (const key of extraInputKeys) {
      const v = inputValues[key];
      if (v === undefined || v.trim() === '') return false;
    }
    return true;
  }, [workflow, busy, willAttachCard, pickedWorkItemId, extraInputKeys, inputValues]);

  const handleFire = useCallback(async () => {
    if (!workflow) return;
    setBusy(true);
    setFireError(null);
    setMissingInputKeys(new Set());
    try {
      const inputs: Record<string, unknown> = {};
      for (const key of extraInputKeys) {
        const v = inputValues[key];
        if (v !== undefined && v !== '') inputs[key] = v;
      }
      const body: { workItemId?: string; inputs?: Record<string, unknown> } = {};
      if (willAttachCard && pickedWorkItemId) body.workItemId = pickedWorkItemId;
      if (Object.keys(inputs).length > 0) body.inputs = inputs;
      const runId = await api.fireWorkflow(project.id, workflow.id, body);
      onFired(runId);
    } catch (e) {
      if (e instanceof WorkflowFireError) {
        setFireError(e.message);
        if (e.missing && e.missing.length > 0) {
          setMissingInputKeys(new Set(e.missing));
        }
      } else {
        setFireError(`${(e as Error).message ?? 'fire failed'}`);
      }
    } finally {
      setBusy(false);
    }
  }, [
    workflow,
    extraInputKeys,
    inputValues,
    willAttachCard,
    pickedWorkItemId,
    project.id,
    onFired,
  ]);

  return (
    <div
      role="dialog"
      aria-modal
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="flex w-full max-w-lg flex-col border border-border bg-card text-sm shadow-xl">
        <header className="border-b border-border bg-muted/30 px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">Run workflow</h2>
          <p className="font-mono text-xs text-muted-foreground">{workflowId}</p>
          {workflow?.description && (
            <p className="mt-1 text-xs text-foreground">{workflow.description}</p>
          )}
        </header>

        <div className="flex flex-col gap-4 p-4">
          {loadError && (
            <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              Couldn't load workflow: {loadError}
            </div>
          )}

          {workflow && (
            <>
              {/* Work Contract surface */}
              {attached === 'required' && (
                <CardPickerBlock
                  label="Run this workflow on which card?"
                  hint="This workflow needs a card to run."
                  required
                  pickedId={pickedWorkItemId}
                  onPick={setPickedWorkItemId}
                  stageById={stageById}
                  stagesOrder={project.stages.map((s) => s.id)}
                  cardsByStage={cardsByStage}
                />
              )}
              {attached === 'optional' && (
                <div className="flex flex-col gap-2">
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={runStandalone}
                      onChange={(e) => setRunStandalone(e.target.checked)}
                      className="h-3.5 w-3.5"
                    />
                    <span>Run standalone (no card)</span>
                  </label>
                  {!runStandalone && (
                    <CardPickerBlock
                      label="Run this workflow on which card?"
                      pickedId={pickedWorkItemId}
                      onPick={setPickedWorkItemId}
                      stageById={stageById}
                      stagesOrder={project.stages.map((s) => s.id)}
                      cardsByStage={cardsByStage}
                    />
                  )}
                </div>
              )}
              {attached === 'forbidden' && (
                <p className="text-xs text-muted-foreground">
                  This workflow doesn't run on a card.
                </p>
              )}

              {/* Additional declared inputs (anything beyond workItemId / stageId) */}
              {extraInputKeys.length > 0 && (
                <div className="flex flex-col gap-2 border-t border-border pt-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Workflow inputs
                  </h3>
                  {extraInputKeys.map((key) => {
                    const isMissing = missingInputKeys.has(key);
                    return (
                      <label key={key} className="flex flex-col gap-1 text-xs">
                        <span className="text-muted-foreground">
                          <span className="font-mono text-foreground">{key}</span>
                          <span className="ml-1 text-destructive">*</span>
                          <span className="ml-2 text-muted-foreground/70">
                            {workflow.inputs?.[key]}
                          </span>
                        </span>
                        <input
                          type="text"
                          value={inputValues[key] ?? ''}
                          onChange={(e) => {
                            const next = e.target.value;
                            setInputValues((prev) => ({ ...prev, [key]: next }));
                            if (isMissing) {
                              setMissingInputKeys((prev) => {
                                const out = new Set(prev);
                                out.delete(key);
                                return out;
                              });
                            }
                          }}
                          className={
                            isMissing
                              ? 'border border-destructive bg-background px-2 py-1 outline-none focus:border-destructive'
                              : 'border border-border bg-background px-2 py-1 outline-none focus:border-primary'
                          }
                        />
                      </label>
                    );
                  })}
                </div>
              )}

              {fireError && (
                <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {fireError}
                </div>
              )}
            </>
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
            onClick={() => void handleFire()}
            disabled={!canSubmit}
            className="bg-primary px-3 py-1 text-xs font-medium uppercase tracking-wider text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? 'Starting…' : 'Run'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function CardPickerBlock({
  label,
  hint,
  required,
  pickedId,
  onPick,
  stageById,
  stagesOrder,
  cardsByStage,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  pickedId: string;
  onPick: (id: string) => void;
  stageById: Map<string, string>;
  stagesOrder: string[];
  cardsByStage: Map<string, WorkItem[]>;
}) {
  const totalCards = useMemo(() => {
    let n = 0;
    for (const list of cardsByStage.values()) n += list.length;
    return n;
  }, [cardsByStage]);

  if (totalCards === 0) {
    return (
      <div className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <p className="border border-dashed border-border px-3 py-2 text-muted-foreground">
          No cards in this project yet. Create one first, then come back.
        </p>
      </div>
    );
  }

  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
      </span>
      {hint && <span className="text-muted-foreground/70">{hint}</span>}
      <select
        value={pickedId}
        onChange={(e) => onPick(e.target.value)}
        className="border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary"
      >
        <option value="">— pick a card —</option>
        {stagesOrder.map((stageId) => {
          const cards = cardsByStage.get(stageId) ?? [];
          if (cards.length === 0) return null;
          return (
            <optgroup key={stageId} label={stageById.get(stageId) ?? stageId}>
              {cards.map((wi) => (
                <option key={wi.id} value={wi.id}>
                  {wi.title || '(untitled)'}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
    </label>
  );
}
