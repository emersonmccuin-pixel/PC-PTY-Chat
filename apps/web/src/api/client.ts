// Typed fetch helpers for the apps/server HTTP surface.
// Wire shapes mirror packages/domain — kept inline here (no @pc/domain dep on the
// browser bundle) so the web package stays import-cycle-free.

export type ULID = string;

export type WorkItemStatus = 'pending' | 'in-progress' | 'blocked' | 'complete' | 'failed';

export interface Stage {
  id: string;
  name: string;
  order: number;
}

export interface Project {
  id: ULID;
  slug: string;
  name: string;
  stages: Stage[];
  folderPath: string;
  gitRemote: string | null;
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

// ── Filesystem (folder picker) ─────────────────────────────────────────────

export interface BrowseEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isHidden: boolean;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
}

export interface FolderProbe {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  hasFiles: boolean;
  fileCount: number;
  isGitRepo: boolean;
}

export type CreateProjectMode = 'init-empty' | 'init-in-place';

export const api = {
  listProjects: () =>
    getJson<{ projects: Project[] }>('/api/projects').then((r) => r.projects),

  createProject: (input: {
    name: string;
    folder_path: string;
    mode: CreateProjectMode;
    git_remote?: string | null;
  }) =>
    postJson<{ ok: true; project: Project }>('/api/projects', input).then(
      (r) => r.project,
    ),

  browseFolder: async (path?: string): Promise<BrowseResult> => {
    const qs = path ? `?path=${encodeURIComponent(path)}` : '';
    const res = await fetch(`/api/fs/browse${qs}`);
    const data = (await res.json()) as
      | { ok: true; path: string; parent: string | null; entries: BrowseEntry[] }
      | { ok: false; error: string; kind?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.ok === false ? data.error : `browse → ${res.status}`);
    }
    return { path: data.path, parent: data.parent, entries: data.entries };
  },

  probeFolder: async (path: string): Promise<FolderProbe> => {
    const r = await postJson<{ ok: true; probe: FolderProbe }>('/api/fs/probe', { path });
    return r.probe;
  },

  // Per-project endpoints (Q7+ consumers).
  project: (projectId: ULID) => getJson<Project>(`/api/projects/${projectId}`),
  workItems: (projectId: ULID) =>
    getJson<{ workItems: WorkItem[] }>(`/api/projects/${projectId}/work-items`).then(
      (r) => r.workItems,
    ),
  createWorkItem: (projectId: ULID, title: string, stageId: string, body?: string) =>
    postJson<{ ok: true; workItem: WorkItem }>(
      `/api/projects/${projectId}/work-items/create`,
      { title, stageId, body },
    ),
  moveWorkItem: (projectId: ULID, id: string, toStage: string) =>
    postJson<{ ok: true; workItem: WorkItem }>(
      `/api/projects/${projectId}/work-items/move`,
      { id, toStage },
    ),
};
