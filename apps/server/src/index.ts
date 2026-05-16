import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

import { PtySession } from '@pc/runtime';
import { WorkflowRegistry } from '@pc/workflows';

import { WorktreeService } from './services/worktree.ts';
import { WorkflowRuntime } from './services/workflow-runtime.ts';
import { evaluateBoolean, substituteOutputs } from './services/output-substitution.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// apps/server/src/index.ts → rig root is three levels up.
const ROOT = resolve(__dirname, '..', '..', '..');
const PUBLIC = resolve(ROOT, 'apps', 'web');
const WORKSPACE = resolve(ROOT, 'workspace');
const DATA = resolve(ROOT, 'data');
const WORKFLOWS_DIR = resolve(WORKSPACE, '.project-companion', 'workflows');

const PORT = Number(process.env.PORT ?? 4040);
const CHANNEL_PORT = Number(process.env.CHANNEL_PORT ?? 8788);

// WS client set + broadcast — declared before the runtime so the approval
// dispatcher can push UI events. The set fills as connections arrive later.
const clients = new Set<WebSocket>();
function broadcast(msg: unknown) {
  const data = JSON.stringify(msg);
  for (const c of clients) {
    if (c.readyState === c.OPEN) c.send(data);
  }
}

const worktrees = new WorktreeService(WORKSPACE, resolve(DATA, 'worktrees.json'));
const registry = new WorkflowRegistry(WORKFLOWS_DIR);
registry.reload();
const workflow = new WorkflowRuntime({
  workspaceDir: WORKSPACE,
  workItemsFile: resolve(DATA, 'work-items.json'),
  projectFile: resolve(DATA, 'project.json'),
  workflowRunsFile: resolve(DATA, 'workflow-runs.json'),
  channelPort: CHANNEL_PORT,
  evaluateBoolean,
  substituteOutputs,
  broadcast,
  registry,
  worktrees,
});

const app = new Hono();

app.get('/', async (c) => {
  const html = await readFile(resolve(PUBLIC, 'index.html'), 'utf-8');
  return c.html(html);
});

app.get('/app.js', async () => {
  const js = await readFile(resolve(PUBLIC, 'app.js'), 'utf-8');
  return new Response(js, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
});

app.get('/styles.css', async () => {
  const css = await readFile(resolve(PUBLIC, 'styles.css'), 'utf-8');
  return new Response(css, { headers: { 'Content-Type': 'text/css; charset=utf-8' } });
});

// Holds promise resolvers for in-flight AskUserQuestion / ExitPlanMode calls.
// The hook POSTs /api/ask which blocks here until the user clicks a reply.
const pendingAsks = new Map<string, (answer: string) => void>();

// MCP status — read the heartbeat file the @pc/mcp server maintains. Considered
// "alive" if heartbeat < 8s ago. Lets the UI show an "MCP: N" pill.
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

app.get('/api/worktrees', async (c) => {
  // Use cached read for snappy UI polls; the actions below refresh it.
  return c.json(worktrees.readCached());
});

app.post('/api/worktrees/create', async (c) => {
  const body = await c.req.json<{ name?: string }>();
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return c.json({ ok: false, error: 'name required' }, 400);
  try {
    const entry = await worktrees.create(name);
    return c.json({ ok: true, entry });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

app.get('/api/project', (c) => c.json(workflow.readProject()));

app.get('/api/work-items', (c) => c.json(workflow.readWorkItems()));

app.post('/api/work-items/move', async (c) => {
  const body = await c.req.json<{ id?: string; toStage?: string }>();
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const toStage = typeof body.toStage === 'string' ? body.toStage.trim() : '';
  if (!id || !toStage) return c.json({ ok: false, error: 'id and toStage required' }, 400);
  try {
    const workItem = await workflow.moveWorkItem(id, toStage);
    return c.json({ ok: true, workItem });
  } catch (err) {
    const msg = (err as Error).message;
    // Trigger-resolution errors render as 409 so the UI shows them as a
    // red system-notice bubble in chat (matches 8b's contract).
    const is409 = /^ambiguous trigger|^no valid workflow|is locked: workflow in progress/.test(msg);
    return c.json({ ok: false, error: msg }, is409 ? 409 : 500);
  }
});

app.post('/api/work-items/update', async (c) => {
  const body = await c.req.json<{ id?: string; fields?: Record<string, unknown> }>();
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const fields = body.fields && typeof body.fields === 'object' ? body.fields : null;
  if (!id || !fields) return c.json({ ok: false, error: 'id and fields required' }, 400);
  try {
    const workItem = workflow.updateWorkItem(id, fields);
    return c.json({ ok: true, workItem });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

// GET /api/workflows — registry snapshot for the UI's Workflows pane. Reload
// on every call so live YAML edits surface within the UI's poll interval.
app.get('/api/workflows', (c) => {
  const state = registry.reload();
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

app.post('/api/worktrees/destroy', async (c) => {
  const body = await c.req.json<{ target?: string; force?: boolean }>();
  const target = typeof body.target === 'string' ? body.target.trim() : '';
  if (!target) return c.json({ ok: false, error: 'target required' }, 400);
  try {
    await worktrees.destroy(target, body.force === true);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

// Workflow node completion endpoints. Backing for the pc_complete_node /
// pc_node_failed MCP tools — subagents call these to close out their assigned
// node. The runtime re-ticks the run on success so downstream nodes fire.
app.post('/api/workflow/node-complete', async (c) => {
  const body = await c.req.json<{ workflowRunId?: string; nodeId?: string; output?: unknown }>();
  const runId = typeof body.workflowRunId === 'string' ? body.workflowRunId.trim() : '';
  const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : '';
  if (!runId || !nodeId) {
    return c.json({ ok: false, error: 'workflowRunId and nodeId required' }, 400);
  }
  try {
    const result = await workflow.nodeComplete(runId, nodeId, body.output ?? {});
    return c.json(result);
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

app.get('/api/approvals', (c) => c.json({ approvals: workflow.listPendingApprovals() }));

app.post('/api/approval/respond', async (c) => {
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
    const result = await workflow.respondToApproval(runId, nodeId, body.approved, body.response ?? '');
    return c.json(result);
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

// Orchestrator-callable workflow entry. Backing for the pc_run_workflow MCP
// tool. Lookup failures (unknown / many / invalid / not callable) map to 409
// so the UI renders them as a red system-notice bubble.
app.post('/api/workflow/run', async (c) => {
  const body = await c.req.json<{ name?: string; input?: unknown }>();
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return c.json({ ok: false, error: 'name required' }, 400);
  const inputs =
    body.input && typeof body.input === 'object' && !Array.isArray(body.input)
      ? (body.input as Record<string, unknown>)
      : undefined;
  try {
    const run = await workflow.runWorkflow(name, inputs);
    return c.json({ ok: true, run });
  } catch (err) {
    const msg = (err as Error).message;
    const is409 =
      /^ambiguous trigger|^no valid workflow|^unknown workflow|is not callable/.test(msg);
    return c.json({ ok: false, error: msg }, is409 ? 409 : 500);
  }
});

app.post('/api/workflow/node-failed', async (c) => {
  const body = await c.req.json<{ workflowRunId?: string; nodeId?: string; reason?: string }>();
  const runId = typeof body.workflowRunId === 'string' ? body.workflowRunId.trim() : '';
  const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : '';
  const reason = typeof body.reason === 'string' ? body.reason : '';
  if (!runId || !nodeId || !reason) {
    return c.json({ ok: false, error: 'workflowRunId, nodeId, and reason required' }, 400);
  }
  try {
    const result = await workflow.nodeFailed(runId, nodeId, reason);
    return c.json(result);
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

// Proxy /api/channel-send → POST to the webhook channel server on
// 127.0.0.1:8788 with the required X-Sender allowlist header. The webhook
// server is spawned by CC itself (per workspace/.mcp.json) the first time the
// PtySession boots; if the orchestrator hasn't booted yet, the connect will
// fail and we return 503.

app.post('/api/channel-send', async (c) => {
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

app.post('/api/ask', async (c) => {
  const body = await c.req.json<{ toolName: string; toolUseId: string; toolInput: unknown }>();
  const { toolName, toolUseId, toolInput } = body;

  // Tell every connected client to render a chooser for this question.
  broadcast({ type: 'ask', toolName, toolUseId, toolInput });

  const answer = await new Promise<string>((resolve) => {
    pendingAsks.set(toolUseId, resolve);
    setTimeout(() => {
      if (pendingAsks.has(toolUseId)) {
        pendingAsks.delete(toolUseId);
        resolve('(timeout — no user response)');
      }
    }, 10 * 60 * 1000);
  });

  return c.json({ answer });
});

const server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(`[pc-pty-chat] http://127.0.0.1:${info.port}`);
});

const wss = new WebSocketServer({ server: server as never, path: '/ws' });

let session: PtySession | null = null;

function ensureSession() {
  if (session && session.getState() !== 'exited') return session;

  console.log('[pc-pty-chat] spawning PtySession');
  session = new PtySession({
    workspaceDir: WORKSPACE,
    stopMarkerPath: resolve(DATA, 'stop-markers.txt'),
    eventsPath: resolve(DATA, 'events.jsonl'),
    transcriptPath: resolve(DATA, 'transcript.log'),
  });

  session.on('raw', (text: string) => broadcast({ type: 'raw', text }));
  session.on('state', (state: string) => broadcast({ type: 'state', state }));
  session.on('turn-end', () => {
    // Safety net: mark any subagent node still 'running' as failed. Async
    // version — fire and forget; tick errors surface in console only.
    workflow.onTurnEnd().catch((err) => {
      console.error('[pc-pty-chat] onTurnEnd failed:', (err as Error).message);
    });
    broadcast({ type: 'turn-end' });
  });
  session.on('event', (event: unknown) => broadcast({ type: 'event', event }));
  session.on('exit', (code, signal) => {
    broadcast({ type: 'exit', code, signal });
    console.log(`[pc-pty-chat] session exited code=${code} signal=${signal}`);
    session = null;
  });

  return session;
}

wss.on('connection', (ws) => {
  // Single-tenant rig: a new connection drops any stale ones to prevent
  // doubled broadcasts when tsx-watch reloads or the user reload-races the
  // server. Browser will reconnect once via its close handler if it's a real
  // duplicate tab.
  for (const prior of clients) {
    if (prior.readyState === prior.OPEN) {
      try { prior.close(1000, 'superseded by newer client'); } catch { /* best effort */ }
    }
    clients.delete(prior);
  }
  clients.add(ws);
  const s = ensureSession();
  ws.send(JSON.stringify({ type: 'state', state: s.getState() }));

  // Replay events history so a reloaded browser doesn't lose the chat panel.
  const eventsFile = resolve(DATA, 'events.jsonl');
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
    if (!session) return;
    switch (msg.type) {
      case 'send':
        if (typeof msg.text === 'string') session.send(msg.text);
        break;
      case 'interrupt':
        session.interrupt();
        break;
      case 'resize':
        if (typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          session.resize(msg.cols, msg.rows);
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

  ws.on('close', () => clients.delete(ws));
});

process.on('SIGINT', () => {
  console.log('[pc-pty-chat] SIGINT — killing session');
  session?.kill();
  process.exit(0);
});
