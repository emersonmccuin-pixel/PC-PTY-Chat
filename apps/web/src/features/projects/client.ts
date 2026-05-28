import { getJson, postJson, postJsonMethod } from '@/api/http';

export type ULID = string;

export interface Stage {
  id: string;
  name: string;
  order: number;
  isDone?: boolean;
  isCancelled?: boolean;
  isNew?: boolean;
}

export interface ProjectSettings {
  cancelledVisibility: 'use-global' | 'force-visible' | 'force-hidden';
}

export interface Project {
  id: ULID;
  slug: string;
  name: string;
  stages: Stage[];
  folderPath: string;
  gitRemote: string | null;
  settings: ProjectSettings;
}

export type CreateProjectMode = 'init-empty' | 'init-in-place' | 'attach-to-git';

export const projectsApi = {
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

  project: (projectId: ULID) => getJson<Project>(`/api/projects/${projectId}`),

  updateProject: (projectId: ULID, patch: { name?: string; git_remote?: string | null }) =>
    postJsonMethod<{ ok: true; project: Project }>(
      `/api/projects/${projectId}`,
      patch,
      'PATCH',
    ).then((r) => r.project),

  softDeleteProject: async (projectId: ULID): Promise<void> => {
    const res = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `delete → ${res.status}`);
    }
  },

  deleteProjectFiles: async (projectId: ULID): Promise<string[]> => {
    const res = await fetch(`/api/projects/${projectId}/files`, { method: 'DELETE' });
    const data = (await res.json()) as { ok?: boolean; error?: string; removed?: string[] };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `delete files → ${res.status}`);
    }
    return data.removed ?? [];
  },

  revealProject: async (projectId: ULID): Promise<void> => {
    const res = await fetch(`/api/projects/${projectId}/reveal`, { method: 'POST' });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `reveal → ${res.status}`);
    }
  },

  reorderProjects: (orderedIds: ULID[]) =>
    postJsonMethod<{ ok: true; projects: Project[] }>(
      '/api/projects/reorder',
      { orderedIds },
      'PATCH',
    ).then((r) => r.projects),
};
