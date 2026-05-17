import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

import type { ULID } from '@pc/domain';
import { runMigrations } from '@pc/db';

import { AgentLibrary, defaultLibraryDir } from './services/agent-library.ts';
import { ChannelServer } from './services/channel-server.ts';
import { ProjectRegistry } from './services/project-registry.ts';
import type { ProjectRuntime } from './services/project-runtime.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// apps/server/src/index.ts → trunk root is three levels up.
const ROOT = resolve(__dirname, '..', '..', '..');
const PUBLIC = resolve(ROOT, 'apps', 'web', 'dist');
const DATA = resolve(ROOT, 'data');
const TEMPLATES = resolve(ROOT, 'templates');

const PORT = Number(process.env.PORT ?? 4040);
const CHANNEL_PORT = Number(process.env.CHANNEL_PORT ?? 8788);

runMigrations();

// Agent library — first-run seed from templates/.claude/agents/ into
// ~/.project-companion/agents/. Per-project agent copies clone from here.
const agentLibrary = new AgentLibrary(defaultLibraryDir(), resolve(TEMPLATES, '.claude', 'agents'));
agentLibrary.bootstrap();

// Per-project WS subscriber map. P14 tags broadcasts with `projectId` so the UI
// can route events to its active project; for P4 we route at the server by
// keeping one subscriber set per project.
const subscribers = new Map<ULID, Set<WebSocket>>();

function broadcastTo(projectId: ULID, msg: unknown): void {
  const set = subscribers.get(projectId);
  if (!set) return;
  const data = JSON.stringify(msg);
  for (const c of set) {
    if (c.readyState === c.OPEN) c.send(data);
  }
}

const projectRegistry = new ProjectRegistry({
  dataDir: DATA,
  channelPort: CHANNEL_PORT,
  broadcastFor: (projectId) => (event) => broadcastTo(projectId, event),
});
projectRegistry.loadAll();

// Multiplexed channel server on :8788. Per-project channel-stdio children
// register via WS; external webhooks POST /channel/<slug>/<source>; we route
// to the matching child + emit a UI broadcast tagged with projectId.
const channelServer = new ChannelServer({
  port: CHANNEL_PORT,
  allowedSenders: new Set((process.env.CHANNEL_ALLOWED_SENDERS ?? 'test').split(',').filter(Boolean)),
  onEvent: (projectId, event) => {
    broadcastTo(projectId, { type: 'channel-event', projectId, event });
  },
});
channelServer.start();

const app = new Hono();

/** Holds resolvers for in-flight AskUserQuestion / ExitPlanMode calls. */
const pendingAsks = new Map<string, (answer: string) => void>();

// ── Helpers ───────────────────────────────────────────────────────────────

/** Look up the runtime for `projectId`. Returns null if unknown. */
function resolveProject(projectId: string): ProjectRuntime | null {
  return projectRegistry.ensure(projectId as ULID);
}

// ── Global endpoints ──────────────────────────────────────────────────────

app.get('/api/mcp-status', (c) => {
  const file = resolve(DATA, 'mcp-status.json');
  if (!existsSync(file)) return c.json({ alive: false, toolCount: 0, tools: [] });
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as {
      aliveAt?: string; toolCount?: number; tools?: string[];
    };
    const aliveAtMs = raw.aliveAt ? Date.parse(raw.aliveAt) : 0;
    const alive = Number.isFinite(aliveAtMs) && Date.now() - aliveAtMs < 8000;
    return c.json({
      alive,
      toolCount: alive ? raw.toolCount ?? 0 : 0,
      tools: alive ? raw.tools ?? [] : [],
    });
  } catch {
    return c.json({ alive: false, toolCount: 0, tools: [] });
  }
});

/**
 * Ask intercept. Hook scripts POST { projectId, toolName, toolUseId, toolInput }.
 * We broadcast the ask only to the originating project's WS subscribers, then
 * block until the user answers (or the 10-minute timeout fires).
 */
app.post('/api/ask', async (c) => {
  const body = await c.req.json<{
    projectId?: string;
    toolName: string;
    toolUseId: string;
    toolInput: unknown;
  }>();
  const { toolName, toolUseId, toolInput } = body;
  const projectId = typeof body.projectId === 'string' ? (body.projectId as ULID) : null;
  if (!projectId) return c.json({ answer: '(no projectId on ask payload)' });

  broadcastTo(projectId, { type: 'ask', toolName, toolUseId, toolInput });

  const answer = await new Promise<string>((resolveAnswer) => {
    pendingAsks.set(toolUseId, resolveAnswer);
    setTimeout(() => {
      if (pendingAsks.has(toolUseId)) {
        pendingAsks.delete(toolUseId);
        resolveAnswer('(timeout — no user response)');
      }
    }, 10 * 60 * 1000);
  });

  return c.json({ answer });
});

// ── Project-scoped endpoints ──────────────────────────────────────────────

app.get('/api/projects/:projectId', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  return c.json(runtime.workflowRuntime().readProject());
});

app.get('/api/projects/:projectId/work-items', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  return c.json(runtime.workflowRuntime().readWorkItems());
});

app.post('/api/projects/:projectId/work-items/move', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{ id?: string; toStage?: string }>();
  const wiId = typeof body.id === 'string' ? body.id.trim() : '';
  const toStage = typeof body.toStage === 'string' ? body.toStage.trim() : '';
  if (!wiId || !toStage) return c.json({ ok: false, error: 'id and toStage required' }, 400);
  try {
    const workItem = await runtime.workflowRuntime().moveWorkItem(wiId, toStage);
    return c.json({ ok: true, workItem });
  } catch (err) {
    const msg = (err as Error).message;
    const is409 = /^ambiguous trigger|^no valid workflow|is locked: workflow in progress/.test(msg);
    return c.json({ ok: false, error: msg }, is409 ? 409 : 500);
  }
});

app.post('/api/projects/:projectId/work-items/update', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{ id?: string; fields?: Record<string, unknown> }>();
  const wiId = typeof body.id === 'string' ? body.id.trim() : '';
  const fields = body.fields && typeof body.fields === 'object' ? body.fields : null;
  if (!wiId || !fields) return c.json({ ok: false, error: 'id and fields required' }, 400);
  try {
    const workItem = runtime.workflowRuntime().updateWorkItem(wiId, fields);
    return c.json({ ok: true, workItem });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

app.post('/api/projects/:projectId/work-items/create', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{ title?: string; stageId?: string; body?: string }>();
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const stageId = typeof body.stageId === 'string' ? body.stageId.trim() : '';
  if (!title || !stageId) return c.json({ ok: false, error: 'title and stageId required' }, 400);
  try {
    const workItem = runtime.workflowRuntime().createWorkItem(title, stageId, body.body);
    return c.json({ ok: true, workItem });
  } catch (err) {
    const msg = (err as Error).message;
    const is400 = /^unknown stage:|^title required$/.test(msg);
    return c.json({ ok: false, error: msg }, is400 ? 400 : 500);
  }
});

app.get('/api/projects/:projectId/workflows', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const state = runtime.workflowRegistry().reload();
  return c.json({
    valid: state.valid.map((e) => ({
      id: e.workflow.id,
      stageId: e.workflow.triggers?.on_enter?.stage_id ?? null,
      callable: e.workflow.triggers?.callable === true,
      fileName: e.fileName,
    })),
    invalid: state.invalid.map((e) => ({
      fileName: e.fileName,
      partialStageId: e.partialStageId ?? null,
      errors: e.errors,
    })),
  });
});

app.get('/api/projects/:projectId/worktrees', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  return c.json(runtime.worktrees().readCached());
});

app.post('/api/projects/:projectId/worktrees/create', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
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
  const runtime = resolveProject(id);
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

app.post('/api/projects/:projectId/workflow/node-complete', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{ workflowRunId?: string; nodeId?: string; output?: unknown }>();
  const runId = typeof body.workflowRunId === 'string' ? body.workflowRunId.trim() : '';
  const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : '';
  if (!runId || !nodeId) {
    return c.json({ ok: false, error: 'workflowRunId and nodeId required' }, 400);
  }
  try {
    const result = await runtime.workflowRuntime().nodeComplete(runId, nodeId, body.output ?? {});
    return c.json(result);
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

app.post('/api/projects/:projectId/workflow/node-failed', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{ workflowRunId?: string; nodeId?: string; reason?: string }>();
  const runId = typeof body.workflowRunId === 'string' ? body.workflowRunId.trim() : '';
  const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : '';
  const reason = typeof body.reason === 'string' ? body.reason : '';
  if (!runId || !nodeId || !reason) {
    return c.json({ ok: false, error: 'workflowRunId, nodeId, and reason required' }, 400);
  }
  try {
    const result = await runtime.workflowRuntime().nodeFailed(runId, nodeId, reason);
    return c.json(result);
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

app.get('/api/projects/:projectId/approvals', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  return c.json({ approvals: runtime.workflowRuntime().listPendingApprovals() });
});

app.post('/api/projects/:projectId/approval/respond', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{
    workflowRunId?: string;
    nodeId?: string;
    approved?: boolean;
    response?: string;
  }>();
  const runId = typeof body.workflowRunId === 'string' ? body.workflowRunId.trim() : '';
  const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : '';
  if (!runId || !nodeId || typeof body.approved !== 'boolean') {
    return c.json({ ok: false, error: 'workflowRunId, nodeId, and approved required' }, 400);
  }
  try {
    const result = await runtime
      .workflowRuntime()
      .respondToApproval(runId, nodeId, body.approved, body.response ?? '');
    return c.json(result);
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

app.post('/api/projects/:projectId/workflow/run', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{ name?: string; input?: unknown }>();
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return c.json({ ok: false, error: 'name required' }, 400);
  const inputs =
    body.input && typeof body.input === 'object' && !Array.isArray(body.input)
      ? (body.input as Record<string, unknown>)
      : undefined;
  try {
    const run = await runtime.workflowRuntime().runWorkflow(name, inputs);
    return c.json({ ok: true, run });
  } catch (err) {
    const msg = (err as Error).message;
    const is409 = /^ambiguous trigger|^no valid workflow|^unknown workflow|is not callable/.test(msg);
    return c.json({ ok: false, error: msg }, is409 ? 409 : 500);
  }
});

// Proxy to the channel server. P5 reshapes the channel server to a
// multiplexed path-routed shape (POST /channel/<slug>/<source>); for now this
// forwards a plain text body with the rig's allowlist header.
app.post('/api/projects/:projectId/channel-send', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{ message?: string }>();
  const message = typeof body.message === 'string' ? body.message : '';
  if (!message) return c.json({ ok: false, error: 'empty message' }, 400);

  try {
    const result = await new Promise<{ status: number; body: string }>((res, rej) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: CHANNEL_PORT,
          method: 'POST',
          headers: {
            'X-Sender': 'test',
            'Content-Type': 'text/plain',
            'Content-Length': Buffer.byteLength(message),
          },
        },
        (r) => {
          const chunks: Buffer[] = [];
          r.on('data', (chunk) => chunks.push(chunk as Buffer));
          r.on('end', () =>
            res({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }),
          );
        },
      );
      req.on('error', rej);
      req.write(message);
      req.end();
    });
    return c.json({ ok: result.status === 200, status: result.status, body: result.body });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 503);
  }
});

// ── Static / SPA fallback ─────────────────────────────────────────────────

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function staticMime(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  return STATIC_MIME[filePath.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

app.get('*', async (c, next) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return next();

  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = resolve(PUBLIC, '.' + requested);
  if (!filePath.startsWith(PUBLIC)) return c.text('Forbidden', 403);

  try {
    const s = await stat(filePath);
    if (s.isFile()) {
      const content = await readFile(filePath);
      return new Response(new Uint8Array(content), {
        headers: { 'Content-Type': staticMime(filePath) },
      });
    }
  } catch {
    /* fall through to SPA index */
  }

  try {
    const html = await readFile(resolve(PUBLIC, 'index.html'), 'utf-8');
    return c.html(html);
  } catch {
    return c.text(
      'apps/web build not found. Run `pnpm --filter @pc/web build` (or use dev mode on :5173).\n',
      503,
    );
  }
});

const server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(`[pc] http://127.0.0.1:${info.port}`);
});

// ── WebSocket: /ws?projectId=<ULID> ────────────────────────────────────────

const wss = new WebSocketServer({ server: server as never, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/ws', 'http://127.0.0.1');
  const projectId = url.searchParams.get('projectId') as ULID | null;
  if (!projectId) {
    try { ws.close(1008, 'projectId query param required'); } catch { /* best effort */ }
    return;
  }
  const runtime = resolveProject(projectId);
  if (!runtime) {
    try { ws.close(1008, `unknown project: ${projectId}`); } catch { /* best effort */ }
    return;
  }

  // Supersede prior subscribers for this project so tsx-watch reloads + tab
  // reload-races don't doubled-broadcast.
  const existing = subscribers.get(projectId);
  if (existing) {
    for (const prior of existing) {
      if (prior.readyState === prior.OPEN) {
        try { prior.close(1000, 'superseded by newer client'); } catch { /* best effort */ }
      }
    }
  }
  const set = new Set<WebSocket>();
  set.add(ws);
  subscribers.set(projectId, set);

  // Spawn the PtySession on first subscriber. Bind event forwarders.
  const session = runtime.ensurePty();
  const handlersAttached = (session as unknown as { __pcHandlersAttached?: boolean }).__pcHandlersAttached;
  if (!handlersAttached) {
    session.on('raw', (text: string) => broadcastTo(projectId, { type: 'raw', text }));
    session.on('state', (state: string) => broadcastTo(projectId, { type: 'state', state }));
    session.on('turn-end', () => {
      runtime.workflowRuntime().onTurnEnd().catch((err) => {
        console.error('[pc] onTurnEnd failed:', (err as Error).message);
      });
      broadcastTo(projectId, { type: 'turn-end' });
    });
    session.on('event', (event: unknown) => broadcastTo(projectId, { type: 'event', event }));
    session.on('exit', (code, signal) => {
      broadcastTo(projectId, { type: 'exit', code, signal });
      console.log(`[pc] ${projectId} session exited code=${code} signal=${signal}`);
    });
    (session as unknown as { __pcHandlersAttached?: boolean }).__pcHandlersAttached = true;
  }

  ws.send(JSON.stringify({ type: 'state', state: session.getState() }));

  // Replay events.jsonl so a reloaded tab doesn't lose its chat panel.
  const eventsFile = resolve(runtime.dataPath, 'events.jsonl');
  if (existsSync(eventsFile)) {
    try {
      const lines = readFileSync(eventsFile, 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        let event: unknown;
        try { event = JSON.parse(line); } catch { continue; }
        ws.send(JSON.stringify({ type: 'event', event }));
      }
    } catch {
      /* best-effort replay */
    }
  }

  ws.on('message', (raw) => {
    let msg: { type?: string; text?: string; cols?: number; rows?: number };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const live = runtime.ptySession();
    switch (msg.type) {
      case 'send':
        if (live && typeof msg.text === 'string') live.send(msg.text);
        break;
      case 'interrupt':
        live?.interrupt();
        break;
      case 'resize':
        if (live && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          live.resize(msg.cols, msg.rows);
        }
        break;
      case 'ask-reply': {
        const id = (msg as { toolUseId?: string }).toolUseId;
        const answer = (msg as { answer?: string }).answer ?? '';
        if (id && pendingAsks.has(id)) {
          const resolveFn = pendingAsks.get(id)!;
          pendingAsks.delete(id);
          resolveFn(answer);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    set.delete(ws);
    if (set.size === 0) subscribers.delete(projectId);
  });
});

process.on('SIGINT', () => {
  console.log('[pc] SIGINT — shutting down project runtimes + channel server');
  projectRegistry.shutdownAll();
  channelServer.shutdown();
  process.exit(0);
});
