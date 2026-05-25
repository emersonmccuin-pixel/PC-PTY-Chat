// Section 6 — Activity panel. Per-project scoped:
//   1. Running agents (top)
//   2. Running workflows
//   3. Workflow human-review inbox (pushed to bottom via mt-auto)
//   4. Failed recently (collapsed, 7-day window, very bottom)
//
// Section 32.3 — when collapsed, renders a 36px badge gutter instead of
// hiding the panel. Auto-swells when "waiting on you" or "failed recently"
// transitions from 0 → non-zero (running counts don't auto-swell — they
// resolve themselves).

import { useEffect, useMemo, useRef, useState } from 'react';

import type { AgentRunRecord, Project, WorkflowRun } from '@/api/client';
import { api } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';
import { useProjectAgentRuns } from '@/hooks/use-project-agent-runs';
import { useProjectWorkflowRuns } from '@/hooks/use-project-workflow-runs';
import { useActiveCenterTab } from '@/store/active-center-tab';
import { useAgentTranscript } from '@/store/agent-transcript';
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
  expanded: boolean;
  onExpand: () => void;
  onClose: () => void;
}

const ACTIVE_STATUSES = new Set<WorkflowRun['status']>([
  'pending',
  'in-progress',
  'paused',
]);

export function ActivityPanel({
  project,
  events,
  expanded,
  onExpand,
  onClose,
}: ActivityPanelProps) {
  // Single 5s tick so elapsed-time strings re-render without per-card timers.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  // 28.5 — transcript-modal state lifted to a Shell-level zustand store
  // (mirrors the WorkflowDrawer pattern) so the chat-side
  // AgentDispatchGroupBubble can open it from a different tab.
  const openTranscript = useAgentTranscript((s) => s.open);

  const { runs } = useProjectWorkflowRuns(project, events);
  const activeRuns = useMemo(
    () => runs.filter((r) => ACTIVE_STATUSES.has(r.status)),
    [runs],
  );
  const pausedRuns = useMemo(
    () => runs.filter((r) => r.status === 'paused'),
    [runs],
  );
  const { runs: agentRuns } = useProjectAgentRuns(project, events);
  const approvals = usePendingApprovals(project, events);

  const sevenDaysAgoMs = nowMs - 7 * 24 * 60 * 60 * 1000;
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
  // Section 32.3 — auto-swell on first non-zero "waiting on you" or
  // "failed". Running counts don't auto-swell (they resolve themselves).
  const waitingCount = pausedRuns.length;
  const failedCount = recentFailedRuns.length;
  const prevWaiting = useRef(waitingCount);
  const prevFailed = useRef(failedCount);
  useEffect(() => {
    if (expanded) {
      prevWaiting.current = waitingCount;
      prevFailed.current = failedCount;
      return;
    }
    if (
      (waitingCount > 0 && prevWaiting.current === 0) ||
      (failedCount > 0 && prevFailed.current === 0)
    ) {
      onExpand();
    }
    prevWaiting.current = waitingCount;
    prevFailed.current = failedCount;
  }, [waitingCount, failedCount, expanded, onExpand]);

  if (!expanded) {
    return (
      <ActivityGutter
        agentsCount={agentRuns.length}
        workflowsCount={activeRuns.length}
        waitingCount={waitingCount}
        failedCount={failedCount}
        onExpand={onExpand}
      />
    );
  }

  return (
    <div className="flex h-full flex-col border-l border-border bg-card">
      <Header onClose={onClose} />
      {project === null ? (
        <div className="flex-1 px-3 py-2 text-xs text-muted-foreground">
          No project selected.
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-y-auto">
          <RunningAgentsRegion
            project={project}
            runs={agentRuns}
            nowMs={nowMs}
            onOpenTranscript={openTranscript}
          />
          <RunningWorkflowsRegion
            project={project}
            runs={activeRuns}
            nowMs={nowMs}
          />
          <div className="mt-auto">
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

function ActivityGutter({
  agentsCount,
  workflowsCount,
  waitingCount,
  failedCount,
  onExpand,
}: {
  agentsCount: number;
  workflowsCount: number;
  waitingCount: number;
  failedCount: number;
  onExpand: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onExpand}
      title="Expand activity panel"
      className="flex h-full w-full flex-col items-center gap-3 border-l border-border bg-card py-3 hover:bg-muted/40"
    >
      <span
        className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground"
        style={{ writingMode: 'vertical-rl', textOrientation: 'mixed' }}
      >
        activity
      </span>
      <GutterBadge label="Running agents" count={agentsCount} tone="muted" />
      <GutterBadge label="Running workflows" count={workflowsCount} tone="muted" />
      <GutterBadge
        label="Waiting on you"
        count={waitingCount}
        tone={waitingCount > 0 ? 'warning' : 'muted'}
      />
      <GutterBadge
        label="Failed recently"
        count={failedCount}
        tone={failedCount > 0 ? 'danger' : 'muted'}
      />
      <span className="mt-auto text-xs text-[var(--fg-dim)]">«</span>
    </button>
  );
}

function GutterBadge({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: 'muted' | 'warning' | 'danger';
}) {
  const cls =
    tone === 'warning'
      ? 'border-warning text-warning bg-[rgba(216,166,74,0.10)]'
      : tone === 'danger'
        ? 'border-destructive text-destructive bg-[rgba(199,74,58,0.10)]'
        : 'border-border text-[var(--fg-dim)]';
  return (
    <span
      title={`${label} · ${count}`}
      className={`inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full border px-1 text-[11px] ${cls}`}
    >
      {count}
    </span>
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

function RunningAgentsRegion({
  project,
  runs,
  nowMs,
  onOpenTranscript,
}: {
  project: Project;
  runs: AgentRunRecord[];
  nowMs: number;
  onOpenTranscript: (runId: string) => void;
}) {
  return (
    <RegionShell title="Running agents" badge={String(runs.length)}>
      {runs.length === 0 ? (
        <EmptyRegion text="No agents running." />
      ) : (
        <ul className="divide-y divide-border/50">
          {runs.map((run) => (
            <RunningAgentCard
              key={run.runId}
              run={run}
              projectId={project.id}
              nowMs={nowMs}
              onOpenTranscript={onOpenTranscript}
            />
          ))}
        </ul>
      )}
    </RegionShell>
  );
}

function RunningAgentCard({
  run,
  projectId,
  nowMs,
  onOpenTranscript,
}: {
  run: AgentRunRecord;
  projectId: string;
  nowMs: number;
  onOpenTranscript: (runId: string) => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  const [cancelErr, setCancelErr] = useState<string | null>(null);

  const elapsed = formatElapsed(nowMs - run.startedAt);
  const statusLabel =
    run.status === 'spawning'
      ? 'starting…'
      : run.status === 'paused'
        ? 'paused'
        : 'running';

  async function handleCancel(e: React.MouseEvent) {
    e.stopPropagation();
    if (cancelling) return;
    setCancelling(true);
    setCancelErr(null);
    try {
      await api.cancelAgentRun(projectId, run.runId);
    } catch (err) {
      setCancelErr((err as Error).message);
      setCancelling(false);
    }
    // No setCancelling(false) on success — the terminal `agent-run-changed`
    // envelope drops the row from the map, unmounting this card.
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpenTranscript(run.runId)}
        className="block w-full px-3 py-2 text-left hover:bg-muted/40"
        aria-label={`Open transcript for ${run.agentName}`}
      >
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
            {run.agentName}
          </div>
          <div className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {elapsed}
          </div>
        </div>
        <div className="mt-0.5 flex items-baseline justify-between gap-2">
          <div className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {statusLabel}
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
