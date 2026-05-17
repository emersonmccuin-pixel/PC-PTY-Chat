import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

import type { ULID } from '@pc/domain';
import {
  getProjectById,
  listProjects,
  runMigrations,
  softDeleteProject,
  updateProjectMeta,
} from '@pc/db';

import { AgentLibrary, defaultLibraryDir } from './services/agent-library.ts';
import { ChannelServer } from './services/channel-server.ts';
import {
  copyLibraryAgentToProject,
  listProjectAgents,
  readProjectAgent,
  writeProjectAgent,
} from './services/project-agents.ts';
import { browseFolder, BrowseError } from './services/fs-browse.ts';
import { probeFolder } from './services/fs-probe.ts';
import { ProjectCreate, type CreateProjectMode } from './services/project-create.ts';
import { ProjectRegistry } from './services/project-registry.ts';
import type { ProjectRuntime } from './services/project-runtime.ts';
import { ProjectScaffold } from './services/project-scaffold.ts';

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

/**
 * Send `msg` to every WS subscribed to this project. P14: every outgoing
 * object envelope is tagged with `projectId` so UI clients can route events
 * to the right project's panel (and an "all projects" subscriber knows
 * where each event came from). An explicit `projectId` already on the
 * payload wins so call sites stay self-describing.
 */
function broadcastTo(projectId: ULID, msg: unknown): void {
  const set = subscribers.get(projectId);
  if (!set) return;
  const tagged =
    msg !== null && typeof msg === 'object'
      ? { projectId, ...(msg as Record<string, unknown>) }
      : msg;
  const data = JSON.stringify(tagged);
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

const projectScaffold = new ProjectScaffold({
  trunkPath: ROOT,
  templatesDir: TEMPLATES,
  dataDir: DATA,
  serverPort: PORT,
  channelPort: CHANNEL_PORT,
});
const projectCreate = new ProjectCreate(projectScaffold, agentLibrary, projectRegistry);

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

// ── Filesystem browse + probe (create-project UI) ─────────────────────────

/** List a directory for the folder picker. Query: `path` (default = ~/). */
app.get('/api/fs/browse', (c) => {
  const path = c.req.query('path') ?? '';
  try {
    return c.json({ ok: true, ...browseFolder(path) });
  } catch (err) {
    if (err instanceof BrowseError) {
      const status = err.kind === 'forbidden' ? 403 : err.kind === 'not_found' ? 404 : 400;
      return c.json({ ok: false, error: err.message, kind: err.kind }, status);
    }
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

/** Probe a folder for the create-project preview. Body: `{ path }`.
 *  Response: { path, exists, isDirectory, hasFiles, fileCount, isGitRepo }. */
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

// ── Project lifecycle ─────────────────────────────────────────────────────

/** List projects. `?include_deleted=1` includes soft-deleted rows (off by
 *  default per design's soft-delete semantics). */
app.get('/api/projects', (c) => {
  const includeDeleted = c.req.query('include_deleted') === '1';
  return c.json({ projects: listProjects({ includeDeleted }) });
});

/** Patch a project's mutable metadata (name + git_remote). Slug stays locked
 *  per MULTI-TENANCY-DESIGN.md "Open / deferred". Body: `{ name?, git_remote? }`. */
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
    projectRegistry.refresh(updated);
    return c.json({ ok: true, project: updated });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

/** Soft-delete a project. Filesystem is untouched per MULTI-TENANCY-DESIGN.md;
 *  the separate DELETE /api/projects/:id/files endpoint is the only path to
 *  on-disk removal. Idempotent — returns 200 even if already deleted. */
app.delete('/api/projects/:projectId', (c) => {
  const id = c.req.param('projectId') as ULID;
  const deleted = softDeleteProject(id);
  if (!deleted) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  projectRegistry.remove(id);
  return c.json({ ok: true, project: deleted });
});

/** Danger-zone: remove PC's scaffold dirs (`.project-companion/`, `.claude/`)
 *  from the project's folder on disk. The user's own files, `.git/`, README,
 *  and `.mcp.json` are NOT touched — per design, only what PC put there is
 *  PC's to remove.
 *
 *  Independent of the soft-delete row flip; either can be invoked alone. */
app.delete('/api/projects/:projectId/files', (c) => {
  const id = c.req.param('projectId') as ULID;
  // Hard-look at the DB so deleted rows are still resolvable here — the UI
  // flow soft-deletes first, then offers "Also delete files on disk".
  const project = getProjectById(id) ?? listProjects({ includeDeleted: true }).find((p) => p.id === id);
  if (!project) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  // Drop the runtime first so no in-flight worker holds a file lock on the
  // dirs we're about to remove.
  projectRegistry.remove(id);
  const folder = project.folderPath;
  const removed: string[] = [];
  for (const sub of ['.project-companion', '.claude']) {
    const target = resolve(folder, sub);
    if (existsSync(target)) {
      try {
        rmSync(target, { recursive: true, force: true });
        removed.push(sub);
      } catch (err) {
        return c.json({ ok: false, error: `failed to remove ${sub}: ${(err as Error).message}` }, 500);
      }
    }
  }
  return c.json({ ok: true, removed });
});

/** Create a project: git init in `folder_path`, write the PC scaffold, commit,
 *  insert the DB row, register the runtime. Body:
 *    { name, folder_path, mode: 'init-empty' | 'init-in-place', git_remote? }
 *
 *  Per MULTI-TENANCY-DESIGN.md Q2 the UI probes the folder first and picks the
 *  mode; the server enforces consistency (refuses init-empty on a non-empty
 *  folder; refuses to reinit an existing git repo). */
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
  if (!name || !folderPath || (mode !== 'init-empty' && mode !== 'init-in-place')) {
    return c.json({ ok: false, error: 'name, folder_path, and mode required' }, 400);
  }
  try {
    const project = await projectCreate.create({
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

// ── Agent library ─────────────────────────────────────────────────────────

/** Global library at `~/.project-companion/agents/`. */
app.get('/api/agents', (c) => {
  return c.json({ agents: agentLibrary.list() });
});

/** Write a new library agent. Body: `{ name, body }`. 409 if the name is taken. */
app.post('/api/agents', async (c) => {
  const body = await c.req.json<{ name?: string; body?: string }>();
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const text = typeof body.body === 'string' ? body.body : '';
  if (!name || !text) return c.json({ ok: false, error: 'name and body required' }, 400);
  try {
    const agent = agentLibrary.write(name, text);
    return c.json({ ok: true, agent }, 201);
  } catch (err) {
    const msg = (err as Error).message;
    const is409 = /^agent already exists/.test(msg);
    const is400 = /^invalid agent name|^agent name required/.test(msg);
    return c.json({ ok: false, error: msg }, is409 ? 409 : is400 ? 400 : 500);
  }
});

/** Per-project agent copies at `<folder>/.claude/agents/`. */
app.get('/api/projects/:projectId/agents', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  return c.json({ agents: listProjectAgents(runtime.folderPath) });
});

/** Add an agent from the library into the project. Body: `{ name }`. 409 if
 *  the project already has a copy with that name. */
app.post('/api/projects/:projectId/agents', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{ name?: string }>();
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return c.json({ ok: false, error: 'name required' }, 400);
  try {
    const agent = copyLibraryAgentToProject(agentLibrary, runtime.folderPath, name);
    return c.json({ ok: true, agent }, 201);
  } catch (err) {
    const msg = (err as Error).message;
    if (/^library agent not found/.test(msg)) return c.json({ ok: false, error: msg }, 404);
    if (/^project already has an agent/.test(msg)) return c.json({ ok: false, error: msg }, 409);
    if (/^invalid agent name|^agent name required/.test(msg)) return c.json({ ok: false, error: msg }, 400);
    return c.json({ ok: false, error: msg }, 500);
  }
});

/** Edit a project's agent copy. Library version is untouched. Body: `{ body }`.
 *  PATCH per the design spec — semantically a full-body replace. */
app.patch('/api/projects/:projectId/agents/:name', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const name = c.req.param('name');
  const body = await c.req.json<{ body?: string }>();
  if (typeof body.body !== 'string') {
    return c.json({ ok: false, error: 'body required' }, 400);
  }
  if (!readProjectAgent(runtime.folderPath, name)) {
    return c.json({ ok: false, error: `unknown project agent: ${name}` }, 404);
  }
  try {
    const agent = writeProjectAgent(runtime.folderPath, name, body.body);
    return c.json({ ok: true, agent });
  } catch (err) {
    const msg = (err as Error).message;
    const is400 = /^invalid agent name|^agent name required/.test(msg);
    return c.json({ ok: false, error: msg }, is400 ? 400 : 500);
  }
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
