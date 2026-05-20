// Section 6 — Activity panel. Five-region layout, per-project scoped:
//   1. Status line (sticky top)
//   2. Running workflows
//   3. Orchestrator status (always-visible card)
//   4. Workflow human-review inbox
//   5. Failed recently (collapsed, 7-day window)
//
// Today's flat WS event log is dropped from this surface — events.jsonl on
// disk + the WS stream preserve the data; Section 8 (Diagnostics tab) will
// re-derive when it opens.

import { useEffect, useMemo, useState } from 'react';

import type { Project, WorkflowRun } from '@/api/client';
import { api } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';
import { useProjectWorkflowRuns } from '@/hooks/use-project-workflow-runs';
import { useWorkflowDrawer } from '@/store/workflow-drawer';

interface ActivityPanelProps {
  project: Project | null;
  events: WsEnvelope[];
  onClose: () => void;
}

const ACTIVE_STATUSES = new Set<WorkflowRun['status']>([
  'pending',
  'in-progress',
  'paused',
]);

export function ActivityPanel({ project, events, onClose }: ActivityPanelProps) {
  // Single 5s tick so elapsed-time strings re-render without per-card timers.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const { runs } = useProjectWorkflowRuns(project, events);
  const activeRuns = useMemo(
    () => runs.filter((r) => ACTIVE_STATUSES.has(r.status)),
    [runs],
  );

  return (
    <div className="flex h-full flex-col border-l border-border bg-card">
      <Header onClose={onClose} />
      {project === null ? (
        <div className="flex-1 px-3 py-2 text-xs text-muted-foreground">
          No project selected.
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden">
          <StatusLine running={activeRuns.length} waiting={0} failedToday={0} />
          <div className="flex-1 overflow-y-auto">
            <RunningWorkflowsRegion
              project={project}
              runs={activeRuns}
              nowMs={nowMs}
            />
            <OrchestratorStatusRegion project={project} events={events} />
            <HumanReviewRegion project={project} />
            <FailedRecentlyRegion project={project} />
          </div>
        </div>
      )}
    </div>
  );
}

function Header({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex items-center justify-between border-b border-border px-3 py-2">
      <div className="text-sm uppercase tracking-wider text-muted-foreground">
        Activity
      </div>
      <button
        onClick={onClose}
        title="Hide activity panel"
        aria-label="Hide activity panel"
        className="px-1 text-xs text-muted-foreground hover:text-foreground"
      >
        ▸
      </button>
    </div>
  );
}

function StatusLine({
  running,
  waiting,
  failedToday,
}: {
  running: number;
  waiting: number;
  failedToday: number;
}) {
  return (
    <div className="border-b border-border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">
      {running} running · {waiting} waiting · {failedToday} failed today
    </div>
  );
}

function RegionShell({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-border">
      <div className="flex items-center justify-between px-3 py-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </div>
        {badge !== undefined && (
          <div className="bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
            {badge}
          </div>
        )}
      </div>
      <div>{children}</div>
    </section>
  );
}

function EmptyRegion({ text }: { text: string }) {
  return <div className="px-3 pb-2 text-[11px] italic text-muted-foreground/70">{text}</div>;
}

function RunningWorkflowsRegion({
  project,
  runs,
  nowMs,
}: {
  project: Project;
  runs: WorkflowRun[];
  nowMs: number;
}) {
  return (
    <RegionShell title="Running workflows" badge={String(runs.length)}>
      {runs.length === 0 ? (
        <EmptyRegion text="No workflows running." />
      ) : (
        <ul className="divide-y divide-border/50">
          {runs.map((run) => (
            <RunningWorkflowCard
              key={run.id}
              run={run}
              projectId={project.id}
              nowMs={nowMs}
            />
          ))}
        </ul>
      )}
    </RegionShell>
  );
}

function RunningWorkflowCard({
  run,
  projectId,
  nowMs,
}: {
  run: WorkflowRun;
  projectId: string;
  nowMs: number;
}) {
  const [cancelling, setCancelling] = useState(false);
  const [cancelErr, setCancelErr] = useState<string | null>(null);
  const openDrawerTo = useWorkflowDrawer((s) => s.openTo);

  const elapsed = formatElapsed(nowMs - new Date(run.startedAt).getTime());
  const currentStep = describeCurrentStep(run);
  const statusLabel =
    run.status === 'paused'
      ? 'paused'
      : run.status === 'pending'
        ? 'starting…'
        : 'running';

  async function handleCancel(e: React.MouseEvent) {
    e.stopPropagation();
    if (cancelling) return;
    setCancelling(true);
    setCancelErr(null);
    try {
      await api.cancelWorkflowRun(projectId, run.id);
    } catch (err) {
      setCancelErr((err as Error).message);
      setCancelling(false);
    }
    // No setCancelling(false) on success — the WS envelope will move the
    // run out of `activeRuns`, unmounting this card.
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => openDrawerTo(run.workflowId, run.id)}
        className="block w-full px-3 py-2 text-left hover:bg-muted/40"
      >
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
            {run.workflowId}
          </div>
          <div className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {elapsed}
          </div>
        </div>
        <div className="mt-0.5 flex items-baseline justify-between gap-2">
          <div className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {statusLabel} · {currentStep}
          </div>
          <button
            type="button"
            onClick={handleCancel}
            disabled={cancelling}
            className="shrink-0 border border-border bg-card px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-destructive/20 hover:text-destructive disabled:opacity-50"
          >
            {cancelling ? '…' : 'Cancel'}
          </button>
        </div>
        {cancelErr && (
          <div className="mt-1 text-[10px] text-destructive">cancel failed: {cancelErr}</div>
        )}
      </button>
    </li>
  );
}

function describeCurrentStep(run: WorkflowRun): string {
  const entries = Object.entries(run.nodeOutputs ?? {});
  // Prefer the first `running` node; otherwise the most recently updated
  // `pending` one. Empty node-outputs → "starting…".
  const inProgress = entries.find(([, o]) => o?.status === 'running');
  if (inProgress) return inProgress[0];
  const pending = entries.find(([, o]) => o?.status === 'pending');
  if (pending) return `up next: ${pending[0]}`;
  if (entries.length === 0) return 'starting…';
  return 'finishing';
}

function formatElapsed(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function OrchestratorStatusRegion({
  project: _project,
  events: _events,
}: {
  project: Project;
  events: WsEnvelope[];
}) {
  // 6.4 wires this region.
  return (
    <RegionShell title="Orchestrator">
      <div className="px-3 pb-2 text-[11px] text-muted-foreground/70 italic">Idle</div>
    </RegionShell>
  );
}

function HumanReviewRegion({ project: _project }: { project: Project }) {
  // 6.5 wires this region.
  return (
    <RegionShell title="Waiting on you" badge="0">
      <EmptyRegion text="Nothing waiting for your input." />
    </RegionShell>
  );
}

function FailedRecentlyRegion({ project: _project }: { project: Project }) {
  // 6.6 wires this region. Collapsed by default.
  return (
    <RegionShell title="Failed recently" badge="0">
      <EmptyRegion text="No failures in the last 7 days." />
    </RegionShell>
  );
}
