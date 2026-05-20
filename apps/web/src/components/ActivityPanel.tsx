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

import type { ChatEvent, JsonlEvent } from '@/hooks/use-project-ws';
import type { Project, WorkflowRun } from '@/api/client';
import { api } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';
import { useProjectWorkflowRuns } from '@/hooks/use-project-workflow-runs';
import { useActiveCenterTab } from '@/store/active-center-tab';
import { useChatScrollTarget } from '@/store/chat-scroll-target';
import { useWorkflowDrawer } from '@/store/workflow-drawer';

interface PendingApproval {
  workflowRunId: string;
  nodeId: string;
  message: string;
  onRejectPrompt: string | null;
}

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
  const pausedRuns = useMemo(
    () => runs.filter((r) => r.status === 'paused'),
    [runs],
  );
  const approvals = usePendingApprovals(project, events);
  const orchestratorState = useOrchestratorState(events);

  const askWaiting = orchestratorState === 'waiting-on-you' ? 1 : 0;
  const waitingCount = askWaiting + pausedRuns.length;

  const sevenDaysAgoMs = nowMs - 7 * 24 * 60 * 60 * 1000;
  const todayStartMs = useMemo(() => {
    const d = new Date(nowMs);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, [nowMs]);
  const dismissedRunIds = useDismissedRunIds(project);
  const recentFailedRuns = useMemo(
    () =>
      runs
        .filter((r) => r.status === 'failed' || r.status === 'cancelled')
        .filter((r) => {
          const completed = r.completedAt
            ? new Date(r.completedAt).getTime()
            : new Date(r.startedAt).getTime();
          return completed >= sevenDaysAgoMs;
        })
        .filter((r) => !dismissedRunIds.has(r.id))
        .sort((a, b) => {
          const ta = new Date(a.completedAt ?? a.startedAt).getTime();
          const tb = new Date(b.completedAt ?? b.startedAt).getTime();
          return tb - ta;
        }),
    [runs, sevenDaysAgoMs, dismissedRunIds],
  );
  const failedToday = useMemo(
    () =>
      recentFailedRuns.filter((r) => {
        const completed = r.completedAt
          ? new Date(r.completedAt).getTime()
          : new Date(r.startedAt).getTime();
        return completed >= todayStartMs;
      }).length,
    [recentFailedRuns, todayStartMs],
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
          <StatusLine
            running={activeRuns.length}
            waiting={waitingCount}
            failedToday={failedToday}
          />
          <div className="flex-1 overflow-y-auto">
            <OrchestratorStatusRegion state={orchestratorState} />
            <RunningWorkflowsRegion
              project={project}
              runs={activeRuns}
              nowMs={nowMs}
            />
            <HumanReviewRegion
              project={project}
              pausedRuns={pausedRuns}
              approvals={approvals}
              nowMs={nowMs}
            />
            <FailedRecentlyRegion
              project={project}
              runs={recentFailedRuns}
              nowMs={nowMs}
            />
          </div>
        </div>
      )}
    </div>
  );
}

type OrchestratorState =
  | 'idle'
  | 'thinking'
  | 'waiting-on-you'
  | 'waiting-on-approval';

/** UI-side reduction over the project's WS event stream. No new server
 *  envelope needed — the four states are derived from existing signals:
 *    - `ask` envelope newer than any `turn-end` → waiting-on-you
 *    - `approval-required` event without a downstream resolution → waiting-on-approval
 *    - PTY `state=thinking` or jsonl-user without jsonl-turn-end → thinking
 *    - otherwise → idle
 *
 *  Section 4e's approval-resolved signal isn't broadcast today; we rely on
 *  the runtime emitting a workflow-run-changed envelope (status flips off
 *  `paused`) to drop "waiting-on-approval" from the reduction. */
function useOrchestratorState(events: WsEnvelope[]): OrchestratorState {
  return useMemo(() => {
    // Walk newest → oldest to find the most recent ask before any turn-end.
    let askPending = false;
    for (let i = events.length - 1; i >= 0; i--) {
      const env = events[i]!;
      if (env.type === 'turn-end') break;
      if (env.type === 'jsonl') {
        const ev = (env as WsEnvelope & { event: JsonlEvent }).event;
        if (ev?.kind === 'jsonl-turn-end') break;
      }
      if (env.type === 'event') {
        const ev = (env as WsEnvelope & { event: ChatEvent }).event;
        if (ev?.kind === 'stop-failure') break;
      }
      if (env.type === 'ask') {
        askPending = true;
        break;
      }
    }
    if (askPending) return 'waiting-on-you';

    // Pending approval = the most recent approval-required event for a run
    // whose status is still `paused`. Without the run map here, fall back to
    // "any approval-required since the last turn-end" — same window as ask.
    let approvalPending = false;
    for (let i = events.length - 1; i >= 0; i--) {
      const env = events[i]!;
      if (env.type !== 'event') continue;
      const ev = (env as WsEnvelope & { event: ChatEvent }).event;
      if (!ev) continue;
      if (ev.kind === 'approval-required') {
        approvalPending = true;
        break;
      }
      // Treat workflow-run-changed terminal status as the resolution signal.
      // Without nodeId tracking, this is best-effort — false positives are
      // fine (orchestrator card just says "waiting" a little longer).
    }
    if (approvalPending) {
      // Check downstream resolution: any workflow-run-changed envelope newer
      // than this approval-required with status not in {paused, in-progress}
      // clears the approval.
      let approvalRequiredIdx = -1;
      for (let i = events.length - 1; i >= 0; i--) {
        const env = events[i]!;
        if (env.type !== 'event') continue;
        const ev = (env as WsEnvelope & { event: ChatEvent }).event;
        if (ev?.kind === 'approval-required') {
          approvalRequiredIdx = i;
          break;
        }
      }
      let resolved = false;
      for (let i = events.length - 1; i > approvalRequiredIdx; i--) {
        const env = events[i]!;
        if (env.type !== 'workflow-run-changed') continue;
        const status = (env as WsEnvelope & { status?: string }).status;
        if (status && status !== 'paused' && status !== 'pending' && status !== 'in-progress') {
          resolved = true;
          break;
        }
      }
      if (!resolved) return 'waiting-on-approval';
    }

    // Thinking: same reduction the orchestrator chat uses.
    let lastState: string | null = null;
    let jsonlBusy: boolean | null = null;
    for (const env of events) {
      if (env.type === 'state') {
        lastState = (env as WsEnvelope & { state: string }).state;
      } else if (env.type === 'turn-end') {
        lastState = 'ready';
      } else if (env.type === 'jsonl') {
        const ev = (env as WsEnvelope & { event: JsonlEvent }).event;
        if (ev?.kind === 'jsonl-user') jsonlBusy = true;
        else if (ev?.kind === 'jsonl-turn-end') jsonlBusy = false;
      }
    }
    const isThinking =
      jsonlBusy === null ? lastState === 'thinking' : jsonlBusy && lastState !== 'ready';
    if (isThinking) return 'thinking';
    return 'idle';
  }, [events]);
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

function OrchestratorStatusRegion({ state }: { state: OrchestratorState }) {
  const setTab = useActiveCenterTab((s) => s.setTab);
  const meta = ORCHESTRATOR_LABELS[state];
  const isIdle = state === 'idle';

  const onClick = () => {
    if (isIdle) return;
    // Jump the user to the orchestrator tab where the actionable surface
    // lives. Scroll-to-bubble plumbing arrives in 6.5; for now the tab
    // switch + a visible ask/approval bubble at the bottom of chat covers
    // the actionable click target.
    setTab('orchestrator');
  };

  return (
    <RegionShell title="Orchestrator">
      <button
        type="button"
        onClick={onClick}
        disabled={isIdle}
        className={`mx-3 mb-2 flex w-[calc(100%-1.5rem)] items-center gap-2 px-2 py-1.5 text-[11px] transition-colors ${meta.classes} ${
          isIdle ? 'cursor-default' : 'cursor-pointer hover:brightness-110'
        }`}
      >
        <span className="text-base leading-none">{meta.glyph}</span>
        <span className="flex-1 text-left font-medium">{meta.label}</span>
      </button>
    </RegionShell>
  );
}

const ORCHESTRATOR_LABELS: Record<
  OrchestratorState,
  { label: string; glyph: string; classes: string }
> = {
  idle: {
    label: 'Idle',
    glyph: '·',
    classes: 'bg-transparent text-muted-foreground/70 italic',
  },
  thinking: {
    label: 'Thinking',
    glyph: '⋯',
    classes: 'bg-primary/20 text-primary',
  },
  'waiting-on-you': {
    label: 'Waiting on you',
    glyph: '!',
    classes: 'bg-warning/25 text-warning',
  },
  'waiting-on-approval': {
    label: 'Waiting on approval',
    glyph: '?',
    classes: 'bg-warning/25 text-warning',
  },
};

function usePendingApprovals(
  project: Project | null,
  events: WsEnvelope[],
): PendingApproval[] {
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);

  useEffect(() => {
    if (!project) {
      setApprovals([]);
      return;
    }
    let cancelled = false;
    const refetch = () => {
      void fetch(`/api/projects/${project.id}/approvals`)
        .then((r) => r.json() as Promise<{ approvals: PendingApproval[] }>)
        .then((r) => {
          if (!cancelled) setApprovals(r.approvals ?? []);
        })
        .catch(() => {
          /* best-effort */
        });
    };
    refetch();
    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  // Refetch on approval-required arrival OR workflow-run-changed (which
  // fires when the run resumes after approval — drops the approval from
  // the server-side pending list).
  useEffect(() => {
    if (!project || events.length === 0) return;
    const last = events[events.length - 1]!;
    const kind = (last as { event?: { kind?: string } }).event?.kind;
    if (kind === 'approval-required' || last.type === 'workflow-run-changed') {
      void fetch(`/api/projects/${project.id}/approvals`)
        .then((r) => r.json() as Promise<{ approvals: PendingApproval[] }>)
        .then((r) => setApprovals(r.approvals ?? []))
        .catch(() => {
          /* best-effort */
        });
    }
  }, [events, project?.id]);

  return approvals;
}

function HumanReviewRegion({
  project: _project,
  pausedRuns,
  approvals,
  nowMs,
}: {
  project: Project;
  pausedRuns: WorkflowRun[];
  approvals: PendingApproval[];
  nowMs: number;
}) {
  const setTab = useActiveCenterTab((s) => s.setTab);
  const requestScrollTo = useChatScrollTarget((s) => s.requestScrollTo);

  // Map runId → its pending approval (if any). Most paused runs have one;
  // orchestrator-review pauses have none and click-through just lands the
  // user on the orchestrator tab.
  const approvalByRunId = useMemo(() => {
    const m = new Map<string, PendingApproval>();
    for (const a of approvals) m.set(a.workflowRunId, a);
    return m;
  }, [approvals]);

  if (pausedRuns.length === 0) {
    return (
      <RegionShell title="Waiting on you" badge="0">
        <EmptyRegion text="Nothing waiting for your input." />
      </RegionShell>
    );
  }

  return (
    <RegionShell title="Waiting on you" badge={String(pausedRuns.length)}>
      <ul className="divide-y divide-border/50">
        {pausedRuns.map((run) => {
          const approval = approvalByRunId.get(run.id);
          const stepLabel = approval
            ? `approval: ${approval.nodeId}`
            : describeCurrentStep(run);
          const waiting = formatElapsed(
            nowMs - new Date(run.startedAt).getTime(),
          );
          return (
            <li key={run.id}>
              <button
                type="button"
                onClick={() => {
                  setTab('orchestrator');
                  if (approval) {
                    requestScrollTo(
                      `approval-${approval.workflowRunId}-${approval.nodeId}`,
                    );
                  }
                }}
                className="block w-full px-3 py-2 text-left hover:bg-muted/40"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                    {run.workflowId}
                  </div>
                  <div className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {waiting}
                  </div>
                </div>
                <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {stepLabel}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </RegionShell>
  );
}

function useDismissedRunIds(project: Project | null): Set<string> {
  const [ids, setIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!project) {
      setIds(new Set());
      return;
    }
    let cancelled = false;
    void api.listFailedRunDismissals(project.id).then((list) => {
      if (!cancelled) setIds(new Set(list));
    });
    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  // Expose a setter via the same hook so the region can optimistically add
  // dismissed ids; re-fetch on next mount keeps server-of-truth canonical.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ runId: string }>).detail;
      if (!detail?.runId) return;
      setIds((prev) => {
        if (prev.has(detail.runId)) return prev;
        const next = new Set(prev);
        next.add(detail.runId);
        return next;
      });
    };
    window.addEventListener('pc:failed-run-dismissed', handler as EventListener);
    return () => {
      window.removeEventListener('pc:failed-run-dismissed', handler as EventListener);
    };
  }, []);

  return ids;
}

function FailedRecentlyRegion({
  project,
  runs,
  nowMs,
}: {
  project: Project;
  runs: WorkflowRun[];
  nowMs: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const openRun = useWorkflowDrawer((s) => s.openTo);

  async function handleDismiss(runId: string) {
    // Optimistic: emit the dismissal event so the hook drops it from the
    // list before the round-trip lands.
    window.dispatchEvent(
      new CustomEvent('pc:failed-run-dismissed', { detail: { runId } }),
    );
    try {
      await api.dismissFailedRun(project.id, runId);
    } catch {
      /* best-effort; user can re-click if it failed */
    }
  }

  if (runs.length === 0) {
    return (
      <RegionShell title="Failed recently" badge="0">
        <EmptyRegion text="No failures in the last 7 days." />
      </RegionShell>
    );
  }

  return (
    <section className="border-b border-border">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-1.5 hover:bg-muted/40"
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-muted-foreground">
            {expanded ? '▾' : '▸'}
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Failed recently
          </span>
        </div>
        <div className="bg-destructive/20 px-1.5 py-0.5 text-[10px] font-mono text-destructive">
          {runs.length}
        </div>
      </button>
      {expanded && (
        <ul className="divide-y divide-border/50">
          {runs.map((run) => {
            const when = formatElapsed(
              nowMs - new Date(run.completedAt ?? run.startedAt).getTime(),
            );
            const failedNode = Object.entries(run.nodeOutputs ?? {}).find(
              ([, o]) => o?.status === 'failed',
            );
            const stepLabel = failedNode
              ? `${run.status} at ${failedNode[0]}`
              : run.status;
            return (
              <li key={run.id} className="flex items-baseline gap-2 px-3 py-2">
                <button
                  type="button"
                  onClick={() => openRun(run.workflowId, run.id)}
                  className="min-w-0 flex-1 text-left hover:underline"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                      {run.workflowId}
                    </div>
                    <div className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {when} ago
                    </div>
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {stepLabel}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => void handleDismiss(run.id)}
                  className="shrink-0 border border-border bg-card px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="Hide this failure from the list (the 4e Runs tab still keeps it)"
                >
                  Dismiss
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
