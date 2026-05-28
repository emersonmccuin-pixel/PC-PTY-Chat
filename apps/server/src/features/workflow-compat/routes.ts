import type { Hono } from 'hono';
import type { ULID, WorkflowV2 } from '@pc/domain';
import {
  dismissFailedRun as defaultDismissFailedRun,
  listFailedRunDismissalsForProject as defaultListFailedRunDismissalsForProject,
  workflowRunsV2Repo as defaultWorkflowRunsV2Repo,
} from '@pc/db';

type WorkflowReviewDecision =
  | { kind: 'approve' }
  | { kind: 'reject'; notes?: string };

export interface WorkflowCompatRuntime {
  project: { id: ULID };
  setWorkflowBuilderDraft(sessionId: string, def: WorkflowV2.Workflow): void;
  getWorkflowBuilderDraft(sessionId: string): WorkflowV2.Workflow | undefined;
  listV2Workflows(): {
    valid: Array<{ workflow: WorkflowV2.Workflow }>;
    invalid: Array<{ slug: string; errors: unknown }>;
  };
  findV2WorkflowBySlug(slug: string): {
    workflow: WorkflowV2.Workflow;
    yamlText: string;
  } | null;
  applyV2Review(
    runId: ULID,
    nodeId: string,
    decision: WorkflowReviewDecision,
  ): Promise<WorkflowV2.WorkflowRunStatus | null>;
}

export interface WorkflowCompatRouteDeps {
  resolveProject(projectId: string): WorkflowCompatRuntime | null;
  broadcastTo(projectId: ULID, msg: unknown): void;
  now?: () => number;
  listFailedRunDismissalsForProject?: typeof defaultListFailedRunDismissalsForProject;
  dismissFailedRun?: typeof defaultDismissFailedRun;
  workflowRunsV2Repo?: Pick<
    typeof defaultWorkflowRunsV2Repo,
    'getRunForProject' | 'listEvents' | 'listRunsByProject'
  >;
}

export function registerWorkflowCompatRoutes(app: Hono, deps: WorkflowCompatRouteDeps): void {
  const services = {
    now: deps.now ?? Date.now,
    listFailedRunDismissalsForProject:
      deps.listFailedRunDismissalsForProject ?? defaultListFailedRunDismissalsForProject,
    dismissFailedRun: deps.dismissFailedRun ?? defaultDismissFailedRun,
    workflowRunsV2Repo: deps.workflowRunsV2Repo ?? defaultWorkflowRunsV2Repo,
  };

  /** Section 19.9 -- stash an in-progress v2 workflow-builder draft. */
  app.post('/api/projects/:projectId/workflow-builder/draft', async (c) => {
    const id = c.req.param('projectId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const payload = await c.req.json<{ sessionId?: string; def?: unknown }>();
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    if (!sessionId) return c.json({ ok: false, error: 'sessionId required' }, 400);
    if (!payload.def || typeof payload.def !== 'object') {
      return c.json({ ok: false, error: 'def required' }, 400);
    }
    const rawDef = payload.def as Record<string, unknown>;
    const wfId = typeof rawDef.id === 'string' && rawDef.id ? rawDef.id : '';
    if (!wfId) return c.json({ ok: false, error: 'def.id required' }, 400);
    const def = payload.def as unknown as WorkflowV2.Workflow;
    runtime.setWorkflowBuilderDraft(sessionId, def);
    deps.broadcastTo(id, { type: 'workflow-builder-draft', sessionId, def });
    return c.json({ ok: true });
  });

  /** Section 19.9 -- read the current draft for a workflow-builder session. */
  app.get('/api/projects/:projectId/workflow-builder/draft/:sessionId', (c) => {
    const id = c.req.param('projectId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const sessionId = c.req.param('sessionId');
    const def = runtime.getWorkflowBuilderDraft(sessionId);
    return c.json({ ok: true, def: def ?? null });
  });

  app.get('/api/projects/:projectId/failed-run-dismissals', (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const runIds = services.listFailedRunDismissalsForProject(id as ULID);
    return c.json({ runIds });
  });

  app.post('/api/projects/:projectId/workflow-runs/:runId/dismiss', (c) => {
    const id = c.req.param('projectId');
    const runId = c.req.param('runId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const run = services.workflowRunsV2Repo.getRunForProject(runId as never, runtime.project.id);
    if (!run) return c.json({ ok: false, error: `unknown run: ${runId}` }, 404);
    const dismissedAt = services.dismissFailedRun(runId as ULID, services.now());
    return c.json({ ok: true, dismissedAt });
  });

  app.get('/api/projects/:projectId/workflow-v2/definitions', (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const state = runtime.listV2Workflows();
    return c.json({
      ok: true,
      valid: state.valid.map((e) => ({
        id: e.workflow.id,
        name: e.workflow.name,
        workflow: e.workflow,
      })),
      invalid: state.invalid.map((e) => ({ fileName: `${e.slug}.yaml`, errors: e.errors })),
    });
  });

  app.get('/api/projects/:projectId/workflow-v2/definitions/:wfId', (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const entry = runtime.findV2WorkflowBySlug(c.req.param('wfId'));
    if (!entry) return c.json({ ok: false, error: 'workflow not found' }, 404);
    return c.json({ ok: true, workflow: entry.workflow, yamlText: entry.yamlText });
  });

  app.get('/api/projects/:projectId/workflow-v2/runs/:runId', (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const run = services.workflowRunsV2Repo.getRunForProject(
      c.req.param('runId') as never,
      runtime.project.id,
    );
    if (!run) return c.json({ ok: false, error: 'run not found' }, 404);
    return c.json({ ok: true, run, events: services.workflowRunsV2Repo.listEvents(run.id) });
  });

  app.get('/api/projects/:projectId/workflow-v2/runs', (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const runs = services.workflowRunsV2Repo.listRunsByProject(runtime.project.id);
    return c.json({ ok: true, runs });
  });

  app.post('/api/projects/:projectId/workflow-v2/review', async (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const body = await c.req.json<{
      runId?: string;
      nodeId?: string;
      decision?: string;
      notes?: string;
    }>();
    if (!body.runId || !body.nodeId || (body.decision !== 'approve' && body.decision !== 'reject')) {
      return c.json({ ok: false, error: 'require { runId, nodeId, decision: approve|reject }' }, 400);
    }
    try {
      const decision =
        body.decision === 'reject'
          ? { kind: 'reject' as const, ...(body.notes ? { notes: body.notes } : {}) }
          : { kind: 'approve' as const };
      const status = await runtime.applyV2Review(body.runId as ULID, body.nodeId, decision);
      if (status === null) return c.json({ ok: false, error: 'run not found' }, 404);
      return c.json({ ok: true, status });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
  });
}
