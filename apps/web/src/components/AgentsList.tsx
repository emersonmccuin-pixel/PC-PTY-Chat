// Section 17d.3 — Pod list page.
//
// Mirrors WorkflowList.tsx structure: header strip with title + "+ New
// agent" button, table of rows, row click → PodDetailModal (17d.4).
// Pods are global; the project prop is only used to access the active WS
// stream.

import { useMemo, useState } from 'react';

import type { Pod, Project } from '@/api/client';
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
]);

export function AgentsList({ project, events }: AgentsListProps) {
  const { pods, refetch } = useProjectPods(project, events);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailPodId, setDetailPodId] = useState<string | null>(null);

  const detailPod = useMemo(
    () => (detailPodId ? pods.find((p) => p.id === detailPodId) ?? null : null),
    [detailPodId, pods],
  );

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4">
        <Section
          title="Agents"
          empty="No agents yet. Click + New agent to create one."
          count={pods.length}
          action={
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-muted"
            >
              + New agent
            </button>
          }
        >
          {pods.map((pod) => (
            <PodRow key={pod.id} pod={pod} onOpen={() => setDetailPodId(pod.id)} />
          ))}
        </Section>
      </div>

      {createOpen && (
        <CreatePodModal
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

function PodRow({ pod, onOpen }: { pod: Pod; onOpen: () => void }) {
  const isStock = STOCK_POD_NAMES.has(pod.name);
  const editedAgo = formatRelativeTime(pod.updatedAt);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="grid w-full grid-cols-[1fr_auto] items-center gap-4 border border-border bg-card px-3 py-2 text-left hover:bg-muted"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{pod.name}</span>
          <span className="inline-flex items-center bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            global
          </span>
          {isStock && (
            <span className="inline-flex items-center bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
              stock
            </span>
          )}
        </div>
        {pod.description && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {pod.description}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end text-[10px] text-muted-foreground">
        {pod.model && <span>{pod.model}</span>}
        <span>edited {editedAgo}</span>
      </div>
    </button>
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
