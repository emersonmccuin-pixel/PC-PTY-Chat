// Vendored from emersonmccuin-pixel/project-companion @ 6053ad6 (MIT)
// Source: apps/web/src/components/KanbanBoard.tsx
// Adapted for Project Companion:
//  - api calls keyed by projectId (ULID), not slug
//  - live updates via useProjectWs envelope hint, not EventSource
//  - Section 2c: rebuilt card visual (no status chip, glyph + child-count
//    badge), click-to-open WorkItemDetailModal, sortable within-column drag
//    that PATCHes position, cross-column drag that POSTs to /move with version
//    + position, horizontal scroll affordance (fade + chevrons on overflow).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';

import {
  api,
  WorkItemConflictError,
  type Project,
  type ProjectSettings,
  type Stage,
  type WorkItem,
  type WorkItemStatus,
} from '@/api/client';

// Section 27 — local mirror of the server-side resolver in @pc/domain.
// Keeps the web bundle independent of the workspace package.
function resolveCancelledHidden(
  settings: Partial<ProjectSettings> | undefined,
  globalHide: boolean,
): boolean {
  const v = settings?.cancelledVisibility ?? 'use-global';
  if (v === 'force-visible') return false;
  if (v === 'force-hidden') return true;
  return globalHide;
}
import type { WsEnvelope } from '@/hooks/use-project-ws';
import { CreateWorkItemModal } from './work-items/CreateWorkItemModal';
import { WorkItemDetailModal } from './work-items/WorkItemDetailModal';
import { useWorkItemsView } from '@/store/work-items-view';

interface KanbanBoardProps {
  project: Project;
  events: WsEnvelope[];
}

// Glyph-only status surface. Pending + complete read from the column itself
// (kanban column = status); only the two exception states need attention.
const STATUS_GLYPH: Partial<Record<WorkItemStatus, { glyph: string; className: string }>> = {
  'in-progress': { glyph: '⟳', className: 'text-warning' },
  blocked: { glyph: '⚠', className: 'text-destructive' },
  failed: { glyph: '⚠', className: 'text-destructive' },
};

// Built-in work-item type chip. `task` is the default and stays muted; bug /
// feature / spike get color-tinted pills so dogfood bug cards visually pop.
const TYPE_CHIP: Record<
  WorkItem['type'],
  { icon: string; label: string; className: string }
> = {
  task: { icon: '▢', label: 'Task', className: 'border-border text-muted-foreground' },
  bug: { icon: '🐛', label: 'Bug', className: 'border-destructive/40 bg-destructive/15 text-destructive' },
  feature: { icon: '✨', label: 'Feature', className: 'border-success/40 bg-success/15 text-success' },
  spike: { icon: '⚡', label: 'Spike', className: 'border-primary/40 bg-primary/15 text-primary' },
};

interface CreateModalState {
  stageId: string;
}

export function KanbanBoard({ project, events }: KanbanBoardProps) {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [createModal, setCreateModal] = useState<CreateModalState | null>(null);
  // Section 27 — read the global hideCancelledStage flag once on mount.
  // The per-project setting on `project.settings` overrides; the kanban
  // resolves both each render via `resolveCancelledHidden`.
  const [globalHideCancelled, setGlobalHideCancelled] = useState(false);
  useEffect(() => {
    let alive = true;
    void api
      .getSettings()
      .then((s) => {
        if (alive) setGlobalHideCancelled(s.hideCancelledStage === true);
      })
      .catch(() => {
        /* default `false` is safe */
      });
    return () => {
      alive = false;
    };
  }, []);
  const showAgentContracts = useWorkItemsView((s) => s.showAgentContracts);
  const setShowAgentContracts = useWorkItemsView((s) => s.setShowAgentContracts);

  // Section 26.7. Agent-contract work items render only when the toggle is on.
  // Hidden rows still flow through child-count + parent lookups so non-agent
  // children of an agent contract remain visible (rare today; reserved for
  // Section 19's workflow-root-as-work-item).
  const hiddenAgentCount = useMemo(
    () => items.filter((i) => i.isAgentTask).length,
    [items],
  );
  const visibleItems = useMemo(
    () => (showAgentContracts ? items : items.filter((i) => !i.isAgentTask)),
    [items, showAgentContracts],
  );

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
  // `work-items-changed` after create/patch/move/delete. Also pick up `event`
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

  // Section 27 — hide the cancelled-flagged stage when the resolved visibility
  // says so. Cards already living there stay reachable via direct links + via
  // the "Show archived" section in stages editor; this just keeps the column
  // off the board.
  const cancelledHidden = resolveCancelledHidden(project.settings, globalHideCancelled);
  const sortedStages = useMemo(() => {
    const sorted = [...project.stages].sort((a, b) => a.order - b.order);
    return cancelledHidden ? sorted.filter((s) => !s.isCancelled) : sorted;
  }, [project.stages, cancelledHidden]);

  // Pre-sort items by position within each stage. Stable across renders.
  // Uses `visibleItems` so the "See Agent Contracts" toggle (Section 26.7)
  // hides agent-task rows from each column when off.
  const itemsByStage = useMemo(() => {
    const map = new Map<string, WorkItem[]>();
    for (const stage of sortedStages) map.set(stage.id, []);
    for (const item of visibleItems) {
      const bucket = map.get(item.stageId);
      if (bucket) bucket.push(item);
    }
    for (const bucket of map.values()) bucket.sort((a, b) => a.position - b.position);
    return map;
  }, [visibleItems, sortedStages]);

  const childCountByParent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      if (item.parentId) counts.set(item.parentId, (counts.get(item.parentId) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const activeWiId = String(event.active.id);
    const overId = event.over?.id != null ? String(event.over.id) : null;
    if (!overId) return;

    const active = items.find((i) => i.id === activeWiId);
    if (!active) return;

    // Resolve drop target: another card (overId === some item.id) or a column
    // (overId === some stage.id). Stage drop = end of that column.
    const overItem = items.find((i) => i.id === overId);
    const targetStageId = overItem?.stageId ?? overId;
    const targetStage = sortedStages.find((s) => s.id === targetStageId);
    if (!targetStage) return;

    const sameStage = active.stageId === targetStage.id;
    const targetBucket = (itemsByStage.get(targetStage.id) ?? []).filter(
      (i) => i.id !== active.id,
    );
    const overIdx = overItem ? targetBucket.findIndex((i) => i.id === overItem.id) : targetBucket.length;
    if (sameStage && overItem && active.id === overItem.id) return;

    const newPosition = computePosition(targetBucket, overIdx);
    if (newPosition == null) return;
    if (sameStage && Math.abs(active.position - newPosition) < 1e-9) return;

    // Optimistic local reorder; server broadcast will reconcile via refetch.
    setItems((prev) =>
      prev.map((i) =>
        i.id === active.id ? { ...i, stageId: targetStage.id, position: newPosition } : i,
      ),
    );

    try {
      if (sameStage) {
        await api.patchWorkItem(project.id, active.id, active.version, {
          position: newPosition,
        });
      } else {
        await api.moveWorkItem(project.id, active.id, active.version, {
          stageId: targetStage.id,
          position: newPosition,
        });
      }
    } catch (e) {
      if (e instanceof WorkItemConflictError) {
        setError('This item changed elsewhere — refreshing.');
      } else {
        setError((e as Error).message);
      }
      refetch();
    }
  }

  const draggedItem = activeId ? items.find((i) => i.id === activeId) ?? null : null;
  const openItem = openItemId ? items.find((i) => i.id === openItemId) ?? null : null;

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex h-full flex-col">
        <KanbanToolbar
          showAgentContracts={showAgentContracts}
          onToggleAgentContracts={() => setShowAgentContracts(!showAgentContracts)}
          hiddenAgentCount={hiddenAgentCount}
        />
        <div className="min-h-0 flex-1">
          <KanbanScrollContainer>
            {sortedStages.map((stage) => (
              <Column
                key={stage.id}
                stage={stage}
                items={itemsByStage.get(stage.id) ?? []}
                childCounts={childCountByParent}
                onItemClick={(id) => setOpenItemId(id)}
                onAddCard={() => setCreateModal({ stageId: stage.id })}
              />
            ))}
          </KanbanScrollContainer>
        </div>
      </div>

      <DragOverlay>
        {draggedItem ? (
          <CardSurface
            item={draggedItem}
            childCount={childCountByParent.get(draggedItem.id) ?? 0}
            dragging
          />
        ) : null}
      </DragOverlay>

      {openItem && (
        <WorkItemDetailModal
          workItem={openItem}
          project={project}
          items={items}
          events={events}
          onClose={() => setOpenItemId(null)}
          onSwitchItem={(id) => setOpenItemId(id)}
          onItemCreated={(wi) =>
            setItems((prev) => (prev.some((p) => p.id === wi.id) ? prev : [...prev, wi]))
          }
        />
      )}

      {createModal && (
        <CreateWorkItemModal
          project={project}
          stageId={createModal.stageId}
          onClose={() => setCreateModal(null)}
          onCreated={(wi) =>
            setItems((prev) => (prev.some((p) => p.id === wi.id) ? prev : [...prev, wi]))
          }
        />
      )}

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

/** Section 26.7 toolbar. Hosts the "See Agent Contracts" toggle today; future
 *  Section 14 work (filters + table/kanban view switch) layers in here. */
function KanbanToolbar({
  showAgentContracts,
  onToggleAgentContracts,
  hiddenAgentCount,
}: {
  showAgentContracts: boolean;
  onToggleAgentContracts: () => void;
  hiddenAgentCount: number;
}) {
  const hiddenLabel =
    !showAgentContracts && hiddenAgentCount > 0
      ? ` (${hiddenAgentCount} hidden)`
      : '';
  return (
    <div className="flex items-center justify-end gap-3 border-b border-border bg-background px-4 py-2 text-sm">
      <label className="flex cursor-pointer items-center gap-2 text-muted-foreground hover:text-foreground">
        <input
          type="checkbox"
          checked={showAgentContracts}
          onChange={onToggleAgentContracts}
          className="h-3.5 w-3.5 cursor-pointer accent-primary"
        />
        <span>See Agent Contracts{hiddenLabel}</span>
      </label>
    </div>
  );
}

/** Compute a new `position` value such that the item lands at `targetIdx` in
 *  `bucket` (bucket excludes the dragged item, sorted ascending by position).
 *  Returns null when bucket is empty AND targetIdx is out of range (defensive
 *  — shouldn't happen). */
function computePosition(bucket: WorkItem[], targetIdx: number): number | null {
  if (bucket.length === 0) return 1;
  const clamped = Math.max(0, Math.min(targetIdx, bucket.length));
  if (clamped === 0) return bucket[0]!.position - 1;
  if (clamped >= bucket.length) return bucket[bucket.length - 1]!.position + 1;
  const prev = bucket[clamped - 1]!.position;
  const next = bucket[clamped]!.position;
  return (prev + next) / 2;
}

/** Horizontal scroll affordance: fade overlays + chevron buttons that appear
 *  when the row overflows. Refs tracked via a scroll/resize listener pair. */
function KanbanScrollContainer({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const overflow = el.scrollWidth > el.clientWidth + 1;
    setCanLeft(overflow && el.scrollLeft > 1);
    setCanRight(overflow && el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useLayoutEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    el.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      ro.disconnect();
    };
  }, [measure]);

  // Re-measure when children change (stages added / removed).
  useLayoutEffect(() => {
    measure();
  });

  function scrollByPage(direction: -1 | 1) {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: 'smooth' });
  }

  return (
    <div className="group relative h-full">
      <div
        ref={ref}
        className="flex h-full gap-4 overflow-x-auto p-4 [scrollbar-gutter:stable]"
      >
        {children}
      </div>

      {/* Left fade + chevron */}
      <div
        aria-hidden
        className={
          'pointer-events-none absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-background to-transparent transition-opacity ' +
          (canLeft ? 'opacity-100' : 'opacity-0')
        }
      />
      {canLeft && (
        <button
          type="button"
          onClick={() => scrollByPage(-1)}
          aria-label="Scroll columns left"
          className="absolute left-2 top-1/2 z-10 -translate-y-1/2 border border-border bg-background/90 px-2 py-1 text-sm opacity-0 shadow-sm transition-opacity hover:bg-muted group-hover:opacity-100"
        >
          ‹
        </button>
      )}

      {/* Right fade + chevron */}
      <div
        aria-hidden
        className={
          'pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-background to-transparent transition-opacity ' +
          (canRight ? 'opacity-100' : 'opacity-0')
        }
      />
      {canRight && (
        <button
          type="button"
          onClick={() => scrollByPage(1)}
          aria-label="Scroll columns right"
          className="absolute right-2 top-1/2 z-10 -translate-y-1/2 border border-border bg-background/90 px-2 py-1 text-sm opacity-0 shadow-sm transition-opacity hover:bg-muted group-hover:opacity-100"
        >
          ›
        </button>
      )}
    </div>
  );
}

function Column({
  stage,
  items,
  childCounts,
  onItemClick,
  onAddCard,
}: {
  stage: Stage;
  items: WorkItem[];
  childCounts: Map<string, number>;
  onItemClick: (id: string) => void;
  onAddCard: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const ids = useMemo(() => items.map((i) => i.id), [items]);

  return (
    <div
      ref={setNodeRef}
      data-stage-id={stage.id}
      className={
        'flex min-w-[14rem] flex-1 basis-0 flex-col border bg-card p-3 transition-colors ' +
        (isOver ? 'border-primary' : 'border-border')
      }
    >
      <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-foreground">
        <span className="flex items-center gap-1.5">
          <span>{stage.name}</span>
          {/* Section 27 — small flag badge so the user can see which column
              carries which role without opening project settings. */}
          {stage.isNew && <StageFlagBadge label="New" tone="primary" glyph="✱" />}
          {stage.isDone && <StageFlagBadge label="Done" tone="success" glyph="✓" />}
          {stage.isCancelled && (
            <StageFlagBadge label="Cancelled" tone="muted" glyph="✗" />
          )}
        </span>
        <span className="text-xs font-normal text-muted-foreground">{items.length}</span>
      </div>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-2">
          {items.map((item) => (
            <SortableCard
              key={item.id}
              item={item}
              childCount={childCounts.get(item.id) ?? 0}
              onClick={() => onItemClick(item.id)}
            />
          ))}
        </div>
      </SortableContext>
      <button
        onClick={onAddCard}
        className="mt-2 px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        + Add card
      </button>
    </div>
  );
}

// Section 27 — small badge rendered next to flag-bearing column titles.
function StageFlagBadge({
  label,
  tone,
  glyph,
}: {
  label: string;
  tone: 'primary' | 'success' | 'muted';
  glyph: string;
}) {
  const toneClass =
    tone === 'success'
      ? 'border-success/40 bg-success/15 text-success'
      : tone === 'primary'
        ? 'border-primary/40 bg-primary/15 text-primary'
        : 'border-border bg-muted text-muted-foreground';
  return (
    <span
      className={`inline-flex items-center gap-0.5 border px-1 py-px text-[9px] font-medium normal-case tracking-wide ${toneClass}`}
      title={`This stage is the project's "${label}" stage.`}
    >
      <span aria-hidden>{glyph}</span>
      <span>{label}</span>
    </span>
  );
}

function SortableCard({
  item,
  childCount,
  onClick,
}: {
  item: WorkItem;
  childCount: number;
  onClick: () => void;
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: item.id,
  });
  const style = {
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
      : undefined,
    transition,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      onClick={onClick}
      className={
        'cursor-grab select-none border border-border bg-background p-2 text-sm text-foreground hover:border-primary/60 ' +
        (isDragging ? 'opacity-30' : '')
      }
    >
      <CardContent item={item} childCount={childCount} />
    </div>
  );
}

/** Visual-only card body — shared between the live sortable card and the
 *  DragOverlay clone. */
function CardSurface({
  item,
  childCount,
  dragging,
}: {
  item: WorkItem;
  childCount: number;
  dragging?: boolean;
}) {
  return (
    <div
      className={
        'cursor-grabbing select-none border border-primary bg-background p-2 text-sm text-foreground shadow-md ' +
        (dragging ? '' : '')
      }
    >
      <CardContent item={item} childCount={childCount} />
    </div>
  );
}

function CardContent({ item, childCount }: { item: WorkItem; childCount: number }) {
  const status = item.status ?? 'pending';
  const glyph = STATUS_GLYPH[status];
  const typeChip = TYPE_CHIP[item.type ?? 'task'];
  return (
    <div className="flex items-start gap-2">
      <span className="line-clamp-2 min-w-0 flex-1 break-words">{item.title}</span>
      <div className="flex shrink-0 items-center gap-1">
        {item.type && item.type !== 'task' && (
          <span
            className={'border px-1 text-[10px] leading-tight ' + typeChip.className}
            title={typeChip.label}
            aria-label={typeChip.label}
          >
            <span aria-hidden="true">{typeChip.icon}</span> {typeChip.label}
          </span>
        )}
        {childCount > 0 && (
          <span
            className="border border-border px-1 text-[10px] text-muted-foreground"
            title={`${childCount} child${childCount === 1 ? '' : 'ren'}`}
          >
            ↳ {childCount}
          </span>
        )}
        {glyph && (
          <span
            className={'text-sm leading-none ' + glyph.className}
            title={item.statusReason ?? status}
            aria-label={status}
          >
            {glyph.glyph}
          </span>
        )}
      </div>
    </div>
  );
}

