// Section 34.3 — Quick Tasks HTTP routes.
//
// Surfaces the cross-project capture verbs for both MCP tools
// (`pc_create_quick_task` / `pc_list_quick_tasks` /
// `pc_list_quick_tasks_for_project`) and the upcoming chrome quick-add button
// (34.7) which calls the HTTP path directly. All routes are project-agnostic
// at the URL level — the server looks up the singleton Quick Tasks project
// by `kind` and operates on its work items.
//
// Why a dedicated module: the existing per-project work-items endpoints work
// fine internally, but routing "any orchestrator can write to Quick Tasks
// from any project" through the per-project path would force callers to know
// the Quick Tasks project id up front. A top-level `/api/quick-tasks` is the
// natural shape.

import type { Context, Hono } from 'hono';
import type { ULID, WorkItem } from '@pc/domain';
import {
  findQuickTasksProject,
  listQuickTasksTaggedTo,
  listWorkItems,
} from '@pc/db';

import type { ProjectRegistry } from '../services/project-registry.ts';
import { FieldValidationError, UnknownStageError } from '../services/work-item.ts';

export interface QuickTasksRouteDeps {
  registry: ProjectRegistry;
}

/** Find the Quick Tasks project's intake stage id. Returns null when the
 *  project hasn't been seeded yet (boot-time seed failure) or has no stages. */
function findIntakeStage(stages: Array<{ id: string; order?: number; isNew?: boolean }>): string | null {
  const sorted = [...stages].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return sorted.find((s) => s.isNew)?.id ?? sorted[0]?.id ?? null;
}

export function registerQuickTasksRoutes(app: Hono, deps: QuickTasksRouteDeps): void {
  /** GET /api/quick-tasks — Quick Tasks project metadata + counts. The chrome
   *  quick-add button's badge count (34.7) reads this; MCP doesn't need it.
   *  Returns 404 if the boot-time seed failed and no row exists. */
  app.get('/api/quick-tasks', (c: Context) => {
    const project = findQuickTasksProject();
    if (!project) {
      return c.json(
        { ok: false, error: 'Quick Tasks project not found (boot seed failed?)' },
        404,
      );
    }
    const items = listWorkItems(project.id);
    const openCount = items.filter((wi) => wi.status === 'pending' || wi.status === 'in-progress').length;
    return c.json({
      ok: true,
      project: { id: project.id, name: project.name, slug: project.slug, stages: project.stages },
      openCount,
      totalCount: items.length,
    });
  });

  /** GET /api/quick-tasks/list?status=&taggedProjectId=&dueBefore=
   *  Filtered list. All filters are optional.
   *  - `status`: 'open' (pending+in-progress), 'complete', 'all'. Default 'open'.
   *  - `taggedProjectId`: ULID, '' (empty string) for "untagged only", omitted for "any".
   *  - `dueBefore`: ISO date string; matches rows whose `fields.dueDate` is on or
   *    before that date. Currently unused by v1 callers but reserved for the
   *    Today / Overdue filter chips (34.8). */
  app.get('/api/quick-tasks/list', (c: Context) => {
    const project = findQuickTasksProject();
    if (!project) {
      return c.json({ ok: false, error: 'Quick Tasks project not found' }, 404);
    }
    const q = c.req.query();
    const statusFilter = q.status ?? 'open';
    const taggedProjectId = q.taggedProjectId;
    const dueBefore = q.dueBefore;
    let items = listWorkItems(project.id);
    if (statusFilter === 'open') {
      items = items.filter((wi) => wi.status === 'pending' || wi.status === 'in-progress');
    } else if (statusFilter === 'complete') {
      items = items.filter((wi) => wi.status === 'complete');
    }
    if (taggedProjectId !== undefined) {
      if (taggedProjectId === '') {
        items = items.filter((wi) => wi.taggedProjectId === null);
      } else {
        items = items.filter((wi) => wi.taggedProjectId === taggedProjectId);
      }
    }
    if (dueBefore !== undefined) {
      const cutoff = new Date(dueBefore).getTime();
      if (Number.isFinite(cutoff)) {
        items = items.filter((wi) => {
          const due = wi.fields.dueDate;
          if (typeof due !== 'string') return false;
          const t = new Date(due).getTime();
          return Number.isFinite(t) && t <= cutoff;
        });
      }
    }
    return c.json({ ok: true, items });
  });

  /** GET /api/quick-tasks/for-project/:projectId — list quick tasks tagged
   *  to the given project. Lets a regular project's PM mention them in
   *  grounding ("you've also got 3 quick tasks for this project"). Indexed
   *  via the `work_items_tagged_project_idx` partial index. */
  app.get('/api/quick-tasks/for-project/:projectId', (c: Context) => {
    const taggedProjectId = c.req.param('projectId') as ULID;
    const project = findQuickTasksProject();
    if (!project) {
      return c.json({ ok: false, error: 'Quick Tasks project not found' }, 404);
    }
    const items: WorkItem[] = listQuickTasksTaggedTo(project.id, taggedProjectId);
    return c.json({ ok: true, items });
  });

  /** POST /api/quick-tasks — capture a quick task. Body: { title, body?,
   *  taggedProjectId? }. Lands in the Quick Tasks project's intake stage
   *  (`is_new`). Returns the new WorkItem. Used by MCP `pc_create_quick_task`
   *  AND by the chrome quick-add button. */
  app.post('/api/quick-tasks', async (c: Context) => {
    const project = findQuickTasksProject();
    if (!project) {
      return c.json({ ok: false, error: 'Quick Tasks project not found' }, 404);
    }
    const body = await c.req.json<{
      title?: string;
      body?: string;
      taggedProjectId?: string | null;
    }>();
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return c.json({ ok: false, error: 'title required' }, 400);

    const intakeStage = findIntakeStage(project.stages);
    if (!intakeStage) {
      return c.json({ ok: false, error: 'Quick Tasks project has no stages' }, 500);
    }

    const runtime = deps.registry.get(project.id) ?? deps.registry.ensure(project.id);
    if (!runtime) {
      return c.json({ ok: false, error: 'Quick Tasks runtime not registered' }, 500);
    }

    try {
      const workItem = runtime.workItemService().create({
        title,
        stageId: intakeStage,
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.taggedProjectId !== undefined
          ? { taggedProjectId: body.taggedProjectId as ULID | null }
          : {}),
      });
      return c.json({ ok: true, workItem });
    } catch (err) {
      if (err instanceof FieldValidationError) {
        return c.json({ ok: false, error: err.message, errors: err.errors }, 400);
      }
      if (err instanceof UnknownStageError) {
        return c.json({ ok: false, error: err.message }, 400);
      }
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });
}
