import { getJson, postJsonMethod } from '@/api/http';
import type { ULID } from '@/features/projects/types';
import type { CustomCommand, MemoryFile, MemoryScope } from './types';

export * from './types';

export const projectContextApi = {
  getClaudeMdStatus: async (
    projectId: ULID,
  ): Promise<{ exists: boolean; empty: boolean }> => {
    const res = await fetch(`/api/projects/${projectId}/claude-md-status`);
    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      exists?: boolean;
      empty?: boolean;
    };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `claude-md-status → ${res.status}`);
    }
    return { exists: data.exists === true, empty: data.empty === true };
  },

  listCustomCommands: (projectId: ULID) =>
    getJson<{ ok: true; commands: CustomCommand[] }>(
      `/api/projects/${projectId}/commands`,
    ).then((r) => r.commands),

  getMemoryFile: (projectId: ULID, scope: MemoryScope) =>
    getJson<{ ok: true; file: MemoryFile }>(
      `/api/projects/${projectId}/memory/${scope}`,
    ).then((r) => r.file),

  putMemoryFile: (projectId: ULID, scope: MemoryScope, content: string) =>
    postJsonMethod<{ ok: true; file: MemoryFile }>(
      `/api/projects/${projectId}/memory/${scope}`,
      { content },
      'PUT',
    ).then((r) => r.file),
};
