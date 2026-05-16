import { and, asc, eq, isNull } from 'drizzle-orm';
import type { ULID, WorkItem, WorkItemHistoryEntry, WorkItemStatus } from '@pc/domain';
import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { workItems } from '../schema.ts';

interface WorkItemRow {
  id: ULID;
  projectId: ULID;
  parentId: ULID | null;
  title: string;
  body: string;
  stageId: string;
  status: WorkItemStatus;
  statusReason: string | null;
  fields: Record<string, unknown>;
  history: WorkItemHistoryEntry[];
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

function toDomain(row: WorkItemRow): WorkItem {
  const out: WorkItem = {
    id: row.id,
    title: row.title,
    stageId: row.stageId,
    fields: row.fields,
    history: row.history,
  };
  if (row.body) out.body = row.body;
  if (row.status !== 'pending') out.status = row.status;
  if (row.statusReason) out.statusReason = row.statusReason;
  return out;
}

export interface CreateWorkItemInput {
  projectId: ULID;
  stageId: string;
  title: string;
  body?: string;
  parentId?: ULID | null;
  fields?: Record<string, unknown>;
  initialHistory?: WorkItemHistoryEntry[];
}

export function listWorkItems(projectId: ULID): WorkItem[] {
  const rows = getDb()
    .select()
    .from(workItems)
    .where(and(eq(workItems.projectId, projectId), isNull(workItems.deletedAt)))
    .orderBy(asc(workItems.createdAt))
    .all() as WorkItemRow[];
  return rows.map(toDomain);
}

export function getWorkItem(id: ULID): WorkItem | null {
  const row = getRowById(id);
  return row ? toDomain(row) : null;
}

function getRowById(id: ULID): WorkItemRow | null {
  const row = getDb()
    .select()
    .from(workItems)
    .where(and(eq(workItems.id, id), isNull(workItems.deletedAt)))
    .get() as WorkItemRow | undefined;
  return row ?? null;
}

export function createWorkItem(input: CreateWorkItemInput): WorkItem {
  const now = Date.now();
  const id = newId();
  const row: WorkItemRow = {
    id,
    projectId: input.projectId,
    parentId: input.parentId ?? null,
    title: input.title,
    body: input.body ?? '',
    stageId: input.stageId,
    status: 'pending',
    statusReason: null,
    fields: input.fields ?? {},
    history: input.initialHistory ?? [],
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  getDb().insert(workItems).values(row).run();
  return toDomain(row);
}

/** Move a work item to a new stage, appending a 'move' history entry.
 *  Returns the updated WorkItem, or null if the id isn't found. */
export function moveWorkItemStage(id: ULID, toStage: string): WorkItem | null {
  const row = getRowById(id);
  if (!row) return null;
  const from = row.stageId;
  const entry: WorkItemHistoryEntry = {
    ts: new Date().toISOString(),
    kind: 'move',
    from,
    to: toStage,
  };
  const updated: WorkItemRow = {
    ...row,
    stageId: toStage,
    status: 'pending',
    statusReason: null,
    history: [...row.history, entry],
    version: row.version + 1,
    updatedAt: Date.now(),
  };
  getDb().update(workItems).set(updated).where(eq(workItems.id, id)).run();
  return toDomain(updated);
}

/** Merge field updates and append an 'update' history entry. */
export function updateWorkItemFields(id: ULID, fields: Record<string, unknown>): WorkItem | null {
  const row = getRowById(id);
  if (!row) return null;
  const entry: WorkItemHistoryEntry = {
    ts: new Date().toISOString(),
    kind: 'update',
    fields,
  };
  const updated: WorkItemRow = {
    ...row,
    fields: { ...row.fields, ...fields },
    history: [...row.history, entry],
    version: row.version + 1,
    updatedAt: Date.now(),
  };
  getDb().update(workItems).set(updated).where(eq(workItems.id, id)).run();
  return toDomain(updated);
}

/** Update status + statusReason. Used by the workflow runtime's lock + unlock hooks. */
export function updateWorkItemStatus(
  id: ULID,
  status: WorkItemStatus,
  statusReason: string | null = null,
): WorkItem | null {
  const row = getRowById(id);
  if (!row) return null;
  const updated: WorkItemRow = {
    ...row,
    status,
    statusReason,
    version: row.version + 1,
    updatedAt: Date.now(),
  };
  getDb().update(workItems).set(updated).where(eq(workItems.id, id)).run();
  return toDomain(updated);
}
