// Workflows panel — registry + pending approvals + lifecycle menu (4f.2).
//
// Sections: registry (valid + invalid YAML files) with row-level lifecycle
// actions (⋯ menu — Edit / Duplicate / Disable / Delete; Run now is queued
// for 4f.3), pending approvals (live cards). Clicking a workflow row opens
// the WorkflowDrawer (Definition + Runs tabs from 4e). Disabled workflows
// render with muted bg + grayscale text + DISABLED pill per D66.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { AttachedToWorkItem, Project, ULID, Workflow } from '@/api/client';
import { api } from '@/api/client';
import type { WsEnvelope, WsOutbound } from '@/hooks/use-project-ws';
import { useWorkflowDrawer } from '@/store/workflow-drawer';
import { CreateWorkflowModal } from './CreateWorkflowModal';
import { DeleteWorkflowDialog } from './workflows/DeleteWorkflowDialog';
import { DuplicateWorkflowModal } from './workflows/DuplicateWorkflowModal';
import { WorkflowDrawer } from './workflows/WorkflowDrawer';

interface WorkflowSummary {
  id: string;
  stageId: string | null;
  callable: boolean;
  disabled: boolean;
  attachedToWorkItem: AttachedToWorkItem;
  fileName: string;
}

interface InvalidWorkflowSummary {
  fileName: string;
  partialStageId: string | null;
  errors: string[];
}

interface WorkflowList {
  valid: WorkflowSummary[];
  invalid: InvalidWorkflowSummary[];
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
  const [editing, setEditing] = useState<
    | { id: string; def: Workflow; yamlText: string }
    | null
  >(null);
  const [editLoadErr, setEditLoadErr] = useState<string | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [toggleErr, setToggleErr] = useState<string | null>(null);

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

  // Refetch on workflow lifecycle events. Listens for `project-workflows-changed`
  // (4f.1 broadcasts: created / updated / deleted / duplicated / disabled) plus
  // the older event-kinds for approvals and runs.
  useEffect(() => {
    if (events.length === 0) return;
    const last = events[events.length - 1];
    if (!last) return;
    const kind = (last as { event?: { kind?: string } }).event?.kind;
    if (
      kind === 'approval-required' ||
      kind === 'task-start' ||
      kind === 'task-end' ||
      last.type === 'work-items-changed' ||
      last.type === 'project-workflows-changed'
    ) {
      void refetch(project.id);
    }
  }, [events, project.id, refetch]);

  async function toggleDisabled(wf: WorkflowSummary) {
    setToggleErr(null);
    try {
      // Fetch the def fresh so we don't have to mirror every field client-side
      // — server's PUT is the canonical save path.
      const { workflow } = await api.getWorkflow(project.id, wf.id);
      const next = { ...workflow, disabled: !wf.disabled };
      await api.editWorkflow(project.id, wf.id, { def: next });
      // Broadcast triggers refetch; nothing else to do.
    } catch (e) {
      setToggleErr(`${wf.id}: ${(e as Error).message}`);
    }
  }

  async function openEditModal(wfId: string) {
    setEditLoadErr(null);
    try {
      const { workflow, yamlText } = await api.getWorkflow(project.id, wfId);
      setEditing({ id: wfId, def: workflow, yamlText });
    } catch (e) {
      setEditLoadErr(`${wfId}: ${(e as Error).message}`);
    }
  }

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
        {toggleErr && (
          <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {toggleErr}
            <button onClick={() => setToggleErr(null)} className="ml-2 underline">
              dismiss
            </button>
          </div>
        )}
        {editLoadErr && (
          <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            failed to open edit modal: {editLoadErr}
            <button onClick={() => setEditLoadErr(null)} className="ml-2 underline">
              dismiss
            </button>
          </div>
        )}

        <Section title="Pending approvals" empty="No approvals waiting." count={approvals.length}>
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
            <WorkflowRow
              key={wf.fileName}
              wf={wf}
              runs={runs}
              onEdit={() => void openEditModal(wf.id)}
              onDuplicate={() => setDuplicatingId(wf.id)}
              onDelete={() => setDeletingId(wf.id)}
              onToggleDisabled={() => void toggleDisabled(wf)}
            />
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
                  <li key={i} className="font-mono">
                    {err}
                  </li>
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
      {editing && (
        <CreateWorkflowModal
          projectId={project.id}
          events={events}
          send={send}
          onClose={() => setEditing(null)}
          editingWorkflow={editing}
        />
      )}
      {duplicatingId && (
        <DuplicateWorkflowModal
          projectId={project.id}
          sourceWorkflowId={duplicatingId}
          onClose={() => setDuplicatingId(null)}
          onDuplicated={(newId) => {
            setDuplicatingId(null);
            void refetch(project.id);
            // Per D63: open the new (force-disabled) duplicate in the edit
            // modal so the user can review + adjust before enabling.
            void openEditModal(newId);
          }}
        />
      )}
      {deletingId && (
        <DeleteWorkflowDialog
          projectId={project.id}
          workflowId={deletingId}
          onClose={() => setDeletingId(null)}
          onDeleted={() => {
            setDeletingId(null);
            void refetch(project.id);
          }}
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
          {count !== null && <span className="text-muted-foreground">({count})</span>}
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

/** Section 4e.4 / D51 — entire row opens the WorkflowDrawer. The `⋯` menu
 *  hosts lifecycle actions (D65) — clicking it doesn't open the drawer. */
function WorkflowRow({
  wf,
  runs,
  onEdit,
  onDuplicate,
  onDelete,
  onToggleDisabled,
}: {
  wf: WorkflowSummary;
  runs: WorkflowRun[];
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onToggleDisabled: () => void;
}) {
  const openDrawer = useWorkflowDrawer((s) => s.open);
  const runsForWf = runs.filter((r) => r.workflowId === wf.id);
  const runCount = runsForWf.length;
  const failedCount = runsForWf.filter((r) => r.status === 'failed').length;
  return (
    <div className="relative flex w-full items-stretch border border-border bg-card text-sm hover:bg-muted">
      <button
        type="button"
        onClick={() => openDrawer(wf.id)}
        className={
          'flex flex-1 items-center justify-between px-3 py-2 text-left ' +
          (wf.disabled ? 'bg-muted/40 text-muted-foreground saturate-0' : '')
        }
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground">{wf.id}</span>
            {wf.disabled && (
              <span className="bg-foreground/80 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-background">
                Paused
              </span>
            )}
          </div>
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
      <RowMenu
        disabled={wf.disabled}
        onEdit={onEdit}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
        onToggleDisabled={onToggleDisabled}
      />
    </div>
  );
}

/** Section 4f.2 / D65 — `⋯` popover anchored to the row's right edge.
 *  Menu items: Run now (queued for 4f.3) / Edit / Duplicate /
 *  Disable | Enable / Delete. Click anywhere outside to dismiss. */
function RowMenu({
  disabled,
  onEdit,
  onDuplicate,
  onDelete,
  onToggleDisabled,
}: {
  disabled: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onToggleDisabled: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  function pick(fn: () => void) {
    setOpen(false);
    fn();
  }

  return (
    <div ref={rootRef} className="relative flex items-stretch border-l border-border">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-label="Workflow actions"
        title="Workflow actions"
        className="flex items-center px-2 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <span aria-hidden="true" className="text-base leading-none">
          ⋯
        </span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-1 flex w-56 flex-col border border-border bg-card text-xs shadow-lg">
          <MenuItem
            label="Run now"
            sublabel="(coming in 4f.3)"
            disabled
            onClick={() => {
              /* 4f.3 lands the manual-fire path */
            }}
          />
          <MenuItem label="Edit" onClick={() => pick(onEdit)} />
          <MenuItem label="Duplicate" onClick={() => pick(onDuplicate)} />
          <MenuItem
            label={disabled ? 'Enable' : 'Disable'}
            onClick={() => pick(onToggleDisabled)}
          />
          <MenuItem label="Delete" destructive onClick={() => pick(onDelete)} />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  label,
  sublabel,
  destructive,
  disabled,
  onClick,
}: {
  label: string;
  sublabel?: string;
  destructive?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        'flex items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 ' +
        (destructive ? 'text-destructive hover:bg-destructive/10' : 'text-foreground')
      }
    >
      <span>{label}</span>
      {sublabel && <span className="text-[10px] text-muted-foreground">{sublabel}</span>}
    </button>
  );
}
