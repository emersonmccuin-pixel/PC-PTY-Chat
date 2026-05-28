import type { Hono } from 'hono';
import type { ULID } from '@pc/domain';

import {
  browseFolder,
  BrowseError,
  createChildFolder,
  listDrives,
} from '../../services/fs-browse.ts';
import { probeFolder } from '../../services/fs-probe.ts';
import {
  FileNotFoundError,
  FilePathOutsideProjectError,
  getFilesTree,
  previewFile,
} from '../../services/files-tree.ts';

export interface FileRoutesDeps {
  projectFolderPath(projectId: ULID): string | null;
}

export function registerFileRoutes(app: Hono, deps: FileRoutesDeps): void {
  app.get('/api/fs/browse', (c) => {
    const path = c.req.query('path') ?? '';
    const gateRoot = c.req.query('gateRoot');
    const opts = gateRoot && gateRoot.trim() ? { roots: [gateRoot.trim()] } : {};
    try {
      return c.json({ ok: true, ...browseFolder(path, opts) });
    } catch (err) {
      if (err instanceof BrowseError) {
        const status = err.kind === 'forbidden' ? 403 : err.kind === 'not_found' ? 404 : 400;
        return c.json({ ok: false, error: err.message, kind: err.kind }, status);
      }
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.get('/api/fs/drives', (c) => {
    return c.json({ ok: true, drives: listDrives() });
  });

  app.post('/api/fs/mkdir', async (c) => {
    const body = await c.req.json<{ parentPath?: string; name?: string; gateRoot?: string }>();
    const parentPath = typeof body.parentPath === 'string' ? body.parentPath.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const gateRoot = typeof body.gateRoot === 'string' ? body.gateRoot.trim() : '';
    if (!parentPath) return c.json({ ok: false, error: 'parentPath required' }, 400);
    if (!name) return c.json({ ok: false, error: 'folder name required' }, 400);

    const opts = gateRoot ? { roots: [gateRoot] } : {};
    try {
      return c.json({ ok: true, ...createChildFolder(parentPath, name, opts) });
    } catch (err) {
      if (err instanceof BrowseError) {
        const status =
          err.kind === 'forbidden'
            ? 403
            : err.kind === 'not_found'
              ? 404
              : err.kind === 'already_exists'
                ? 409
                : 400;
        return c.json({ ok: false, error: err.message, kind: err.kind }, status);
      }
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.post('/api/fs/probe', async (c) => {
    const body = await c.req.json<{ path?: string }>();
    const raw = typeof body.path === 'string' ? body.path.trim() : '';
    if (!raw) return c.json({ ok: false, error: 'path required' }, 400);
    try {
      return c.json({ ok: true, probe: probeFolder(raw) });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
  });

  app.get('/api/projects/:projectId/files/tree', async (c) => {
    const id = c.req.param('projectId') as ULID;
    const folderPath = deps.projectFolderPath(id);
    if (!folderPath) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    try {
      const tree = await getFilesTree(folderPath);
      return c.json({ ok: true, tree });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.get('/api/projects/:projectId/files/preview', async (c) => {
    const id = c.req.param('projectId') as ULID;
    const folderPath = deps.projectFolderPath(id);
    if (!folderPath) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const relPath = c.req.query('path');
    if (typeof relPath !== 'string' || relPath.length === 0) {
      return c.json({ ok: false, error: 'path query param is required' }, 400);
    }
    try {
      const preview = await previewFile(folderPath, relPath);
      return c.json({ ok: true, preview });
    } catch (err) {
      if (err instanceof FilePathOutsideProjectError) {
        return c.json({ ok: false, error: err.message }, 400);
      }
      if (err instanceof FileNotFoundError) {
        return c.json({ ok: false, error: err.message }, 404);
      }
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });
}
