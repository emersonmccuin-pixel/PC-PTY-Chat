import type { WorkItemStatus } from './types';

export const WORK_ITEM_STATUS_ORDER: WorkItemStatus[] = [
  'pending',
  'in-progress',
  'awaiting-verification',
  'blocked',
  'complete',
  'failed',
  'cancelled',
  'archived',
];

export const WORK_ITEM_STATUS_FILTER_OPTIONS: { value: WorkItemStatus; label: string }[] = [
  { value: 'pending', label: 'Open' },
  { value: 'in-progress', label: 'In progress' },
  { value: 'awaiting-verification', label: 'Awaiting verification' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'complete', label: 'Done' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'archived', label: 'Archived' },
];

export const WORK_ITEM_STATUS_LABEL: Record<WorkItemStatus, string> =
  Object.fromEntries(WORK_ITEM_STATUS_FILTER_OPTIONS.map((s) => [s.value, s.label])) as Record<
    WorkItemStatus,
    string
  >;

export const WORK_ITEM_STATUS_DOT_CLASS: Record<WorkItemStatus, string> = {
  pending: 'bg-[var(--fg-dim)]',
  'in-progress': 'bg-warning',
  'awaiting-verification': 'bg-primary',
  blocked: 'bg-destructive',
  complete: 'bg-success',
  failed: 'bg-destructive',
  cancelled: 'bg-[var(--fg-dim)]',
  archived: 'bg-[var(--fg-dim)]',
};

export const WORK_ITEM_STATUS_GLYPH: Record<
  WorkItemStatus,
  { glyph: string; className: string }
> = {
  pending: { glyph: '▢', className: 'text-[var(--fg-dim)]' },
  'in-progress': { glyph: '⟳', className: 'text-warning' },
  'awaiting-verification': { glyph: '?', className: 'text-primary' },
  blocked: { glyph: '⚠', className: 'text-destructive' },
  complete: { glyph: '✓', className: 'text-success' },
  failed: { glyph: '⚠', className: 'text-destructive' },
  cancelled: { glyph: '×', className: 'text-[var(--fg-dim)]' },
  archived: { glyph: '▢', className: 'text-[var(--fg-dim)]' },
};

export const WORK_ITEM_STATUS_GROUP_ORDER: WorkItemStatus[] = [
  'in-progress',
  'awaiting-verification',
  'blocked',
  'failed',
  'pending',
  'complete',
  'cancelled',
  'archived',
];

export function labelWorkItemStatus(status: WorkItemStatus): string {
  return WORK_ITEM_STATUS_LABEL[status] ?? status;
}
