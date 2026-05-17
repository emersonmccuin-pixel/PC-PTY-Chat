// Vendored from emersonmccuin-pixel/project-companion @ 6053ad6 (MIT)
// Source: apps/web/src/components/KanbanBoard.tsx
// Adapted for Project Companion:
//  - api calls keyed by projectId (ULID), not slug
//  - dropped optimistic-concurrency version tracking (trunk WorkItem has no
//    version field)
//  - dropped StageWorkflowIndicator (Q9) and parent/child counts (no parentId
//    on trunk WorkItem)
//  - live updates via useProjectWs envelope hint, not EventSource

import { useCallback, useEffect, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';

import {
  api,
  type Project,
  type Stage,
  type WorkItem,
  type WorkItemStatus,
} from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';

interface KanbanBoardProps {
  project: Project;
  events: WsEnvelope[];
}

const STATUS_COLOR: Record<WorkItemStatus, string> = {
  pending: 'text-muted-foreground',
  'in-progress': 'text-warning',
  blocked: 'text-destructive',
  complete: 'text-success',
  failed: 'text-destructive',
};

export function KanbanBoard({ project, events }: KanbanBoardProps) {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    api
      .workItems(project.id)
      .then(setItems)
      .catch((e) => setError((e as Error).message));
  }, [project.id]);

  useEffect(() => {
    setItems([]);
    refetch();
  }, [refetch]);

  // Live-refresh on server-broadcast work-item changes. Server emits
  // `work-items-changed` after create/move/update. We also pick up `event`
  // envelopes that include workItemId (workflow lifecycle) as a cheap hint.
  useEffect(() => {
    if (events.length === 0) return;
    const last = events[events.length - 1];
    if (!last) return;
    if (last.type === 'work-items-changed') refetch();
  }, [events, refetch]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const itemId = String(event.active.id);
    const toStage = event.over?.id ? String(event.over.id) : undefined;
    if (!toStage) return;
    const item = items.find((i) => i.id === itemId);
    if (!item || item.stageId === toStage) return;

    // Optimistic update; server broadcast will reconcile.
    setItems((prev) =>
      prev.map((i) => (i.id === itemId ? { ...i, stageId: toStage } : i)),
    );

    api
      .moveWorkItem(project.id, itemId, toStage)
      .catch((e) => {
        setError((e as Error).message);
        refetch();
      });
  }

  const sortedStages = [...project.stages].sort((a, b) => a.order - b.order);

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="flex h-full gap-4 overflow-x-auto p-4">
        {sortedStages.map((stage) => (
          <Column
            key={stage.id}
            stage={stage}
            items={items.filter((i) => i.stageId === stage.id)}
            project={project}
            onItemCreated={(wi) => setItems((prev) => [...prev, wi])}
          />
        ))}
      </div>
      {error && (
        <div className="fixed bottom-4 right-4 z-50 max-w-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}{' '}
          <button onClick={() => setError(null)} className="ml-2 underline">
            dismiss
          </button>
        </div>
      )}
    </DndContext>
  );
}

function Column({
  stage,
  items,
  project,
  onItemCreated,
}: {
  stage: Stage;
  items: WorkItem[];
  project: Project;
  onItemCreated: (wi: WorkItem) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  return (
    <div
      ref={setNodeRef}
      className={
        'flex w-72 shrink-0 flex-col border bg-card p-3 transition-colors ' +
        (isOver ? 'border-primary' : 'border-border')
      }
    >
      <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-foreground">
        <span>{stage.name}</span>
        <span className="text-xs font-normal text-muted-foreground">
          {items.length}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {items.map((item) => (
          <Card key={item.id} item={item} />
        ))}
      </div>
      <AddCardForm
        projectId={project.id}
        stageId={stage.id}
        onCreated={onItemCreated}
      />
    </div>
  );
}

function Card({ item }: { item: WorkItem }) {
  const { setNodeRef, attributes, listeners, transform, isDragging } = useDraggable({
    id: item.id,
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  const status = item.status ?? 'pending';
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={
        'cursor-grab border border-border bg-background p-2 text-sm text-foreground hover:border-primary/60 ' +
        (isDragging ? 'opacity-50 cursor-grabbing' : '')
      }
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 break-words">{item.title}</span>
        <span
          className={'shrink-0 text-[10px] uppercase tracking-wider ' + STATUS_COLOR[status]}
          title={item.statusReason ?? status}
        >
          {status}
        </span>
      </div>
    </div>
  );
}

function AddCardForm({
  projectId,
  stageId,
  onCreated,
}: {
  projectId: string;
  stageId: string;
  onCreated: (wi: WorkItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const r = await api.createWorkItem(projectId, trimmed, stageId);
      onCreated(r.workItem);
      setTitle('');
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-2 px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        + Add card
      </button>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="mt-2 flex flex-col gap-1"
    >
      <textarea
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Card title"
        className="bg-background px-2 py-1 text-sm"
        rows={2}
      />
      <div className="flex gap-1">
        <button
          type="submit"
          disabled={busy || !title.trim()}
          className="bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Add
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setTitle('');
          }}
          className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
