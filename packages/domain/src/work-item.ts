// WorkItem domain type. The unit of work that flows between project stages.
// Persisted as a row in the sqlite `work_items` table.

import type { ULID } from './ulid.ts';

export type WorkItemStatus =
  | 'pending'
  | 'in-progress'
  | 'blocked'
  | 'complete'
  | 'failed'
  | 'archived';

/** Built-in, fixed-set work-item types. Extendable later — not per-project
 *  configurable today (rationale in docs/buildout/work-item-types-and-log-bug.md). */
export const WORK_ITEM_TYPES = ['task', 'bug', 'feature', 'spike'] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

export function isWorkItemType(value: unknown): value is WorkItemType {
  return typeof value === 'string' && (WORK_ITEM_TYPES as readonly string[]).includes(value);
}

export interface WorkItem {
  id: ULID;
  projectId: ULID;
  parentId: ULID | null;
  /** Sort key within (parentId, stageId). Stable across moves. */
  position: number;
  title: string;
  body: string;
  stageId: string;
  status: WorkItemStatus;
  /** Reason for the current status when not `pending` — surfaced in the UI. */
  statusReason: string | null;
  /** Built-in type. Default `task` for legacy rows. Bug is the type filed by `pc_log_bug`. */
  type: WorkItemType;
  fields: Record<string, unknown>;
  /** Optimistic-concurrency counter. Bumped on every mutation; client must echo it on PATCH. */
  version: number;
  createdAt: number;
  updatedAt: number;
  /** Soft-delete timestamp. status='archived' is the user-facing concept. */
  deletedAt: number | null;
}

/** Internal append-only event log written by mutation paths in the repo.
 *  NOT surfaced via the public WorkItem shape — the Activity tab reads
 *  events.jsonl, which is the source of truth. */
export interface WorkItemHistoryEntry {
  ts: string;
  kind: 'move' | 'update';
  from?: string;
  to?: string;
  fields?: Record<string, unknown>;
  note?: string;
}
