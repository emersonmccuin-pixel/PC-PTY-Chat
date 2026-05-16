// Typed fetch helpers for the apps/server HTTP surface.
// Wire shapes mirror packages/domain — kept inline here (no @pc/domain dep on the
// browser bundle) so the web package stays import-cycle-free.

export type WorkItemStatus = 'pending' | 'in-progress' | 'blocked' | 'complete' | 'failed';

export interface Stage {
  id: string;
  name: string;
  order: number;
}

export interface Project {
  id: string;
  name: string;
  stages: Stage[];
}

export interface WorkItem {
  id: string;
  title: string;
  body?: string;
  stageId: string;
  status?: WorkItemStatus;
  statusReason?: string;
  fields: Record<string, unknown>;
  history: unknown[];
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T & { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) {
    throw new Error(data.error ?? `${path} → ${res.status}`);
  }
  return data;
}

export const api = {
  project: () => getJson<Project>('/api/project'),
  workItems: () => getJson<WorkItem[]>('/api/work-items'),
  createWorkItem: (title: string, stageId: string, body?: string) =>
    postJson<{ ok: true; workItem: WorkItem }>('/api/work-items/create', {
      title,
      stageId,
      body,
    }),
  moveWorkItem: (id: string, toStage: string) =>
    postJson<{ ok: true; workItem: WorkItem }>('/api/work-items/move', { id, toStage }),
};
