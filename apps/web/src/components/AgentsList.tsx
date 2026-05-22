// Section 17d.3 + 17d follow-up — Pod list page.
//
// Two regions:
//   - Built-in (collapsed by default): the stock specialists. Read-only here;
//     editing lives in Global Settings (danger-zone). Always present.
//   - This project's agents (open): project-scope rows owned by this project.
//
// User-promoted globals (non-stock) DO NOT render here. They live in the
// global pool and become usable in another project via the "Add from global
// pool" picker, which clones them into that project (17d.f.2 / .f.3).

import { useMemo, useState } from 'react';

import { api, type Pod, type Project } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';
import { useProjectPods } from '@/hooks/use-project-pods';
import { CreatePodModal } from './agents/CreatePodModal';
import { PodDetailModal } from './agents/PodDetailModal';

interface AgentsListProps {
  project: Project;
  events: WsEnvelope[];
}

const STOCK_POD_NAMES = new Set([
  'orchestrator',
  'researcher',
  'writer',
  'reviewer',
  'planner',
  'extractor',
  'agent-designer',
]);

export function AgentsList({ project, events }: AgentsListProps) {
  const { pods, refetch } = useProjectPods(project, events);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailPodId, setDetailPodId] = useState<string | null>(null);
  const [builtinCollapsed, setBuiltinCollapsed] = useState(true);

  const { stockPods, projectPods } = useMemo(() => {
    const stock: Pod[] = [];
    const proj: Pod[] = [];
    for (const pod of pods) {
      if (pod.scope === 'global' && STOCK_POD_NAMES.has(pod.name)) {
        stock.push(pod);
      } else if (pod.scope === 'project') {
        proj.push(pod);
      }
      // Non-stock globals: intentionally not rendered here. Reachable only
      // via the "Add from global pool" picker (17d.f.2).
    }
    return { stockPods: stock, projectPods: proj };
  }, [pods]);

  const detailPod = useMemo(
    () => (detailPodId ? pods.find((p) => p.id === detailPodId) ?? null : null),
    [detailPodId, pods],
  );

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4">
        <CollapsibleSection
          title="Built-in"
          subtitle="Stock specialists. Edit in Global Settings."
          count={stockPods.length}
          collapsed={builtinCollapsed}
          onToggle={() => setBuiltinCollapsed((c) => !c)}
        >
          {stockPods.map((pod) => (
            <PodRow
              key={pod.id}
              pod={pod}
              variant="stock"
              onOpen={() => setDetailPodId(pod.id)}
              onPromoted={() => void refetch()}
            />
          ))}
        </CollapsibleSection>

        <Section
          title="This project's agents"
          empty="No project agents yet. Click + Add agent to create one."
          count={projectPods.length}
          action={
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-muted"
            >
              + Add agent
            </button>
          }
        >
          {projectPods.map((pod) => (
            <PodRow
              key={pod.id}
              pod={pod}
              variant="project"
              onOpen={() => setDetailPodId(pod.id)}
              onPromoted={() => void refetch()}
            />
          ))}
        </Section>
      </div>

      {createOpen && (
        <CreatePodModal
          project={project}
          events={events}
          existingProjectPodNames={projectPods.map((p) => p.name)}
          onClose={() => setCreateOpen(false)}
          onCreated={(newPod: Pod) => {
            setCreateOpen(false);
            setDetailPodId(newPod.id);
            void refetch();
          }}
        />
      )}
      {detailPod && (
        <PodDetailModal
          pod={detailPod}
          // Stock specialists in the project Agents tab open in read-only
          // mode. Editing them lives in Global Settings → Specialists
          // (17d.f.5). Non-stock globals never render in this tab; the
          // readOnly check still passes them through safely if they sneak in.
          readOnly={
            detailPod.scope === 'global' && STOCK_POD_NAMES.has(detailPod.name)
          }
          onClose={() => setDetailPodId(null)}
          onDeleted={() => {
            setDetailPodId(null);
            void refetch();
          }}
        />
      )}
    </div>
  );
}

function PodRow({
  pod,
  variant,
  onOpen,
  onPromoted,
}: {
  pod: Pod;
  variant: 'stock' | 'project';
  onOpen: () => void;
  onPromoted: () => void;
}) {
  const editedAgo = formatRelativeTime(pod.updatedAt);
  const [promoting, setPromoting] = useState(false);
  const [promoteErr, setPromoteErr] = useState<string | null>(null);

  async function handlePromote(e: React.MouseEvent) {
    e.stopPropagation();
    if (promoting) return;
    const ok = window.confirm(
      `Promote "${pod.name}" to the global pool?\n\nIt will become available to add to any project. The local copy will be removed from this project — re-add it from the global pool if you still want it here.`,
    );
    if (!ok) return;
    setPromoteErr(null);
    setPromoting(true);
    try {
      await api.promotePodToGlobal(pod.id);
      onPromoted();
    } catch (err) {
      setPromoteErr((err as Error).message);
    } finally {
      setPromoting(false);
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group grid w-full cursor-pointer grid-cols-[1fr_auto] items-center gap-4 border border-border bg-card px-3 py-2 text-left hover:bg-muted"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{pod.name}</span>
          {variant === 'stock' && (
            <span className="inline-flex items-center bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              read-only
            </span>
          )}
        </div>
        {pod.description && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {pod.description}
          </div>
        )}
        {promoteErr && (
          <div className="mt-0.5 truncate text-xs text-destructive">{promoteErr}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {variant === 'project' && (
          <button
            type="button"
            onClick={(e) => void handlePromote(e)}
            disabled={promoting}
            className="border border-border bg-card px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground disabled:opacity-50 group-hover:opacity-100"
            title="Make this agent available in every project"
          >
            {promoting ? 'Promoting…' : 'Promote to global'}
          </button>
        )}
        <div className="flex flex-col items-end text-[10px] text-muted-foreground">
          {pod.model && <span>{pod.model}</span>}
          <span>edited {editedAgo}</span>
        </div>
      </div>
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
  count: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          <span>{title}</span>
          <span className="border border-border px-1 text-[10px] font-normal text-muted-foreground">
            {count}
          </span>
        </div>
        {action}
      </header>
      {count === 0 ? (
        <div className="border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          {empty}
        </div>
      ) : (
        <div className="flex flex-col gap-1">{children}</div>
      )}
    </section>
  );
}

function CollapsibleSection({
  title,
  subtitle,
  count,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  subtitle?: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <header
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        className="flex cursor-pointer select-none items-center justify-between gap-3 hover:opacity-80"
      >
        <div className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          <span aria-hidden className="inline-block w-3 text-[10px]">
            {collapsed ? '▶' : '▼'}
          </span>
          <span>{title}</span>
          <span className="border border-border px-1 text-[10px] font-normal text-muted-foreground">
            {count}
          </span>
          {subtitle && (
            <span className="ml-2 text-[10px] font-normal normal-case tracking-normal text-muted-foreground">
              {subtitle}
            </span>
          )}
        </div>
      </header>
      {!collapsed && count > 0 && <div className="flex flex-col gap-1">{children}</div>}
      {!collapsed && count === 0 && (
        <div className="border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          No stock specialists installed.
        </div>
      )}
    </section>
  );
}

function formatRelativeTime(epochMs: number): string {
  const diffSec = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}
