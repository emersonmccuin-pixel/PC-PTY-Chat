// Q9 read-only workflows panel.
//
// Three sections: registry (valid + invalid YAML files), pending approvals
// (live cards), recent runs (collapsed to most recent first). Builder UI is
// deferred to a later session — this is a status pane.

import { useCallback, useEffect, useState } from 'react';

import type { Project, ULID } from '@/api/client';
import type { WsEnvelope, WsOutbound } from '@/hooks/use-project-ws';
import { useWorkflowDrawer } from '@/store/workflow-drawer';
import { CreateWorkflowModal } from './CreateWorkflowModal';
import { WorkflowDrawer } from './workflows/WorkflowDrawer';

interface WorkflowList {
  valid: Array<{ id: string; stageId: string | null; callable: boolean; fileName: string }>;
  invalid: Array<{ fileName: string; partialStageId: string | null; errors: string[] }>;
}

interface PendingApproval {
  workflowRunId: string;
  nodeId: string;
  message: string;
  onRejectPrompt: string | null;
}

type RunStatus = 'pending' | 'in-progress' | 'paused' | 'complete' | 'failed' | 'cancelled';

interface WorkflowRun {
  id: string;
  workflowId: string;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  workItemId?: string;
  stageId?: string;
  parentRunId?: string;
  worktreePath: string | null;
  lastReason?: string;
}

interface WorkflowListProps {
  project: Project;
  events: WsEnvelope[];
  send: (msg: WsOutbound) => boolean;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T & { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) throw new Error(data.error ?? `${path} → ${res.status}`);
  return data;
}

export function WorkflowList({ project, events, send }: WorkflowListProps) {
  const [registry, setRegistry] = useState<WorkflowList | null>(null);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const refetch = useCallback(
    async (projectId: ULID) => {
      try {
        const [reg, app, runResp] = await Promise.all([
          getJson<WorkflowList>(`/api/projects/${projectId}/workflows`),
          getJson<{ approvals: PendingApproval[] }>(`/api/projects/${projectId}/approvals`),
          getJson<{ runs: WorkflowRun[] }>(`/api/projects/${projectId}/workflow-runs`),
        ]);
        setRegistry(reg);
        setApprovals(app.approvals);
        setRuns(runResp.runs);
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [],
  );

  useEffect(() => {
    setRegistry(null);
    setApprovals([]);
    setRuns([]);
    void refetch(project.id);
  }, [project.id, refetch]);

  // Refetch on workflow lifecycle events from the WS. Lazy: any chat-event
  // matching one of the workflow-relevant kinds triggers a full refresh. The
  // server doesn't yet emit a dedicated workflows-changed envelope.
  useEffect(() => {
    if (events.length === 0) return;
    const last = events[events.length - 1];
    if (!last) return;
    const kind = (last as { event?: { kind?: string } }).event?.kind;
    if (
      kind === 'approval-required' ||
      kind === 'task-start' ||
      kind === 'task-end' ||
      last.type === 'work-items-changed'
    ) {
      void refetch(project.id);
    }
  }, [events, project.id, refetch]);

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4">
        {error && (
          <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
            <button onClick={() => setError(null)} className="ml-2 underline">
              dismiss
            </button>
          </div>
        )}

        <Section
          title="Pending approvals"
          empty="No approvals waiting."
          count={approvals.length}
        >
          {approvals.map((a) => (
            <ApprovalRow
              key={`${a.workflowRunId}:${a.nodeId}`}
              approval={a}
              projectId={project.id}
              onResolved={() => void refetch(project.id)}
            />
          ))}
        </Section>

        <Section
          title="Workflows"
          empty="No workflow files in workspace/.project-companion/workflows/."
          count={registry ? registry.valid.length + registry.invalid.length : null}
          action={
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-muted"
            >
              + New workflow
            </button>
          }
        >
          {registry?.valid.map((wf) => (
            <WorkflowRow key={wf.fileName} wf={wf} runs={runs} projectId={project.id} />
          ))}
          {registry?.invalid.map((wf) => (
            <div
              key={wf.fileName}
              className="border border-destructive bg-destructive/10 px-3 py-2 text-sm"
            >
              <div className="mb-1 flex items-center gap-2">
                <span className="inline-flex items-center gap-1 bg-destructive px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-destructive-foreground">
                  <span aria-hidden="true">✕</span>
                  invalid yaml
                </span>
                <span className="font-medium text-foreground">{wf.fileName}</span>
              </div>
              {wf.partialStageId && (
                <div className="text-xs text-muted-foreground">
                  partial stage: {wf.partialStageId}
                </div>
              )}
              <ul className="mt-1 list-disc pl-5 text-xs text-destructive">
                {wf.errors.map((err, i) => (
                  <li key={i} className="font-mono">{err}</li>
                ))}
              </ul>
            </div>
          ))}
        </Section>

      </div>
      {createOpen && (
        <CreateWorkflowModal
          projectId={project.id}
          events={events}
          send={send}
          onClose={() => setCreateOpen(false)}
        />
      )}
      <WorkflowDrawer projectId={project.id} events={events} />
    </div>
  );
}

function Section({
  title,
  empty,
  count,
  action,
  children,
}: {
  title: string;
  empty: string;
  count: number | null;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-baseline justify-between gap-2 text-xs font-semibold uppercase tracking-wider text-foreground">
        <span className="flex items-baseline gap-2">
          <span>{title}</span>
          {count !== null && (
            <span className="text-muted-foreground">({count})</span>
          )}
        </span>
        {action}
      </h2>
      {hasChildren ? (
        <div className="flex flex-col gap-1">{children}</div>
      ) : (
        <div className="border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
          {empty}
        </div>
      )}
    </section>
  );
}

function ApprovalRow({
  approval,
  projectId,
  onResolved,
}: {
  approval: PendingApproval;
  projectId: ULID;
  onResolved: () => void;
}) {
  const [showReject, setShowReject] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function respond(approved: boolean, response: string) {
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/projects/${projectId}/approval/respond`, {
        workflowRunId: approval.workflowRunId,
        nodeId: approval.nodeId,
        approved,
        response,
      });
      onResolved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-warning/60 bg-card px-3 py-2 text-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="bg-warning px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-background">
          approval
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {approval.workflowRunId.slice(-8)} · {approval.nodeId}
        </span>
      </div>
      <div className="mb-2 text-sm text-foreground">{approval.message || '(no message)'}</div>
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void respond(true, '')}
            className="bg-primary px-3 py-1 text-xs font-medium uppercase tracking-wider text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setShowReject(true)}
            className="bg-destructive px-3 py-1 text-xs font-medium uppercase tracking-wider text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
          >
            Reject
          </button>
        </div>
        {showReject && (
          <div className="flex flex-col gap-1">
            {approval.onRejectPrompt && (
              <div className="text-xs text-muted-foreground">{approval.onRejectPrompt}</div>
            )}
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder={approval.onRejectPrompt ?? 'Optional reason'}
              className="border border-border bg-background px-2 py-1 text-sm"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond(false, reason)}
              className="self-start bg-destructive px-3 py-1 text-xs font-medium uppercase tracking-wider text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              Submit reject
            </button>
          </div>
        )}
        {error && <div className="text-xs text-destructive">{error}</div>}
      </div>
    </div>
  );
}

/** Section 4e.4 / D51 — clean click affordance. Entire row opens the
 *  WorkflowDrawer (Definition + Runs tabs). The 4d D45 inline "recent
 *  failures (24h)" expand was stripped here when the drawer landed — the
 *  Runs tab inside the drawer is the canonical home for failed-run inspection
 *  (filter Status = Failed, click row → full per-step detail + retry). */
function WorkflowRow({
  wf,
  runs,
  projectId,
}: {
  wf: { id: string; stageId: string | null; callable: boolean; fileName: string };
  runs: WorkflowRun[];
  projectId: ULID;
}) {
  const openDrawer = useWorkflowDrawer((s) => s.open);
  const runsForWf = runs.filter((r) => r.workflowId === wf.id);
  const runCount = runsForWf.length;
  const failedCount = runsForWf.filter((r) => r.status === 'failed').length;
  void projectId;
  return (
    <button
      type="button"
      onClick={() => openDrawer(wf.id)}
      className="flex items-center justify-between border border-border bg-card px-3 py-2 text-left text-sm hover:bg-muted"
    >
      <div className="min-w-0 flex-1">
        <div className="font-medium text-foreground">{wf.id}</div>
        <div className="text-xs text-muted-foreground">{wf.fileName}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {runCount > 0 && (
          <span className="bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            {runCount} run{runCount === 1 ? '' : 's'}
            {failedCount > 0 && (
              <span className="ml-1 text-destructive">· {failedCount} failed</span>
            )}
          </span>
        )}
        {wf.stageId && (
          <span className="bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            on_enter: {wf.stageId}
          </span>
        )}
        {wf.callable && (
          <span className="bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            callable
          </span>
        )}
      </div>
    </button>
  );
}

