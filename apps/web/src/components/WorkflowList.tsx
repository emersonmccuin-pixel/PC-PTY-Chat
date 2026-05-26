// Workflows panel — v2 list (19.12 cull complete; v1 surfaces ripped out).
//
// Renders the project's v2 workflow definitions + per-row run-count pills.
// "+ New workflow" opens the conversational WorkflowBuilderModal. The rich
// rail + detail-pane rewrite lands in 19.18 (this file is the slim placeholder
// until then).

import { useCallback, useEffect, useState } from 'react';

import type { Project, V2RunSummary, V2WorkflowDefSummary } from '@/api/client';
import { api } from '@/api/client';
import type { WsEnvelope, WsOutbound } from '@/hooks/use-project-ws';
import { WorkflowBuilderModal } from './WorkflowBuilderModal';

interface WorkflowListProps {
  project: Project;
  events: WsEnvelope[];
  send: (msg: WsOutbound) => boolean;
}

export function WorkflowList({ project, events, send }: WorkflowListProps) {
  const [v2Defs, setV2Defs] = useState<Array<{ id: string; name: string; workflow: V2WorkflowDefSummary }>>([]);
  const [v2Invalid, setV2Invalid] = useState<Array<{ fileName: string; errors: string[] }>>([]);
  const [v2Runs, setV2Runs] = useState<V2RunSummary[]>([]);
  const [v2RunErr, setV2RunErr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const refetch = useCallback(async (projectId: string) => {
    try {
      const [defResp, runResp] = await Promise.all([
        api.listV2WorkflowDefinitions(projectId),
        api.listV2WorkflowRuns(projectId),
      ]);
      setV2Defs(defResp.valid);
      setV2Invalid(defResp.invalid);
      setV2Runs(runResp.runs);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    setV2Defs([]);
    setV2Invalid([]);
    setV2Runs([]);
    void refetch(project.id);
  }, [project.id, refetch]);

  useEffect(() => {
    if (events.length === 0) return;
    const last = events[events.length - 1];
    if (!last) return;
    if (
      last.type === 'workflow-v2-run-changed' ||
      last.type === 'workflow-v2-definitions-changed'
    ) {
      void refetch(project.id);
    }
  }, [events, project.id, refetch]);

  async function fireV2Now(def: V2WorkflowDefSummary) {
    setV2RunErr(null);
    try {
      await api.fireV2Workflow(project.id, def);
      void refetch(project.id);
    } catch (e) {
      setV2RunErr(`${def.id}: ${(e as Error).message}`);
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

        {v2RunErr && (
          <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            fire failed: {v2RunErr}
            <button onClick={() => setV2RunErr(null)} className="ml-2 underline">
              dismiss
            </button>
          </div>
        )}

        <Section
          title="Workflows"
          empty="No workflows yet. Click + New workflow to author one."
          count={v2Defs.length + v2Invalid.length}
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
          {v2Defs.map((entry) => (
            <V2WorkflowRow
              key={entry.id}
              def={entry.workflow}
              runs={v2Runs.filter((r) => r.workflowId === entry.id)}
              onRunNow={() => void fireV2Now(entry.workflow)}
            />
          ))}
          {v2Invalid.map((wf) => (
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
        <WorkflowBuilderModal
          projectId={project.id}
          events={events}
          send={send}
          onClose={() => setCreateOpen(false)}
        />
      )}
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

function V2WorkflowRow({
  def,
  runs,
  onRunNow,
}: {
  def: V2WorkflowDefSummary;
  runs: V2RunSummary[];
  onRunNow: () => void;
}) {
  const runCount = runs.length;
  const failedCount = runs.filter((r) => r.status === 'failed').length;
  const runningCount = runs.filter((r) => r.status === 'running' || r.status === 'paused').length;
  const stageTrigger = def.triggers.find((t) => t.kind === 'stage-on-entry');
  const isCallable = def.triggers.some((t) => t.kind === 'manual');
  return (
    <div className="relative flex w-full items-stretch border border-border bg-card text-sm hover:bg-muted">
      <div
        className={
          'flex flex-1 items-center justify-between px-3 py-2 text-left ' +
          (def.disabled ? 'bg-muted/40 text-muted-foreground saturate-0' : '')
        }
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground">{def.name || def.id}</span>
            {def.disabled && (
              <span className="bg-foreground/80 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-background">
                Paused
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            {def.id} · {def.nodes.length} node{def.nodes.length === 1 ? '' : 's'}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {runningCount > 0 && (
            <span className="bg-primary/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-primary">
              {runningCount} running
            </span>
          )}
          {runCount > 0 && (
            <span className="bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              {runCount} run{runCount === 1 ? '' : 's'}
              {failedCount > 0 && (
                <span className="ml-1 text-destructive">· {failedCount} failed</span>
              )}
            </span>
          )}
          {stageTrigger && (
            <span className="bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              on_enter: {stageTrigger.stage}
            </span>
          )}
          {isCallable && (
            <span className="bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              callable
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onRunNow}
        disabled={def.disabled}
        className="border-l border-border px-3 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        title="Fire this workflow with kind=manual"
      >
        Run now
      </button>
    </div>
  );
}
