// UI Spine step 3 — announcing write-door for work_items.
//
// EVERY mutating write of a work_items row MUST be announced through
// announceWorkItem (or one of the WorkItemService methods that call it).
// The door: (1) reads back the full row, (2) broadcasts a versioned
// full-snapshot WS delta. "Forgetting to announce" is structurally
// impossible when callers only call the announcing functions.
//
// Work items already carry a monotonic `version` counter — no new `rev`
// column needed (mirrors the existing optimistic-concurrency field).

import type { ULID, WorkItem } from '@pc/domain';
import { getWorkItem } from '@pc/db';

export type WorkItemBroadcast = (event: WorkItemChangedEnvelope) => void;

export interface WorkItemChangedEnvelope {
  type: 'work-item-changed';
  projectId: ULID;
  workItem: WorkItem;
}

function buildDelta(workItem: WorkItem, projectId: ULID): WorkItemChangedEnvelope {
  return { type: 'work-item-changed', projectId, workItem };
}

/** Read the current row and broadcast a versioned snapshot. No-ops if the
 *  row is gone (caller's write was a no-op too). */
export function announceWorkItem(
  id: ULID,
  projectId: ULID,
  broadcast: WorkItemBroadcast,
): void {
  const wi = getWorkItem(id);
  if (!wi) return;
  broadcast(buildDelta(wi, projectId));
}

/** Broadcast an already-fetched row (e.g. right after create). */
export function announceWorkItemRow(
  workItem: WorkItem,
  projectId: ULID,
  broadcast: WorkItemBroadcast,
): void {
  broadcast(buildDelta(workItem, projectId));
}
