import type { Hono } from 'hono';
import type { ULID } from '@pc/domain';
import type { WorktreeEntry } from '@pc/runtime';

export interface WorktreeRegistry {
  updatedAt: string;
  worktrees: WorktreeEntry[];
}

export interface WorktreeRouteService {
  readCached(): WorktreeRegistry;
  create(name: string): Promise<WorktreeEntry>;
  destroy(target: string, force?: boolean): Promise<void>;
}

export interface WorktreeRoutesRuntime {
  project: { id: ULID };
  worktrees(): WorktreeRouteService;
}

export interface WorktreeRouteDeps {
  resolveProject(projectId: string): WorktreeRoutesRuntime | null;
}

export function registerWorktreeRoutes(app: Hono, deps: WorktreeRouteDeps): void {
  app.get('/api/projects/:projectId/worktrees', (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    return c.json(runtime.worktrees().readCached());
  });

  app.post('/api/projects/:projectId/worktrees/create', async (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const body = await c.req.json<{ name?: string }>();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return c.json({ ok: false, error: 'name required' }, 400);
    try {
      const entry = await runtime.worktrees().create(name);
      return c.json({ ok: true, entry });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.post('/api/projects/:projectId/worktrees/destroy', async (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const body = await c.req.json<{ target?: string; force?: boolean }>();
    const target = typeof body.target === 'string' ? body.target.trim() : '';
    if (!target) return c.json({ ok: false, error: 'target required' }, 400);
    try {
      await runtime.worktrees().destroy(target, body.force === true);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });
}
