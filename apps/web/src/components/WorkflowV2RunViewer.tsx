// 19.12 — Tactical v2 run viewer modal.
//
// Opens when the user clicks a running v2 workflow card in Activity Panel.
// Renders the workflow's DAG with live `runState` overlay coloring. Replaces
// the v1 WorkflowDrawer's Definition-tab + Runs-tab affordance for v2 runs.
// 19.20 absorbs this into the new Workflows page's detail pane.
//
// Modal dismiss: explicit Close button only — no Escape, no backdrop click.
// Per `feedback_modals_explicit_close_only`.

import { useEffect, useMemo, useState } from 'react';
import type { WorkflowV2 } from '@pc/domain';

import type { V2RunDetail, V2RunStatus } from '@/api/client';
import { api } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';
import { useWorkflowV2RunViewer } from '@/store/workflow-v2-run-viewer';
import { WorkflowGraphV2 } from './WorkflowGraphV2';

interface WorkflowV2RunViewerMountProps {
  projectId: string;
  events: WsEnvelope[];
}

export function WorkflowV2RunViewerMount({
  projectId,
  events,
}: WorkflowV2RunViewerMountProps) {
  const workflowId = useWorkflowV2RunViewer((s) => s.workflowId);
  const runId = useWorkflowV2RunViewer((s) => s.runId);
  const close = useWorkflowV2RunViewer((s) => s.close);

  if (!workflowId || !runId) return null;
  return (
    <WorkflowV2RunViewer
      projectId={projectId}
      workflowId={workflowId}
      runId={runId}
      events={events}
      onClose={close}
    />
  );
}

interface V2RunChangedEnvelope extends WsEnvelope {
  type: 'workflow-v2-run-changed';
  projectId: string;
  runId: string;
  status: V2RunStatus;
  dagState: WorkflowV2.WorkflowDagState;
}

interface WorkflowV2RunViewerProps {
  projectId: string;
  workflowId: string;
  runId: string;
  events: WsEnvelope[];
  onClose: () => void;
}

function WorkflowV2RunViewer({
  projectId,
  workflowId,
  runId,
  events,
  onClose,
}: WorkflowV2RunViewerProps) {
  const [workflow, setWorkflow] = useState<WorkflowV2.Workflow | null>(null);
  const [run, setRun] = useState<V2RunDetail | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // Initial load: parsed def + current run row.
  useEffect(() => {
    let cancelled = false;
    setLoadErr(null);
    void Promise.all([
      api.getV2WorkflowDef(projectId, workflowId),
      api.getV2Run(projectId, runId),
    ])
      .then(([defRes, runRes]) => {
        if (cancelled) return;
        setWorkflow(defRes.workflow as unknown as WorkflowV2.Workflow);
        setRun(runRes.run);
      })
      .catch((e: Error) => {
        if (!cancelled) setLoadErr(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, workflowId, runId]);

  // Live WS merge — every matching envelope replaces dagState + status in-place.
  const liveDag = useMemo<WorkflowV2.WorkflowDagState | null>(() => {
    if (!run) return null;
    let dag = run.dagState as unknown as WorkflowV2.WorkflowDagState;
    let status: V2RunStatus = run.status;
    for (const env of events) {
      if (env?.type !== 'workflow-v2-run-changed') continue;
      const e = env as V2RunChangedEnvelope;
      if (e.projectId !== projectId || e.runId !== runId) continue;
      if (e.dagState) dag = e.dagState;
      if (e.status) status = e.status;
    }
    // Mutate `run.status` indirectly via local pillStatus below — no setRun in
    // the memo to avoid loops. The header reads from a derived value.
    void status;
    return dag;
  }, [events, run, projectId, runId]);

  const pillStatus = useMemo<V2RunStatus | null>(() => {
    if (!run) return null;
    let status: V2RunStatus = run.status;
    for (const env of events) {
      if (env?.type !== 'workflow-v2-run-changed') continue;
      const e = env as V2RunChangedEnvelope;
      if (e.projectId !== projectId || e.runId !== runId) continue;
      if (e.status) status = e.status;
    }
    return status;
  }, [events, run, projectId, runId]);

  return (
    <div
      role="dialog"
      aria-modal
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="flex w-full max-w-5xl flex-col border border-border bg-card text-sm shadow-xl">
        <header className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold uppercase tracking-wide">
                {workflow?.name ?? workflowId}
              </h2>
              <span className="bg-primary/20 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-primary">
                v2
              </span>
              {pillStatus && <StatusPill status={pillStatus} />}
            </div>
            <p className="truncate font-mono text-xs text-muted-foreground">
              run {runId}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="border border-border bg-card px-2 py-1 text-xs uppercase tracking-wider text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close run viewer"
          >
            Close
          </button>
        </header>
        <div className="h-[70vh] overflow-hidden">
          {loadErr ? (
            <div className="p-4 text-xs text-destructive">
              Couldn't load run: {loadErr}
            </div>
          ) : !workflow || !run ? (
            <div className="p-4 text-xs text-muted-foreground">Loading run…</div>
          ) : (
            <WorkflowGraphV2 workflow={workflow} runState={liveDag} />
          )}
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: V2RunStatus }) {
  const cls =
    status === 'running'
      ? 'bg-primary/20 text-primary'
      : status === 'paused'
        ? 'bg-warning/25 text-warning'
        : status === 'completed'
          ? 'bg-foreground/15 text-foreground'
          : status === 'failed'
            ? 'bg-destructive/20 text-destructive'
            : status === 'cancelled'
              ? 'bg-muted text-muted-foreground'
              : 'bg-muted text-muted-foreground';
  return (
    <span className={`px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider ${cls}`}>
      {status}
    </span>
  );
}
