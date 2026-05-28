import { getJson, postJson, postJsonMethod } from '@/api/http';
import type { Project, Stage, ULID } from '@/features/projects/client';

export type WorkItemStatus =
  | 'pending'
  | 'in-progress'
  | 'blocked'
  | 'complete'
  | 'failed'
  | 'archived';

export type InitiativeStatus = 'active' | 'someday' | 'done' | 'archived';
export type InitiativeFocusState = 'focused' | 'normal';
export type InitiativeNoteKind = 'capture' | 'context' | 'decision';

export interface Initiative {
  id: ULID;
  projectId: ULID;
  name: string;
  brief: string;
  status: InitiativeStatus;
  focusState: InitiativeFocusState;
  position: number;
  sourceVersion: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface InitiativeNote {
  id: ULID;
  initiativeId: ULID;
  kind: InitiativeNoteKind;
  body: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export const WORK_ITEM_TYPES = ['task', 'bug', 'feature', 'spike'] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

export interface WorkItemHistoryEntry {
  ts: string;
  kind:
    | 'move'
    | 'update'
    | 'agent-invoke'
    | 'agent-ask-orchestrator'
    | 'agent-ask-user'
    | 'agent-approval-request'
    | 'agent-answer'
    | 'agent-completed'
    | 'agent-failed';
  from?: string;
  to?: string;
  fields?: Record<string, unknown>;
  note?: string;
  agentName?: string;
  sessionId?: string;
  runId?: string;
  pendingAskId?: string;
  invokeMode?: 'sync' | 'async';
  answeredBy?: 'orchestrator' | 'user';
  cause?: string;
}

export interface WorkItem {
  id: ULID;
  projectId: ULID;
  parentId: ULID | null;
  initiativeId: ULID | null;
  position: number;
  title: string;
  body: string;
  stageId: string;
  status: WorkItemStatus;
  statusReason: string | null;
  type: WorkItemType;
  fields: Record<string, unknown>;
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  history: WorkItemHistoryEntry[];
  isAgentTask: boolean;
  callsign: string | null;
}

export type FieldSchemaType = 'text' | 'number' | 'boolean' | 'enum' | 'date';

export interface FieldSchema {
  id: ULID;
  projectId: ULID;
  key: string;
  label: string;
  type: FieldSchemaType;
  options?: string[];
  default?: unknown;
  required: boolean;
  description?: string;
  order: number;
}

export interface FieldSchemaInput {
  id?: ULID;
  key: string;
  label: string;
  type: FieldSchemaType;
  options?: string[];
  default?: unknown;
  required: boolean;
  description?: string;
  order: number;
}

export interface Attachment {
  id: ULID;
  workItemId: ULID;
  kind: string;
  name: string;
  content: string;
  contentType: string | null;
  runId: ULID | null;
  createdBySessionId: ULID | null;
  createdAt: number;
}

export interface WorkItemPatch {
  title?: string;
  body?: string;
  stageId?: string;
  parentId?: ULID | null;
  initiativeId?: ULID | null;
  position?: number;
  type?: WorkItemType;
  fields?: Record<string, unknown>;
}

export interface WorkItemMoveInput {
  stageId: string;
  position?: number;
}

export class WorkItemConflictError extends Error {
  current: WorkItem;
  constructor(current: WorkItem) {
    super('work item version conflict');
    this.name = 'WorkItemConflictError';
    this.current = current;
  }
}

export class StageHasItemsError extends Error {
  orphans: { id: string; name: string; count: number }[];
  constructor(orphans: { id: string; name: string; count: number }[]) {
    super('STAGE_HAS_ITEMS');
    this.name = 'StageHasItemsError';
    this.orphans = orphans;
  }
}

export class WorkItemFieldValidationError extends Error {
  errors: Record<string, string>;
  constructor(message: string, errors: Record<string, string>) {
    super(message);
    this.name = 'WorkItemFieldValidationError';
    this.errors = errors;
  }
}

export const workItemsApi = {
  focusedInitiatives: () =>
    getJson<{ ok: true; initiatives: Initiative[] }>('/api/initiatives/focus').then(
      (r) => r.initiatives,
    ),

  projectInitiatives: (projectId: ULID) =>
    getJson<{ ok: true; initiatives: Initiative[] }>(
      `/api/projects/${projectId}/initiatives`,
    ).then((r) => r.initiatives),

  createInitiative: (
    projectId: ULID,
    input: {
      name: string;
      brief?: string;
      status?: InitiativeStatus;
      focusState?: InitiativeFocusState;
      position?: number;
    },
  ) =>
    postJson<{ ok: true; initiative: Initiative }>(
      `/api/projects/${projectId}/initiatives`,
      input,
    ).then((r) => r.initiative),

  patchInitiative: (
    projectId: ULID,
    initiativeId: ULID,
    patch: Partial<Pick<Initiative, 'name' | 'brief' | 'status' | 'focusState' | 'position'>>,
  ) =>
    postJsonMethod<{ ok: true; initiative: Initiative }>(
      `/api/projects/${projectId}/initiatives/${initiativeId}`,
      patch,
      'PATCH',
    ).then((r) => r.initiative),

  initiativeNotes: (initiativeId: ULID, kind?: InitiativeNoteKind) => {
    const query = kind ? `?kind=${encodeURIComponent(kind)}` : '';
    return getJson<{ ok: true; notes: InitiativeNote[] }>(
      `/api/initiatives/${initiativeId}/notes${query}`,
    ).then((r) => r.notes);
  },

  createInitiativeNote: (
    initiativeId: ULID,
    input: { kind?: InitiativeNoteKind; body: string },
  ) =>
    postJson<{ ok: true; note: InitiativeNote }>(
      `/api/initiatives/${initiativeId}/notes`,
      input,
    ).then((r) => r.note),

  patchInitiativeNote: (
    initiativeId: ULID,
    noteId: ULID,
    patch: { kind?: InitiativeNoteKind; body?: string },
  ) =>
    postJsonMethod<{ ok: true; note: InitiativeNote }>(
      `/api/initiatives/${initiativeId}/notes/${noteId}`,
      patch,
      'PATCH',
    ).then((r) => r.note),

  deleteInitiativeNote: async (initiativeId: ULID, noteId: ULID): Promise<InitiativeNote> => {
    const res = await fetch(`/api/initiatives/${initiativeId}/notes/${noteId}`, {
      method: 'DELETE',
    });
    const data = (await res.json()) as
      | { ok: true; note: InitiativeNote }
      | { ok: false; error: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.ok === false ? data.error : `delete → ${res.status}`);
    }
    return data.note;
  },

  workItems: (projectId: ULID) =>
    getJson<{ workItems: WorkItem[] }>(`/api/projects/${projectId}/work-items`).then(
      (r) => r.workItems,
    ),

  getWorkItem: (projectId: ULID, wiId: ULID) =>
    getJson<{ ok: true; workItem: WorkItem }>(
      `/api/projects/${projectId}/work-items/${wiId}`,
    ).then((r) => r.workItem),

  createWorkItem: async (
    projectId: ULID,
    title: string,
    stageId: string,
    opts: {
      body?: string;
      parentId?: ULID | null;
      initiativeId?: ULID | null;
      type?: WorkItemType;
      fields?: Record<string, unknown>;
    } = {},
  ): Promise<{ ok: true; workItem: WorkItem }> => {
    const res = await fetch(`/api/projects/${projectId}/work-items/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, stageId, ...opts }),
    });
    const data = (await res.json()) as
      | { ok: true; workItem: WorkItem }
      | { ok: false; error: string; errors?: Record<string, string> };
    if (res.status === 400 && data.ok === false && data.errors) {
      throw new WorkItemFieldValidationError(data.error, data.errors);
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data.ok === false ? data.error : `create → ${res.status}`);
    }
    return data;
  },

  patchWorkItem: async (
    projectId: ULID,
    wiId: ULID,
    version: number,
    patch: WorkItemPatch,
  ): Promise<WorkItem> => {
    const res = await fetch(`/api/projects/${projectId}/work-items/${wiId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, ...patch }),
    });
    const data = (await res.json()) as
      | { ok: true; workItem: WorkItem }
      | { ok: false; error: string; current?: WorkItem; errors?: Record<string, string> };
    if (res.status === 409 && data.ok === false && data.current) {
      throw new WorkItemConflictError(data.current);
    }
    if (res.status === 400 && data.ok === false && data.errors) {
      throw new WorkItemFieldValidationError(data.error, data.errors);
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data.ok === false ? data.error : `patch → ${res.status}`);
    }
    return data.workItem;
  },

  softDeleteWorkItem: async (projectId: ULID, wiId: ULID): Promise<void> => {
    const res = await fetch(`/api/projects/${projectId}/work-items/${wiId}`, {
      method: 'DELETE',
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `delete → ${res.status}`);
    }
  },

  restoreWorkItem: (projectId: ULID, wiId: ULID) =>
    postJson<{ ok: true; workItem: WorkItem }>(
      `/api/projects/${projectId}/work-items/${wiId}/restore`,
      {},
    ).then((r) => r.workItem),

  listArchivedWorkItems: (projectId: ULID) =>
    getJson<{ items: WorkItem[]; nextCursor: ULID | null }>(
      `/api/projects/${projectId}/work-items?includeArchived=1&limit=500`,
    ).then((r) => r.items),

  replaceStages: async (
    projectId: ULID,
    stages: Stage[],
    opts: { force?: boolean; fallbackStageId?: string } = {},
  ): Promise<Project> => {
    const res = await fetch(`/api/projects/${projectId}/stages`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stages, ...opts }),
    });
    const data = (await res.json()) as
      | { ok: true; project: Project }
      | { ok: false; error: string; orphans?: { id: string; name: string; count: number }[] };
    if (
      res.status === 409 &&
      data.ok === false &&
      data.error === 'STAGE_HAS_ITEMS' &&
      Array.isArray(data.orphans)
    ) {
      throw new StageHasItemsError(data.orphans);
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data.ok === false ? data.error : `replace stages → ${res.status}`);
    }
    return data.project;
  },

  listFieldSchemas: (projectId: ULID) =>
    getJson<{ ok: true; items: FieldSchema[] }>(
      `/api/projects/${projectId}/field-schemas`,
    ).then((r) => r.items),

  replaceFieldSchemas: (projectId: ULID, items: FieldSchemaInput[]) =>
    postJsonMethod<{ ok: true; items: FieldSchema[] }>(
      `/api/projects/${projectId}/field-schemas`,
      { items },
      'PUT',
    ).then((r) => r.items),

  listAttachments: (projectId: ULID, wiId: ULID) =>
    getJson<{ ok: true; items: Attachment[] }>(
      `/api/projects/${projectId}/work-items/${wiId}/attachments`,
    ).then((r) => r.items),

  getAttachment: (projectId: ULID, wiId: ULID, aId: ULID) =>
    getJson<{ ok: true; attachment: Attachment }>(
      `/api/projects/${projectId}/work-items/${wiId}/attachments/${aId}`,
    ).then((r) => r.attachment),

  getAttachmentById: (projectId: ULID, aId: ULID) =>
    getJson<{ ok: true; attachment: Attachment }>(
      `/api/projects/${projectId}/attachments/${aId}`,
    ).then((r) => r.attachment),

  deleteAttachment: async (projectId: ULID, wiId: ULID, aId: ULID): Promise<void> => {
    const res = await fetch(
      `/api/projects/${projectId}/work-items/${wiId}/attachments/${aId}`,
      { method: 'DELETE' },
    );
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `delete attachment → ${res.status}`);
    }
  },

  moveWorkItem: async (
    projectId: ULID,
    wiId: ULID,
    version: number,
    input: WorkItemMoveInput,
  ): Promise<WorkItem> => {
    const res = await fetch(`/api/projects/${projectId}/work-items/${wiId}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, ...input }),
    });
    const data = (await res.json()) as
      | { ok: true; workItem: WorkItem }
      | { ok: false; error: string; current?: WorkItem };
    if (res.status === 409 && data.ok === false && data.current) {
      throw new WorkItemConflictError(data.current);
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data.ok === false ? data.error : `move → ${res.status}`);
    }
    return data.workItem;
  },
};
