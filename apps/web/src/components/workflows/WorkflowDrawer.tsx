// 4e.4–4e.7 — Per-workflow run-history drawer (D51).
//
// Slide-in from right, overlays the kanban/workflows tab. Single-level
// navigation inside the body: Runs list ↔ Run detail (replace-content per
// D51). Workflow header stays pinned above so the user knows what they're
// inside. Explicit-close-only per `feedback_modals_explicit_close_only` —
// header X button, no backdrop-click / Escape dismissal.
//
// Tabs: Definition (the existing read-only WorkflowGraph from 4b) and Runs
// (this section's new surface). When `runId` is set in the store, the Runs
// tab body swaps to a run-detail view with a `← back to runs` arrow.
//
// WS subscription: drawer consumes the per-project `events` stream the
// parent already maintains and filters for `workflow-run-changed` envelopes
// matching its workflowId. Both in-flight tick + retry-from lineage append
// flow through this stream.

import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, type Workflow, type WorkflowRun, type NodeOutput } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';
import { useWorkflowDrawer } from '@/store/workflow-drawer';
import { WorkflowGraph } from '../WorkflowGraph';

interface WorkflowDrawerProps {
  projectId: string;
  events: WsEnvelope[];
}

type TabId = 'definition' | 'runs';

const TABS: { id: TabId; label: string }[] = [
  { id: 'definition', label: 'Definition' },
  { id: 'runs', label: 'Runs' },
];

export function WorkflowDrawer({ projectId, events }: WorkflowDrawerProps) {
  const workflowId = useWorkflowDrawer((s) => s.workflowId);
  const runId = useWorkflowDrawer((s) => s.runId);
  const close = useWorkflowDrawer((s) => s.close);
  const backToRuns = useWorkflowDrawer((s) => s.backToRuns);

  const [tab, setTab] = useState<TabId>('runs');
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [wfErr, setWfErr] = useState<string | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [runsErr, setRunsErr] = useState<string | null>(null);

  // Reset to Runs tab when the drawer opens for a fresh workflow.
  useEffect(() => {
    if (workflowId) setTab('runs');
  }, [workflowId]);

  // Load workflow def + run list when a workflowId is set. Cancelable via
  // the closed flag so a quick close+reopen doesn't race the response onto
  // the wrong workflow's drawer state.
  useEffect(() => {
    if (!workflowId) {
      setWorkflow(null);
      setWfErr(null);
      setRuns([]);
      setRunsErr(null);
      return;
    }
    let cancelled = false;
    setWfErr(null);
    setRunsErr(null);
    api
      .getWorkflow(projectId, workflowId)
      .then((r) => {
        if (cancelled) return;
        setWorkflow(r.workflow);
      })
      .catch((e: unknown) => {
        if (!cancelled) setWfErr((e as Error).message);
      });
    api
      .listWorkflowRuns(projectId)
      .then((all) => {
        if (cancelled) return;
        setRuns(all.filter((r) => r.workflowId === workflowId));
      })
      .catch((e: unknown) => {
        if (!cancelled) setRunsErr((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, workflowId]);

  // Merge incoming `workflow-run-changed` envelopes for this workflow. The
  // envelope shape only carries status + nodeOutputs, so for unseen runs we
  // do a one-shot fetch for the full record; for known runs we patch in
  // place. Filter at consumption time — we don't subscribe per envelope.
  useEffect(() => {
    if (!workflowId) return;
    let cancelled = false;
    const seen = new Set<string>();
    for (const env of events) {
      if (env.type !== 'workflow-run-changed') continue;
      const e = env as { workflowId?: string; runId?: string; status?: string; nodeOutputs?: Record<string, NodeOutput> };
      if (e.workflowId !== workflowId || !e.runId) continue;
      seen.add(e.runId);
      setRuns((prev) => {
        const i = prev.findIndex((r) => r.id === e.runId);
        if (i === -1) return prev; // refetch below
        const next = [...prev];
        next[i] = {
          ...next[i]!,
          status: (e.status as WorkflowRun['status']) ?? next[i]!.status,
          nodeOutputs: e.nodeOutputs ?? next[i]!.nodeOutputs,
        };
        return next;
      });
    }
    // Refetch any envelope's run that wasn't in our snapshot (new run row,
    // e.g. created by retry-from while the drawer is open).
    if (seen.size === 0) return;
    const unknownIds: string[] = [];
    setRuns((prev) => {
      const known = new Set(prev.map((r) => r.id));
      for (const id of seen) if (!known.has(id)) unknownIds.push(id);
      return prev;
    });
    for (const id of unknownIds) {
      void api
        .getWorkflowRun(projectId, id)
        .then((run) => {
          if (cancelled) return;
          if (run.workflowId !== workflowId) return;
          setRuns((prev) => (prev.some((r) => r.id === run.id) ? prev : [...prev, run]));
        })
        .catch(() => {
          /* best-effort; drawer surfaces no explicit error for missing live tick */
        });
    }
    return () => {
      cancelled = true;
    };
  }, [events, projectId, workflowId]);

  // Latest version of the inspected run pulled from `runs` (so live WS
  // patches flow through without RunDetail tracking its own subscription).
  const inspectedRun = useMemo(() => {
    if (!runId) return null;
    return runs.find((r) => r.id === runId) ?? null;
  }, [runs, runId]);

  if (!workflowId) return null;

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal aria-label="Workflow runs">
      <div className="flex-1 bg-black/40" aria-hidden="true" />
      <aside className="flex h-full w-full max-w-3xl flex-col border-l border-border bg-card shadow-2xl">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Workflow
            </div>
            <div className="truncate text-sm font-semibold text-foreground">{workflowId}</div>
            {workflow && (
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {triggerHintFromWorkflow(workflow)}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close drawer"
            className="shrink-0 border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-muted"
          >
            ✕ Close
          </button>
        </header>

        <nav className="flex shrink-0 gap-1 border-b border-border bg-background px-2 pt-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={
                'border border-b-0 px-3 py-1.5 text-xs font-medium uppercase tracking-wider ' +
                (tab === t.id
                  ? 'border-border bg-card text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground')
              }
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === 'definition' ? (
            <DefinitionBody workflow={workflow} error={wfErr} />
          ) : runId ? (
            <RunDetailBody
              projectId={projectId}
              run={inspectedRun}
              runIdFallback={runId}
              workflow={workflow}
              onBack={backToRuns}
            />
          ) : (
            <RunsBody
              workflow={workflow}
              runs={runs}
              error={runsErr}
            />
          )}
        </div>
      </aside>
    </div>
  );
}

function triggerHintFromWorkflow(wf: Workflow): string {
  const parts: string[] = [];
  if (wf.triggers?.on_enter?.stage_id) parts.push(`on_enter: ${wf.triggers.on_enter.stage_id}`);
  if (wf.triggers?.callable) parts.push('callable');
  if (parts.length === 0) parts.push('no triggers');
  return `Triggers: ${parts.join(' · ')}`;
}

// ── Definition tab ─────────────────────────────────────────────────────────

function DefinitionBody({ workflow, error }: { workflow: Workflow | null; error: string | null }) {
  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (!workflow) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-xs italic text-muted-foreground">
        Loading workflow…
      </div>
    );
  }
  return (
    <div className="h-full w-full">
      <WorkflowGraph workflow={workflow} />
    </div>
  );
}

// ── Runs tab (list) ────────────────────────────────────────────────────────

const STATUS_GROUPS: { key: WorkflowRun['status']; label: string }[] = [
  { key: 'in-progress', label: 'Running' },
  { key: 'paused', label: 'Paused' },
  { key: 'failed', label: 'Failed' },
  { key: 'complete', label: 'Complete' },
  { key: 'cancelled', label: 'Cancelled' },
];

const STATUS_PILL: Record<WorkflowRun['status'], { bg: string; glyph: string; label: string }> = {
  pending: { bg: 'bg-muted text-muted-foreground', glyph: '◯', label: 'pending' },
  'in-progress': { bg: 'bg-warning text-background', glyph: '◐', label: 'running' },
  paused: { bg: 'bg-info text-background', glyph: '⏸', label: 'paused' },
  complete: { bg: 'bg-success text-background', glyph: '✓', label: 'complete' },
  failed: { bg: 'bg-destructive text-destructive-foreground', glyph: '✕', label: 'failed' },
  cancelled: { bg: 'bg-muted text-muted-foreground', glyph: '⊘', label: 'cancelled' },
};

function RunsBody({
  workflow,
  runs,
  error,
}: {
  workflow: Workflow | null;
  runs: WorkflowRun[];
  error: string | null;
}) {
  const openRun = useWorkflowDrawer((s) => s.openRun);
  const [statusFilter, setStatusFilter] = useState<Set<WorkflowRun['status']>>(
    () => new Set(STATUS_GROUPS.map((g) => g.key)),
  );
  const [cardFilter, setCardFilter] = useState<string>('__all'); // __all | __standalone | <workItemId>

  const cardOptions = useMemo(() => {
    const seen = new Map<string, number>();
    for (const r of runs) {
      if (!r.workItemId) continue;
      seen.set(r.workItemId, (seen.get(r.workItemId) ?? 0) + 1);
    }
    return [...seen.entries()].map(([id, count]) => ({ id, count }));
  }, [runs]);

  const filtered = useMemo(() => {
    return runs
      .filter((r) => statusFilter.has(r.status))
      .filter((r) => {
        if (cardFilter === '__all') return true;
        if (cardFilter === '__standalone') return !r.workItemId;
        return r.workItemId === cardFilter;
      })
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }, [runs, statusFilter, cardFilter]);

  const toggleStatus = useCallback((s: WorkflowRun['status']) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-2 border-b border-border bg-muted/20 px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Status:
          </span>
          {STATUS_GROUPS.map((g) => {
            const on = statusFilter.has(g.key);
            const pill = STATUS_PILL[g.key];
            return (
              <button
                key={g.key}
                type="button"
                onClick={() => toggleStatus(g.key)}
                aria-pressed={on}
                className={
                  'inline-flex items-center gap-1 border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ' +
                  (on
                    ? `${pill.bg} border-transparent`
                    : 'border-border bg-card text-muted-foreground hover:bg-muted')
                }
              >
                <span aria-hidden="true">{pill.glyph}</span>
                {g.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Card:
          </span>
          <select
            value={cardFilter}
            onChange={(e) => setCardFilter(e.target.value)}
            className="border border-border bg-background px-2 py-0.5 text-xs"
          >
            <option value="__all">All cards</option>
            <option value="__standalone">Standalone only</option>
            {cardOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.id.slice(-8)} ({o.count})
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <EmptyRunsHint workflow={workflow} hasRuns={runs.length > 0} />
        ) : (
          <ul className="flex flex-col">
            {filtered.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => openRun(r.id)}
                  className="flex w-full items-start justify-between gap-3 border-b border-border bg-card px-3 py-2 text-left text-xs hover:bg-muted"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {r.id.slice(-12)}
                      </span>
                      <TriggerPill trigger={r.trigger} />
                      <CardPill run={r} />
                      {r.parentRunId && (
                        <span className="bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                          nested
                        </span>
                      )}
                      {isReFired(r) && (
                        <span className="bg-info px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-background">
                          ↻ re-fired
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {formatRunWhen(r)}
                    </div>
                    {r.lastReason && (
                      <div className="mt-1 break-words text-[11px] text-foreground">
                        {r.lastReason}
                      </div>
                    )}
                  </div>
                  <StatusPill status={r.status} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EmptyRunsHint({ workflow, hasRuns }: { workflow: Workflow | null; hasRuns: boolean }) {
  if (hasRuns) {
    return (
      <div className="p-6 text-center text-xs italic text-muted-foreground">
        No runs match the current filters.
      </div>
    );
  }
  const hint = workflow ? triggerHintFromWorkflow(workflow) : null;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <div className="text-sm text-muted-foreground">No runs yet. This workflow hasn't fired.</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function StatusPill({ status }: { status: WorkflowRun['status'] }) {
  const pill = STATUS_PILL[status];
  return (
    <span
      className={
        'inline-flex shrink-0 items-center gap-1 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ' +
        pill.bg
      }
    >
      <span aria-hidden="true">{pill.glyph}</span>
      {pill.label}
    </span>
  );
}

function TriggerPill({ trigger }: { trigger?: string }) {
  if (!trigger) return null;
  return (
    <span className="bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
      {trigger}
    </span>
  );
}

function CardPill({ run }: { run: WorkflowRun }) {
  if (!run.workItemId) {
    return (
      <span className="bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        ↪ standalone
      </span>
    );
  }
  return (
    <span className="bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      ↪ {run.workItemId.slice(-8)}
    </span>
  );
}

function isReFired(r: WorkflowRun): boolean {
  return Boolean((r.metadata as { reFiredFromRunId?: string } | undefined)?.reFiredFromRunId);
}

function formatRunWhen(r: WorkflowRun): string {
  const start = Date.parse(r.startedAt);
  const end = r.completedAt ? Date.parse(r.completedAt) : null;
  const startStr = Number.isFinite(start) ? new Date(start).toLocaleString() : r.startedAt;
  if (end == null || !Number.isFinite(end)) return startStr;
  return `${startStr} · ${formatDuration(end - start)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  if (m < 60) return rem === 0 ? `${m}m` : `${m}m${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m - h * 60}m`;
}

// ── Run detail body ────────────────────────────────────────────────────────

function RunDetailBody({
  projectId,
  run,
  runIdFallback,
  workflow,
  onBack,
}: {
  projectId: string;
  run: WorkflowRun | null;
  runIdFallback: string;
  workflow: Workflow | null;
  onBack: () => void;
}) {
  const [hydrated, setHydrated] = useState<WorkflowRun | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Always fetch the detail endpoint once — the listed run carries the same
  // fields today but the detail endpoint is the stable cache key (per the
  // 4e.1 doc comment) and lets us pick up a missing-from-snapshot run cold.
  useEffect(() => {
    let cancelled = false;
    setHydrated(null);
    setErr(null);
    api
      .getWorkflowRun(projectId, runIdFallback)
      .then((r) => {
        if (cancelled) return;
        setHydrated(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, runIdFallback]);

  const effective = run ?? hydrated;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/20 px-3 py-2 text-xs">
        <button
          type="button"
          onClick={onBack}
          className="border border-border bg-card px-2 py-1 text-xs hover:bg-muted"
        >
          ← Back to runs
        </button>
        <span className="font-mono text-[10px] text-muted-foreground">
          {runIdFallback.slice(-12)}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {err && (
          <div className="m-3 border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {err}
          </div>
        )}
        {effective ? (
          <RunDetailContent run={effective} workflow={workflow} projectId={projectId} />
        ) : !err ? (
          <div className="p-6 text-center text-xs italic text-muted-foreground">Loading run…</div>
        ) : null}
      </div>
    </div>
  );
}

function RunDetailContent({
  run,
  workflow,
  projectId,
}: {
  run: WorkflowRun;
  workflow: Workflow | null;
  projectId: string;
}) {
  const openRun = useWorkflowDrawer((s) => s.openRun);
  const reFired = (run.metadata as { reFiredFromRunId?: string; reFiredFromNodeId?: string } | undefined);
  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      <section className="border border-border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={run.status} />
          <TriggerPill trigger={run.trigger} />
          <CardPill run={run} />
          {run.parentRunId && (
            <button
              type="button"
              onClick={() => openRun(run.parentRunId!)}
              className="bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-muted/70"
              title={`Open parent run ${run.parentRunId}`}
            >
              ↳ from {run.parentNodeId ?? 'parent'}
            </button>
          )}
        </div>
        <div className="mt-2 text-[11px] text-muted-foreground">{formatRunWhen(run)}</div>
        {reFired?.reFiredFromRunId && (
          <div className="mt-1 text-[11px]">
            <span className="text-muted-foreground">↻ re-fired from </span>
            <button
              type="button"
              onClick={() => openRun(reFired.reFiredFromRunId!)}
              className="font-mono text-foreground underline hover:no-underline"
            >
              {reFired.reFiredFromRunId.slice(-8)}
            </button>
            {reFired.reFiredFromNodeId && (
              <span className="text-muted-foreground">
                {' '}· resumed at <span className="font-mono text-foreground">{reFired.reFiredFromNodeId}</span>
              </span>
            )}
          </div>
        )}
        {run.lastReason && (
          <div className="mt-2 break-words text-[11px] text-foreground">{run.lastReason}</div>
        )}
      </section>

      {(run.inputs && Object.keys(run.inputs).length > 0) || (run.outputs && Object.keys(run.outputs).length > 0) ? (
        <section className="border border-border bg-card p-3">
          {run.inputs && Object.keys(run.inputs).length > 0 && (
            <KeyValueBlock label="Inputs" value={run.inputs} />
          )}
          {run.outputs && Object.keys(run.outputs).length > 0 && (
            <KeyValueBlock label="Outputs" value={run.outputs} />
          )}
        </section>
      ) : null}

      <StepList run={run} workflow={workflow} projectId={projectId} />
    </div>
  );
}

function KeyValueBlock({ label, value }: { label: string; value: Record<string, unknown> }) {
  return (
    <div className="mt-1 first:mt-0">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <pre className="whitespace-pre-wrap break-all border border-border bg-background/60 p-2 font-mono text-[11px] text-foreground">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

// ── Step list + per-kind renderers ─────────────────────────────────────────

function StepList({
  run,
  workflow,
  projectId,
}: {
  run: WorkflowRun;
  workflow: Workflow | null;
  projectId: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const ordered = useMemo(() => orderedSteps(run, workflow), [run, workflow]);

  if (ordered.length === 0) {
    return (
      <section className="border border-border bg-card p-3 text-xs italic text-muted-foreground">
        No steps recorded for this run.
      </section>
    );
  }

  return (
    <section className="flex flex-col">
      {ordered.map((step) => {
        const isOpen = expanded.has(step.id);
        return (
          <StepRow
            key={step.id}
            step={step}
            isOpen={isOpen}
            onToggle={() =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(step.id)) next.delete(step.id);
                else next.add(step.id);
                return next;
              })
            }
            run={run}
            projectId={projectId}
          />
        );
      })}
    </section>
  );
}

interface OrderedStep {
  id: string;
  kind: string | null;
  output: NodeOutput;
  /** Reference to the workflow node for kind-specific rendering. */
  node: NonNullable<Workflow['nodes']>[number] | null;
}

function orderedSteps(run: WorkflowRun, workflow: Workflow | null): OrderedStep[] {
  const out: OrderedStep[] = [];
  const seen = new Set<string>();
  // Walk workflow node order first so steps render in declared order.
  if (workflow) {
    for (const node of workflow.nodes) {
      const o = run.nodeOutputs[node.id];
      if (!o) continue;
      out.push({ id: node.id, kind: node.kind, output: o, node });
      seen.add(node.id);
    }
  }
  // Fall through for any nodeOutput keys not in the workflow (loop iters,
  // dropped-since-edit nodes, etc.). Append in insertion order.
  for (const [id, o] of Object.entries(run.nodeOutputs)) {
    if (seen.has(id)) continue;
    out.push({ id, kind: null, output: o, node: null });
  }
  return out;
}

const NODE_STATUS_PILL: Record<NodeOutput['status'], { bg: string; glyph: string; label: string }> = {
  pending: { bg: 'bg-muted text-muted-foreground', glyph: '◯', label: 'pending' },
  running: { bg: 'bg-warning text-background', glyph: '◐', label: 'running' },
  complete: { bg: 'bg-success text-background', glyph: '✓', label: 'complete' },
  failed: { bg: 'bg-destructive text-destructive-foreground', glyph: '✕', label: 'failed' },
  skipped: { bg: 'bg-muted text-muted-foreground', glyph: '⤼', label: 'skipped' },
  cancelled: { bg: 'bg-muted text-muted-foreground', glyph: '⊘', label: 'cancelled' },
};

function StepRow({
  step,
  isOpen,
  onToggle,
  run,
  projectId,
}: {
  step: OrderedStep;
  isOpen: boolean;
  onToggle: () => void;
  run: WorkflowRun;
  projectId: string;
}) {
  const pill = NODE_STATUS_PILL[step.output.status];
  return (
    <div className="border-b border-border bg-card last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-muted"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            aria-hidden="true"
            className="font-mono text-[10px] text-muted-foreground"
          >
            {isOpen ? '▾' : '▸'}
          </span>
          <span className="truncate font-mono text-xs text-foreground">{step.id}</span>
          {step.kind && (
            <span className="bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              {step.kind}
            </span>
          )}
          {step.output.attempt && step.output.attempt > 1 && (
            <span className="bg-info px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-background">
              attempt {step.output.attempt}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[10px] text-muted-foreground">{stepDuration(step.output)}</span>
          <span
            className={
              'inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ' +
              pill.bg
            }
          >
            <span aria-hidden="true">{pill.glyph}</span>
            {pill.label}
          </span>
        </div>
      </button>
      {isOpen && (
        <div className="border-t border-border bg-background/40 px-3 py-3 text-[11px]">
          <StepDetail step={step} run={run} projectId={projectId} />
        </div>
      )}
    </div>
  );
}

function stepDuration(o: NodeOutput): string {
  if (!o.startedAt) return '—';
  const start = Date.parse(o.startedAt);
  const end = o.completedAt ? Date.parse(o.completedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
  return formatDuration(end - start);
}

function StepDetail({
  step,
  run,
  projectId,
}: {
  step: OrderedStep;
  run: WorkflowRun;
  projectId: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Timestamps output={step.output} />
      {step.output.error && (
        <DetailRow label="Error">
          <pre className="whitespace-pre-wrap break-words border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
            {step.output.error}
          </pre>
        </DetailRow>
      )}
      <KindRenderer step={step} run={run} projectId={projectId} />
      {step.output.output !== undefined && step.kind !== 'subagent' && step.kind !== 'http' && (
        <DetailRow label="Output">
          <pre className="whitespace-pre-wrap break-all border border-border bg-background/60 p-2 font-mono text-[11px] text-foreground">
            {formatOutput(step.output.output)}
          </pre>
        </DetailRow>
      )}
      <RetryControls step={step} run={run} projectId={projectId} />
    </div>
  );
}

// 4e.7 / D53. Retry-from-failed surfaces only on failed steps inside a run
// that's failed-or-cancelled (the server enforces both — keeping the button
// off non-failed steps avoids the wasted click). On confirm we POST to the
// retry-from endpoint, then auto-navigate the drawer to the new run's
// detail so the user sees the carry-forward + replay in flight. The
// original run row's lastReason gets the "re-fired as <id>" suffix via WS.
function RetryControls({
  step,
  run,
  projectId,
}: {
  step: OrderedStep;
  run: WorkflowRun;
  projectId: string;
}) {
  const openRun = useWorkflowDrawer((s) => s.openRun);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const canRetry =
    step.output.status === 'failed' && (run.status === 'failed' || run.status === 'cancelled');

  if (!canRetry) return null;

  async function go() {
    if (busy) return;
    const confirmed = window.confirm(
      `Retry from step "${step.id}"? Prior completed steps will reuse their existing output.`,
    );
    if (!confirmed) return;
    setBusy(true);
    setErr(null);
    try {
      const newId = await api.retryWorkflowRunFrom(projectId, run.id, step.id);
      openRun(newId);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1 border-t border-border pt-2">
      <div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void go()}
          className="bg-primary px-3 py-1 text-xs font-medium uppercase tracking-wider text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          ↻ Retry from here
        </button>
      </div>
      {err && (
        <div className="text-[11px] text-destructive" role="alert">
          {err}
        </div>
      )}
    </div>
  );
}

function Timestamps({ output }: { output: NodeOutput }) {
  if (!output.startedAt && !output.completedAt) return null;
  return (
    <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
      {output.startedAt && (
        <span>
          started <span className="font-mono">{new Date(output.startedAt).toLocaleString()}</span>
        </span>
      )}
      {output.completedAt && (
        <span>
          ended <span className="font-mono">{new Date(output.completedAt).toLocaleString()}</span>
        </span>
      )}
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-foreground">{children}</div>
    </div>
  );
}

function formatOutput(o: unknown): string {
  if (typeof o === 'string') return o;
  try {
    return JSON.stringify(o, null, 2);
  } catch {
    return String(o);
  }
}

// ── Per-kind renderers ────────────────────────────────────────────────────

function KindRenderer({
  step,
  run,
  projectId,
}: {
  step: OrderedStep;
  run: WorkflowRun;
  projectId: string;
}) {
  const openRun = useWorkflowDrawer((s) => s.openRun);
  switch (step.kind) {
    case 'subagent':
      return <SubagentRenderer step={step} />;
    case 'http':
      return <HttpRenderer step={step} />;
    case 'approval':
    case 'orchestrator-review':
      return <ReviewRenderer step={step} />;
    case 'workflow':
      return <NestedWorkflowRenderer step={step} run={run} projectId={projectId} onOpenRun={openRun} />;
    case 'bash':
    case 'script':
      return <BashRenderer step={step} />;
    default:
      return null;
  }
}

function SubagentRenderer({ step }: { step: OrderedStep }) {
  const o = step.output.output as { lastAssistantText?: string; pcCompletePayload?: unknown } | undefined;
  return (
    <>
      {step.output.transcriptPath && (
        <DetailRow label="Transcript">
          <code className="break-all text-[10px]">{step.output.transcriptPath}</code>
        </DetailRow>
      )}
      {o?.lastAssistantText && (
        <DetailRow label="Last assistant message">
          <pre className="whitespace-pre-wrap break-words border border-border bg-background/60 p-2 text-[11px] text-foreground">
            {o.lastAssistantText}
          </pre>
        </DetailRow>
      )}
      {o?.pcCompletePayload !== undefined && o?.pcCompletePayload !== null && (
        <DetailRow label="pc_complete_node payload">
          <pre className="whitespace-pre-wrap break-all border border-border bg-background/60 p-2 font-mono text-[11px] text-foreground">
            {formatOutput(o.pcCompletePayload)}
          </pre>
        </DetailRow>
      )}
    </>
  );
}

function HttpRenderer({ step }: { step: OrderedStep }) {
  const o = step.output.output as { status?: number; body?: string; headers?: Record<string, string> } | undefined;
  if (!o) return null;
  return (
    <>
      {o.status !== undefined && (
        <DetailRow label="Response status">
          <span className="font-mono">{o.status}</span>
        </DetailRow>
      )}
      {o.body && (
        <DetailRow label="Response body">
          <pre className="whitespace-pre-wrap break-all border border-border bg-background/60 p-2 font-mono text-[11px] text-foreground">
            {o.body}
          </pre>
        </DetailRow>
      )}
    </>
  );
}

function ReviewRenderer({ step }: { step: OrderedStep }) {
  const o = step.output.output as { approved?: boolean; response?: string } | undefined;
  if (!o) return null;
  return (
    <DetailRow label="Decision">
      <div className="flex flex-col gap-1">
        {o.approved !== undefined && (
          <span className="font-mono text-[11px]">
            {o.approved ? '✓ approved' : '✕ rejected'}
          </span>
        )}
        {o.response && <span className="break-words">{o.response}</span>}
      </div>
    </DetailRow>
  );
}

function NestedWorkflowRenderer({
  step,
  run,
  onOpenRun,
}: {
  step: OrderedStep;
  run: WorkflowRun;
  projectId: string;
  onOpenRun: (id: string) => void;
}) {
  const o = step.output.output as { childRunId?: string } | undefined;
  if (!o?.childRunId) return null;
  // Same-workflow nested run: clicking jumps within this drawer. Cross-
  // workflow nested would re-scope the drawer, but we don't know the child's
  // workflowId at the wire level today; clicking just opens the run id and
  // the drawer body refetches.
  void run;
  return (
    <DetailRow label="Child run">
      <button
        type="button"
        onClick={() => onOpenRun(o.childRunId!)}
        className="font-mono text-[11px] underline hover:no-underline"
      >
        {o.childRunId}
      </button>
    </DetailRow>
  );
}

function BashRenderer({ step }: { step: OrderedStep }) {
  const o = step.output.output as { stdout?: string; stderr?: string; exitCode?: number } | undefined;
  if (!o) return null;
  return (
    <>
      {o.exitCode !== undefined && (
        <DetailRow label="Exit code">
          <span className="font-mono">{o.exitCode}</span>
        </DetailRow>
      )}
      {o.stdout && (
        <DetailRow label="stdout">
          <pre className="whitespace-pre-wrap break-all border border-border bg-background/60 p-2 font-mono text-[11px] text-foreground">
            {o.stdout}
          </pre>
        </DetailRow>
      )}
      {o.stderr && (
        <DetailRow label="stderr">
          <pre className="whitespace-pre-wrap break-all border border-destructive/40 bg-destructive/5 p-2 font-mono text-[11px] text-foreground">
            {o.stderr}
          </pre>
        </DetailRow>
      )}
    </>
  );
}
