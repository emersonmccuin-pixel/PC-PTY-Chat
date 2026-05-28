import type { Hono } from 'hono';
import type { ULID } from '@pc/domain';

import { forwardTerminalInput } from '../../services/terminal-mode.ts';

export interface TransientSessionPty {
  on(event: 'raw', listener: (text: string) => void): unknown;
  on(event: 'state', listener: (state: string) => void): unknown;
  on(event: 'event', listener: (event: unknown) => void): unknown;
  on(event: 'jsonl-event', listener: (event: unknown) => void): unknown;
  on(
    event: 'exit',
    listener: (code: number | undefined, signal: string | undefined) => void,
  ): unknown;
  getState(): string;
  send(text: string): Promise<string | void> | string | void;
  interrupt(): void;
  writeRaw(bytes: string): boolean;
}

export interface TransientSessionsRuntime<TPty extends TransientSessionPty> {
  startAgentDesigner(): TPty;
  agentDesignerPty(): TPty | null;
  agentDesignerSession(): string | null;
  resizeAgentDesigner(cols: number, rows: number): void;
  endAgentDesigner(): void;

  startWorkflowBuilder(): TPty;
  workflowBuilderPty(): TPty | null;
  workflowBuilderSession(): string | null;
  resizeWorkflowBuilder(cols: number, rows: number): void;
  endWorkflowBuilder(): void;

  startSetupWizard(): TPty;
  setupWizardPty(): TPty | null;
  setupWizardSession(): string | null;
  resizeSetupWizard(cols: number, rows: number): void;
  endSetupWizard(): void;
}

export interface TransientSessionRoutesDeps<
  TPty extends TransientSessionPty,
  TRuntime extends TransientSessionsRuntime<TPty>,
> {
  resolveProject(projectId: string): TRuntime | null;
  broadcastTo(projectId: ULID, msg: unknown): void;
}

interface TransientSessionDescriptor<
  TPty extends TransientSessionPty,
  TRuntime extends TransientSessionsRuntime<TPty>,
> {
  path: string;
  wirePrefix: string;
  attachFlag: string;
  noSessionError: string;
  catchStartErrors: boolean;
  start(runtime: TRuntime): TPty;
  sessionId(runtime: TRuntime): string | null;
  pty(runtime: TRuntime): TPty | null;
  resize(runtime: TRuntime, cols: number, rows: number): void;
  end(runtime: TRuntime): void;
}

function attachTransientSessionHandlers<
  TPty extends TransientSessionPty,
  TRuntime extends TransientSessionsRuntime<TPty>,
>(
  deps: TransientSessionRoutesDeps<TPty, TRuntime>,
  descriptor: TransientSessionDescriptor<TPty, TRuntime>,
  projectId: ULID,
  session: TPty,
  sessionId: string | null,
): void {
  const flag = session as unknown as Record<string, boolean | undefined>;
  if (flag[descriptor.attachFlag]) return;
  let terminalSeq = 0;
  session.on('raw', (text: string) => {
    terminalSeq += 1;
    deps.broadcastTo(projectId, {
      type: `${descriptor.wirePrefix}-raw`,
      sessionId,
      terminalSeq,
      text,
    });
  });
  session.on('state', (state: string) =>
    deps.broadcastTo(projectId, {
      type: `${descriptor.wirePrefix}-state`,
      sessionId,
      state,
    }),
  );
  session.on('event', (event: unknown) =>
    deps.broadcastTo(projectId, {
      type: `${descriptor.wirePrefix}-event`,
      sessionId,
      event,
    }),
  );
  session.on('jsonl-event', (event: unknown) =>
    deps.broadcastTo(projectId, {
      type: `${descriptor.wirePrefix}-jsonl`,
      sessionId,
      event,
    }),
  );
  session.on('exit', (code: number | undefined, signal: string | undefined) => {
    deps.broadcastTo(projectId, {
      type: `${descriptor.wirePrefix}-exit`,
      sessionId,
      code,
      signal,
    });
  });
  flag[descriptor.attachFlag] = true;
}

function registerTransientSession<
  TPty extends TransientSessionPty,
  TRuntime extends TransientSessionsRuntime<TPty>,
>(
  app: Hono,
  deps: TransientSessionRoutesDeps<TPty, TRuntime>,
  descriptor: TransientSessionDescriptor<TPty, TRuntime>,
): void {
  const resolveRuntime = (projectId: string) => deps.resolveProject(projectId);

  app.post(`/api/projects/:projectId/${descriptor.path}/start`, (c) => {
    const id = c.req.param('projectId') as ULID;
    const runtime = resolveRuntime(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const start = () => {
      const session = descriptor.start(runtime);
      const sessionId = descriptor.sessionId(runtime);
      attachTransientSessionHandlers(deps, descriptor, id, session, sessionId);
      deps.broadcastTo(id, {
        type: `${descriptor.wirePrefix}-state`,
        sessionId,
        state: session.getState(),
      });
      return c.json({ ok: true, state: session.getState(), sessionId });
    };
    if (!descriptor.catchStartErrors) return start();
    try {
      return start();
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.post(`/api/projects/:projectId/${descriptor.path}/send`, async (c) => {
    const id = c.req.param('projectId') as ULID;
    const runtime = resolveRuntime(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const session = descriptor.pty(runtime);
    if (!session) return c.json({ ok: false, error: descriptor.noSessionError }, 409);
    const body = await c.req.json<{ text?: string }>();
    if (typeof body.text !== 'string' || body.text === '') {
      return c.json({ ok: false, error: 'text required' }, 400);
    }
    session.send(body.text);
    return c.json({ ok: true });
  });

  app.post(`/api/projects/:projectId/${descriptor.path}/interrupt`, (c) => {
    const id = c.req.param('projectId') as ULID;
    const runtime = resolveRuntime(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    descriptor.pty(runtime)?.interrupt();
    return c.json({ ok: true });
  });

  app.post(`/api/projects/:projectId/${descriptor.path}/terminal-input`, async (c) => {
    const id = c.req.param('projectId') as ULID;
    const runtime = resolveRuntime(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const body = await c.req.json<{ data?: unknown }>().catch(() => ({}) as { data?: unknown });
    const result = forwardTerminalInput(
      { ptySession: () => descriptor.pty(runtime) },
      body.data,
    );
    if (!result.ok) return c.json({ ok: false, error: result.error, status: result.status }, 400);
    return c.json({ ok: true, bytesWritten: result.bytesWritten });
  });

  app.post(`/api/projects/:projectId/${descriptor.path}/resize`, async (c) => {
    const id = c.req.param('projectId') as ULID;
    const runtime = resolveRuntime(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const body = await c.req.json<{ cols?: unknown; rows?: unknown }>().catch(
      () => ({}) as { cols?: unknown; rows?: unknown },
    );
    if (typeof body.cols === 'number' && typeof body.rows === 'number') {
      descriptor.resize(runtime, body.cols, body.rows);
    }
    return c.json({ ok: true });
  });

  app.delete(`/api/projects/:projectId/${descriptor.path}`, (c) => {
    const id = c.req.param('projectId') as ULID;
    const runtime = resolveRuntime(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    descriptor.end(runtime);
    return c.json({ ok: true });
  });
}

export function registerTransientSessionRoutes<
  TPty extends TransientSessionPty,
  TRuntime extends TransientSessionsRuntime<TPty>,
>(
  app: Hono,
  deps: TransientSessionRoutesDeps<TPty, TRuntime>,
): void {
  registerTransientSession(app, deps, {
    path: 'agent-designer',
    wirePrefix: 'agent-designer',
    attachFlag: '__pcAgentDesignerAttached',
    noSessionError: 'no agent-designer session',
    catchStartErrors: true,
    start: (runtime) => runtime.startAgentDesigner(),
    sessionId: (runtime) => runtime.agentDesignerSession(),
    pty: (runtime) => runtime.agentDesignerPty(),
    resize: (runtime, cols, rows) => runtime.resizeAgentDesigner(cols, rows),
    end: (runtime) => runtime.endAgentDesigner(),
  });
  registerTransientSession(app, deps, {
    path: 'workflow-builder',
    wirePrefix: 'workflow-builder',
    attachFlag: '__pcWorkflowBuilderAttached',
    noSessionError: 'no workflow-builder session',
    catchStartErrors: true,
    start: (runtime) => runtime.startWorkflowBuilder(),
    sessionId: (runtime) => runtime.workflowBuilderSession(),
    pty: (runtime) => runtime.workflowBuilderPty(),
    resize: (runtime, cols, rows) => runtime.resizeWorkflowBuilder(cols, rows),
    end: (runtime) => runtime.endWorkflowBuilder(),
  });
  registerTransientSession(app, deps, {
    path: 'setup-wizard',
    wirePrefix: 'setup-wizard',
    attachFlag: '__pcSetupWizardAttached',
    noSessionError: 'no setup-wizard session',
    catchStartErrors: false,
    start: (runtime) => runtime.startSetupWizard(),
    sessionId: (runtime) => runtime.setupWizardSession(),
    pty: (runtime) => runtime.setupWizardPty(),
    resize: (runtime, cols, rows) => runtime.resizeSetupWizard(cols, rows),
    end: (runtime) => runtime.endSetupWizard(),
  });
}
