// Section 37.7 — Table sub-tab. Sortable headers tied to the toolbar sort;
// row click opens WorkItemDetailModal (the existing surface).
//
// Columns shipped: Status · Title · Type · Initiative (parent breadcrumb) ·
// Updated. Pin / Assignee / Tags columns deferred — Pin needs the
// `is_pinned` column from 37.2 (high-collision; parked); Assignee + Tags
// have no backing data yet.

import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, type Project, type WorkItem, type WorkItemStatus, type WorkItemType } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';
import { useWorkItemsView } from '@/store/work-items-view';
import { WorkItemDetailModal } from './WorkItemDetailModal';
import { WorkItemsToolbar } from './WorkItemsToolbar';
import { applyFiltersAndSort } from './filter-sort';

interface Props {
  project: Project;
  events: WsEnvelope[];
  /** Section 37.8 — when provided, row clicks open the InitiativeInspector
   *  instead of the legacy WorkItemDetailModal. */
  onOpenInspector?: (workItem: WorkItem) => void;
}

const STATUS_LABEL: Record<WorkItemStatus, string> = {
  pending: 'Open',
  'in-progress': 'In progress',
  blocked: 'Blocked',
  complete: 'Done',
  failed: 'Failed',
  archived: 'Archived',
};

const STATUS_DOT: Record<WorkItemStatus, string> = {
  pending: 'bg-[var(--fg-dim)]',
  'in-progress': 'bg-warning',
  blocked: 'bg-destructive',
  complete: 'bg-success',
  failed: 'bg-destructive',
  archived: 'bg-[var(--fg-dim)]',
};

const TYPE_CHIP: Record<
  WorkItemType,
  { label: string; icon: string; className: string }
> = {
  task: { label: 'Task', icon: '▢', className: 'border-border text-muted-foreground' },
  bug: {
    label: 'Bug',
    icon: '🐛',
    className: 'border-destructive/40 bg-destructive/15 text-destructive',
  },
  feature: {
    label: 'Feature',
    icon: '✨',
    className: 'border-success/40 bg-success/15 text-success',
  },
  spike: {
    label: 'Spike',
    icon: '⚡',
    className: 'border-primary/40 bg-primary/15 text-primary',
  },
};

type SortBy = 'activity' | 'created' | 'alpha';

const COLUMNS: { key: string; label: string; sortBy?: SortBy; widthClass: string }[] = [
  { key: 'status', label: 'Status', widthClass: 'w-[140px]' },
  { key: 'title', label: 'Title', sortBy: 'alpha', widthClass: '' },
  { key: 'type', label: 'Type', widthClass: 'w-[90px]' },
  { key: 'initiative', label: 'Initiative', widthClass: 'w-[200px]' },
  { key: 'updated', label: 'Updated', sortBy: 'activity', widthClass: 'w-[110px]' },
];

export function WorkItemsTable({ project, events, onOpenInspector }: Props) {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const showAgentContracts = useWorkItemsView((s) => s.showAgentContracts);
  const filters = useWorkItemsView((s) => s.filters);
  const sort = useWorkItemsView((s) => s.sort);
  const setSort = useWorkItemsView((s) => s.setSort);

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

  useEffect(() => {
    if (events.length === 0) return;
    const last = events[events.length - 1];
    if (!last) return;
    if (last.type === 'work-items-changed') refetch();
  }, [events, refetch]);

  const hiddenAgentCount = useMemo(
    () => items.filter((i) => i.isAgentTask).length,
    [items],
  );

  const visibleItems = useMemo(() => {
    const base = showAgentContracts ? items : items.filter((i) => !i.isAgentTask);
    return applyFiltersAndSort(base, filters, sort);
  }, [items, showAgentContracts, filters, sort]);

  const parentById = useMemo(() => {
    const m = new Map<string, WorkItem>();
    for (const wi of items) m.set(wi.id, wi);
    return m;
  }, [items]);

  const openItem = openItemId
    ? items.find((i) => i.id === openItemId) ?? null
    : null;

  function clickHeader(sortBy: SortBy | undefined) {
    if (!sortBy) return;
    if (sort.by === sortBy) {
      setSort({ by: sortBy, dir: sort.dir === 'asc' ? 'desc' : 'asc' });
    } else {
      setSort({ by: sortBy, dir: 'desc' });
    }
  }

  return (
    <div className="flex h-full flex-col">
      <WorkItemsToolbar hiddenAgentCount={hiddenAgentCount} />

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead className="sticky top-0 z-10 bg-[var(--surface-2)]">
            <tr>
              {COLUMNS.map((c) => {
                const sortable = c.sortBy != null;
                const sorted = sortable && sort.by === c.sortBy;
                return (
                  <th
                    key={c.key}
                    onClick={() => clickHeader(c.sortBy)}
                    className={`border-b border-border px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.08em] ${
                      sorted
                        ? 'text-primary'
                        : sortable
                          ? 'cursor-pointer text-muted-foreground hover:text-primary'
                          : 'text-muted-foreground'
                    } ${c.widthClass} ${sortable ? 'select-none' : ''}`}
                  >
                    {c.label}
                    {sorted && (
                      <span className="ml-1 text-[10px] text-primary">
                        {sort.dir === 'asc' ? '↑' : '↓'}
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visibleItems.length === 0 && (
              <tr>
                <td
                  colSpan={COLUMNS.length}
                  className="px-3 py-10 text-center text-muted-foreground"
                >
                  {items.length === 0
                    ? 'No work items yet.'
                    : 'No items match the current filters.'}
                </td>
              </tr>
            )}
            {visibleItems.map((wi) => {
              const type = TYPE_CHIP[wi.type];
              const parent = wi.parentId ? parentById.get(wi.parentId) : null;
              return (
                <tr
                  key={wi.id}
                  onClick={() => {
                    if (onOpenInspector) onOpenInspector(wi);
                    else setOpenItemId(wi.id);
                  }}
                  className="cursor-pointer border-b border-border/30 hover:bg-primary/[0.04]"
                >
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-2">
                      <span
                        className={`inline-block h-[7px] w-[7px] ${STATUS_DOT[wi.status]}`}
                      />
                      <span className="text-foreground">
                        {STATUS_LABEL[wi.status]}
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-2 text-foreground">
                    <span className="font-medium">{wi.title}</span>
                    {wi.callsign && (
                      <span className="ml-2 text-[10px] text-[var(--fg-dim)]">
                        {wi.callsign}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.05em] ${type.className}`}
                    >
                      <span>{type.icon}</span>
                      <span>{type.label}</span>
                    </span>
                  </td>
                  <td className="px-3 py-2 text-[11px] text-[var(--fg-dim)]">
                    {parent ? parent.title : <span>—</span>}
                  </td>
                  <td className="px-3 py-2 text-[11px] text-[var(--fg-dim)]">
                    {formatRelative(wi.updatedAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

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

      {error && (
        <div className="fixed bottom-4 right-4 z-50 max-w-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-3 text-destructive hover:text-foreground"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  if (abs < minute) return 'just now';
  const future = diff < 0;
  let value: string;
  if (abs < hour) value = `${Math.round(abs / minute)}m`;
  else if (abs < day) value = `${Math.round(abs / hour)}h`;
  else if (abs < week) value = `${Math.round(abs / day)}d`;
  else value = `${Math.round(abs / week)}w`;
  return future ? `in ${value}` : `${value} ago`;
}
