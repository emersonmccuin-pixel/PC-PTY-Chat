import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Hono } from 'hono';
import type { Project, ULID } from '@pc/domain';
import {
  getProjectById,
  listProjects,
  reorderProjects,
  softDeleteProject,
  updateProjectMeta,
} from '@pc/db';

import type {
  CreateProjectFlowInput,
  CreateProjectMode,
} from '../../services/project-create.ts';

export interface ProjectRoutesRuntime {
  project: { id: ULID };
}

export interface ProjectRoutesDeps {
  createProject(input: CreateProjectFlowInput): Promise<Project>;
  refreshProject(project: Project): void;
  removeProject(projectId: ULID): void;
  resolveProject(projectId: string): ProjectRoutesRuntime | null;
  revealProjectFolder?(folderPath: string): void;
}

function findProjectIncludingDeleted(projectId: ULID): Project | undefined {
  return getProjectById(projectId) ?? listProjects({ includeDeleted: true }).find((p) => p.id === projectId);
}

export function revealCommand(path: string): { cmd: string; args: string[] } {
  if (process.platform === 'win32') return { cmd: 'explorer.exe', args: [path] };
  if (process.platform === 'darwin') return { cmd: 'open', args: [path] };
  return { cmd: 'xdg-open', args: [path] };
}

function defaultRevealProjectFolder(folderPath: string): void {
  const { cmd, args } = revealCommand(folderPath);
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}

export function registerProjectRoutes(app: Hono, deps: ProjectRoutesDeps): void {
  app.get('/api/projects', (c) => {
    const includeDeleted = c.req.query('include_deleted') === '1';
    return c.json({ projects: listProjects({ includeDeleted }) });
  });

  app.patch('/api/projects/reorder', async (c) => {
    const body = await c.req.json<{ orderedIds?: unknown }>();
    if (!Array.isArray(body.orderedIds) || !body.orderedIds.every((v) => typeof v === 'string')) {
      return c.json({ ok: false, error: 'orderedIds must be an array of strings' }, 400);
    }
    try {
      reorderProjects(body.orderedIds as ULID[]);
      return c.json({ ok: true, projects: listProjects() });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.post('/api/projects', async (c) => {
    const body = await c.req.json<{
      name?: string;
      folder_path?: string;
      mode?: CreateProjectMode;
      git_remote?: string | null;
    }>();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const folderPath = typeof body.folder_path === 'string' ? body.folder_path.trim() : '';
    const mode = body.mode;
    if (
      !name ||
      !folderPath ||
      (mode !== 'init-empty' && mode !== 'init-in-place' && mode !== 'attach-to-git')
    ) {
      return c.json({ ok: false, error: 'name, folder_path, and mode required' }, 400);
    }
    try {
      const project = await deps.createProject({
        name,
        folderPath,
        mode,
        gitRemote: body.git_remote ?? null,
      });
      return c.json({ ok: true, project }, 201);
    } catch (err) {
      const msg = (err as Error).message;
      const is400 =
        /required$|^invalid mode|^folder is not empty|^folder is already a git repo/.test(msg);
      return c.json({ ok: false, error: msg }, is400 ? 400 : 500);
    }
  });

  app.patch('/api/projects/:projectId', async (c) => {
    const id = c.req.param('projectId') as ULID;
    const body = await c.req.json<{ name?: string; git_remote?: string | null }>();
    const patch: { name?: string; gitRemote?: string | null } = {};
    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (!name) return c.json({ ok: false, error: 'name cannot be empty' }, 400);
      patch.name = name;
    }
    if (body.git_remote !== undefined) {
      patch.gitRemote = body.git_remote === null ? null : String(body.git_remote).trim() || null;
    }
    try {
      const updated = updateProjectMeta(id, patch);
      if (!updated) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
      deps.refreshProject(updated);
      return c.json({ ok: true, project: updated });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.delete('/api/projects/:projectId', (c) => {
    const id = c.req.param('projectId') as ULID;
    const deleted = softDeleteProject(id);
    if (!deleted) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    deps.removeProject(id);
    return c.json({ ok: true, project: deleted });
  });

  app.delete('/api/projects/:projectId/files', (c) => {
    const id = c.req.param('projectId') as ULID;
    const project = findProjectIncludingDeleted(id);
    if (!project) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);

    deps.removeProject(id);
    const folder = project.folderPath;
    const removed: string[] = [];
    const skipped: { dir: string; reason: string }[] = [];
    for (const sub of ['.project-companion', '.claude']) {
      const target = resolve(folder, sub);
      if (!existsSync(target)) continue;
      if (sub === '.claude') {
        const marker = resolve(target, '.pc-managed');
        if (!existsSync(marker)) {
          skipped.push({
            dir: sub,
            reason: 'no .pc-managed marker — PC did not create this directory',
          });
          continue;
        }
      }
      try {
        rmSync(target, { recursive: true, force: true });
        removed.push(sub);
      } catch (err) {
        return c.json({ ok: false, error: `failed to remove ${sub}: ${(err as Error).message}` }, 500);
      }
    }
    return c.json({ ok: true, removed, skipped });
  });

  app.post('/api/projects/:projectId/reveal', (c) => {
    const id = c.req.param('projectId') as ULID;
    const project = findProjectIncludingDeleted(id);
    if (!project) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const folder = project.folderPath;
    if (!existsSync(folder)) {
      return c.json({ ok: false, error: `folder does not exist on disk: ${folder}` }, 404);
    }
    try {
      (deps.revealProjectFolder ?? defaultRevealProjectFolder)(folder);
    } catch (err) {
      return c.json({ ok: false, error: `failed to reveal: ${(err as Error).message}` }, 500);
    }
    return c.json({ ok: true });
  });

}

export function registerProjectDetailRoute(app: Hono, deps: Pick<ProjectRoutesDeps, 'resolveProject'>): void {
  app.get('/api/projects/:projectId', (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const project = getProjectById(runtime.project.id);
    if (!project) return c.json({ ok: false, error: `project disappeared: ${id}` }, 404);
    return c.json(project);
  });
}
