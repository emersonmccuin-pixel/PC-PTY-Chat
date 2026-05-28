import { getJson, postJson } from '@/api/http';
import type { ULID } from '@/features/projects/types';
import type {
  BrowseEntry,
  BrowseResult,
  FilePreview,
  FileTreeNode,
  FolderProbe,
} from './types';

export * from './types';

export const filesApi = {
  listDrives: async (): Promise<string[]> => {
    const res = await fetch('/api/fs/drives');
    const data = (await res.json()) as { ok?: boolean; drives?: string[]; error?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `drives → ${res.status}`);
    }
    return data.drives ?? [];
  },

  browseFolder: async (path?: string, gateRoot?: string): Promise<BrowseResult> => {
    const qs = new URLSearchParams();
    if (path) qs.set('path', path);
    if (gateRoot) qs.set('gateRoot', gateRoot);
    const tail = qs.toString();
    const res = await fetch(`/api/fs/browse${tail ? `?${tail}` : ''}`);
    const data = (await res.json()) as
      | { ok: true; path: string; parent: string | null; entries: BrowseEntry[] }
      | { ok: false; error: string; kind?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.ok === false ? data.error : `browse → ${res.status}`);
    }
    return { path: data.path, parent: data.parent, entries: data.entries };
  },

  createFolder: async (input: {
    parentPath: string;
    name: string;
    gateRoot?: string;
  }): Promise<BrowseResult> => {
    const data = await postJson<{
      ok: true;
      path: string;
      parent: string | null;
      entries: BrowseEntry[];
    }>('/api/fs/mkdir', input);
    return { path: data.path, parent: data.parent, entries: data.entries };
  },

  probeFolder: async (path: string): Promise<FolderProbe> => {
    const r = await postJson<{ ok: true; probe: FolderProbe }>('/api/fs/probe', { path });
    return r.probe;
  },

  getFilesTree: (projectId: ULID) =>
    getJson<{ ok: true; tree: FileTreeNode[] }>(
      `/api/projects/${projectId}/files/tree`,
    ).then((r) => r.tree),

  previewFile: async (projectId: ULID, path: string): Promise<FilePreview> => {
    const res = await fetch(
      `/api/projects/${projectId}/files/preview?path=${encodeURIComponent(path)}`,
    );
    const data = (await res.json()) as
      | { ok: true; preview: FilePreview }
      | { ok: false; error: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.ok === false ? data.error : `preview → ${res.status}`);
    }
    return data.preview;
  },
};
