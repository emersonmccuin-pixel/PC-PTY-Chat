import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

import { homedir } from 'node:os';

import type { AgentDef, GlobalSettings, ULID, Workflow } from '@pc/domain';
import { parseAgentFile, serializeAgentFile, validateAgentDef, withSettingsDefaults } from '@pc/domain';
import {
  parseTypedWorkflowDef,
  parseWorkflowText,
  serializeWorkflow,
  validateWorkflow,
} from '@pc/workflows';
import {
  countWorkItemsInStage,
  getActiveOrchestratorSession,
  getGlobalSettings,
  getProjectById,
  listOrchestratorSessionsForProject,
  listProjects,
  reassignStage,
  runMigrations,
  setGlobalSettings,
  setOrchestratorSessionJsonlCursor,
  setOrchestratorSessionJsonlPath,
  setOrchestratorSessionTitle,
  softDeleteProject,
  updateProjectMeta,
  updateProjectStages,
} from '@pc/db';
import type { Stage } from '@pc/domain';
import { getDataDir } from '@pc/utils';

import { AgentLibrary, defaultLibraryDir } from './services/agent-library.ts';
import { AttachmentNotInProjectError } from './services/attachment.ts';
import { ChannelServer } from './services/channel-server.ts';
import { listCustomCommands } from './services/custom-commands.ts';
import {
  FieldValidationError,
  UnknownStageError,
  WorkItemVersionConflictError,
} from './services/work-item.ts';
import {
  type MemoryScope,
  readMemoryFile,
  writeMemoryFile,
} from './services/memory-files.ts';
import {
  deleteProjectAgent,
  listResolvedAgents,
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

// Agent library — first-run seed from templates/.project-companion/agents/
// into ~/.project-companion/agents/. Globals surface in every project's
// agent list via listResolvedAgents; per-project files in `.claude/agents/`
// shadow them by name. See Section 3 D2.
const agentLibrary = new AgentLibrary(
  defaultLibraryDir(),
  resolve(TEMPLATES, '.project-companion', 'agents'),
);
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
  templatesDir: TEMPLATES,
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
const projectCreate = new ProjectCreate(projectScaffold, projectRegistry);

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

/**
 * Attach the per-PtySession event forwarders. Idempotent per session instance
 * via a flag on the session itself — re-binding on every WS reconnect would
 * leak listeners. Called from both the WS connect path and the new-session
 * endpoint (which creates a fresh PtySession instance after wiping state).
 */
function attachPtyHandlers(
  projectId: ULID,
  runtime: ProjectRuntime,
  session: ReturnType<ProjectRuntime['ensurePty']>,
): void {
  const flag = session as unknown as { __pcHandlersAttached?: boolean };
  if (flag.__pcHandlersAttached) return;
  session.on('raw', (text: string) => broadcastTo(projectId, { type: 'raw', text }));
  session.on('state', (state: string) => broadcastTo(projectId, { type: 'state', state }));
  session.on('turn-end', () => {
    runtime.workflowRuntime().onTurnEnd().catch((err) => {
      console.error('[pc] onTurnEnd failed:', (err as Error).message);
    });
    broadcastTo(projectId, { type: 'turn-end' });
  });
  session.on('event', (event: unknown) => {
    maybeSetSessionTitle(projectId, event);
    broadcastTo(projectId, { type: 'event', event });
  });
  // JSONL tailer events — Section 0 canonical signal for turn lifecycle +
  // tool calls. Distinct WS envelope kind from the hook-driven `event` stream
  // so the chat panel can merge them without ambiguity.
  session.on('jsonl-event', (event: unknown) => {
    broadcastTo(projectId, { type: 'jsonl', event });
  });
  session.on('jsonl-path-resolved', (jsonlPath: string) => {
    const active = getActiveOrchestratorSession(projectId);
    if (active) setOrchestratorSessionJsonlPath(active.id, jsonlPath);
  });
  session.on('jsonl-cursor-tick', (_path: string, cursor: number) => {
    const active = getActiveOrchestratorSession(projectId);
    if (active) setOrchestratorSessionJsonlCursor(active.id, cursor);
  });
  session.on('exit', (code: number | undefined, signal: string | undefined) => {
    broadcastTo(projectId, { type: 'exit', code, signal });
    console.log(`[pc] ${projectId} session exited code=${code} signal=${signal}`);
  });
  flag.__pcHandlersAttached = true;
}

/**
 * If the active session has no title and the event is the first user prompt,
 * derive a title from the prompt text and broadcast the updated session so
 * the UI's chat header re-renders.
 */
function maybeSetSessionTitle(projectId: ULID, event: unknown): void {
  if (!event || typeof event !== 'object') return;
  const ev = event as { kind?: string; text?: string };
  if (ev.kind !== 'user' || typeof ev.text !== 'string') return;
  const active = getActiveOrchestratorSession(projectId);
  if (!active || active.title) return;
  const title = deriveTitleFromText(ev.text);
  if (!title) return;
  setOrchestratorSessionTitle(active.id, title);
  const updated = getActiveOrchestratorSession(projectId);
  if (updated) broadcastTo(projectId, { type: 'session-changed', session: updated });
}

/** First non-empty line, collapsed whitespace, truncated to ~60 chars. */
function deriveTitleFromText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const firstLine = trimmed.split(/\r?\n/, 1)[0]!.replace(/\s+/g, ' ').trim();
  if (firstLine.length <= 60) return firstLine;
  return firstLine.slice(0, 57).trimEnd() + '…';
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
 * Ask intercept. Hook scripts POST { projectId, sessionId?, toolName, toolUseId, toolInput }.
 * We broadcast the ask only to the originating project's WS subscribers, then
 * block until the user answers (or the 10-minute timeout fires). `sessionId`
 * (forwarded from the hook's PC_SESSION_ID) lets transient-session modals
 * (workflow-creator, agent-creator) filter to asks originating from their own
 * claude.exe spawn; orchestrator UI ignores the field.
 */
app.post('/api/ask', async (c) => {
  const body = await c.req.json<{
    projectId?: string;
    sessionId?: string | null;
    toolName: string;
    toolUseId: string;
    toolInput: unknown;
  }>();
  const { toolName, toolUseId, toolInput } = body;
  const projectId = typeof body.projectId === 'string' ? (body.projectId as ULID) : null;
  if (!projectId) return c.json({ answer: '(no projectId on ask payload)' });
  const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null;

  broadcastTo(projectId, { type: 'ask', sessionId, toolName, toolUseId, toolInput });

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

// ── Global settings (Q10 envelope) ────────────────────────────────────────

function readSettings(): GlobalSettings {
  const stored = getGlobalSettings();
  return withSettingsDefaults(stored ?? {}, getDataDir(), homedir());
}

app.get('/api/settings', (c) => {
  return c.json({ ok: true, settings: readSettings() });
});

/** Partial settings update. Body accepts any subset of the envelope. Returns
 *  the merged envelope + a `restartRequired` flag if `dataDir` changed (only
 *  field that needs a restart per v1 decision #24). */
app.patch('/api/settings', async (c) => {
  const body = await c.req
    .json<Partial<GlobalSettings>>()
    .catch((): Partial<GlobalSettings> => ({}));
  const current = readSettings();
  const merged: GlobalSettings = withSettingsDefaults(
    {
      dataDir: typeof body.dataDir === 'string' ? body.dataDir.trim() || current.dataDir : current.dataDir,
      telemetryOptIn:
        typeof body.telemetryOptIn === 'boolean' ? body.telemetryOptIn : current.telemetryOptIn,
      projectsFolder:
        typeof body.projectsFolder === 'string' && body.projectsFolder.trim()
          ? body.projectsFolder.trim()
          : current.projectsFolder,
      activityPanel: {
        open: body.activityPanel?.open ?? current.activityPanel.open,
        showAllProjects:
          body.activityPanel?.showAllProjects ?? current.activityPanel.showAllProjects,
      },
    },
    getDataDir(),
    homedir(),
  );
  setGlobalSettings(merged);
  const restartRequired = merged.dataDir !== current.dataDir;
  return c.json({ ok: true, settings: merged, restartRequired });
});

// ── Filesystem browse + probe (create-project UI) ─────────────────────────

/** List a directory for the folder picker. Query: `path` (default = ~/). */
app.get('/api/fs/browse', (c) => {
  const path = c.req.query('path') ?? '';
  try {
    return c.json({ ok: true, ...browseFolder(path) });
  } catch (err) {
    if (err instanceof BrowseError) {
      const status = err.kind === 'not_found' ? 404 : 400;
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
 *  per docs/design/multi-tenancy.md "Open / deferred". Body: `{ name?, git_remote? }`. */
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

/** Soft-delete a project. Filesystem is untouched per docs/design/multi-tenancy.md;
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

/** D86 — open the project's folder in the OS file manager.
 *  Windows: `explorer.exe <path>`. macOS: `open <path>`. Linux: `xdg-open <path>`.
 *  Spawned detached so the API doesn't track its lifetime. */
app.post('/api/projects/:projectId/reveal', (c) => {
  const id = c.req.param('projectId') as ULID;
  const project = getProjectById(id) ?? listProjects({ includeDeleted: true }).find((p) => p.id === id);
  if (!project) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const folder = project.folderPath;
  if (!existsSync(folder)) {
    return c.json({ ok: false, error: `folder does not exist on disk: ${folder}` }, 404);
  }
  const { cmd, args } = revealCommand(folder);
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
  } catch (err) {
    return c.json({ ok: false, error: `failed to reveal: ${(err as Error).message}` }, 500);
  }
  return c.json({ ok: true });
});

function revealCommand(path: string): { cmd: string; args: string[] } {
  if (process.platform === 'win32') return { cmd: 'explorer.exe', args: [path] };
  if (process.platform === 'darwin') return { cmd: 'open', args: [path] };
  return { cmd: 'xdg-open', args: [path] };
}

/** Create a project: git init in `folder_path`, write the PC scaffold, commit,
 *  insert the DB row, register the runtime. Body:
 *    { name, folder_path, mode: 'init-empty' | 'init-in-place', git_remote? }
 *
 *  Per docs/design/multi-tenancy.md Q2 the UI probes the folder first and picks the
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

/** Resolved per-project agent view per Section 3 D2: globals (live from the
 *  library, no per-project file), overrides (per-project file shadowing a
 *  global), and project-only (per-project file with no matching global).
 *  Replaces the legacy `{ agents }` shape. */
app.get('/api/projects/:projectId/agents', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const resolved = listResolvedAgents(agentLibrary, runtime.folderPath);
  return c.json({ ok: true, ...resolved });
});

/** Create a NEW project-scoped agent from scratch (3e — conversational
 *  Create Agent path). Accepts the same shapes as PATCH: either raw `body`
 *  or `{ def, markdown }`. 409 if a project file by that name already
 *  exists; 409 with `kind: 'shadows-global'` when a global with that name
 *  exists (the user should pick a different name or use Edit-on-global to
 *  produce an override). Broadcasts `project-agents-changed` on success. */
app.post('/api/projects/:projectId/agents', async (c) => {
  const id = c.req.param('projectId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const payload = await c.req.json<{
    name?: string;
    body?: string;
    def?: AgentDef;
    markdown?: string;
  }>();
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  if (!name) return c.json({ ok: false, error: 'name required' }, 400);

  if (readProjectAgent(runtime.folderPath, name)) {
    return c.json({ ok: false, error: `project agent already exists: ${name}` }, 409);
  }
  if (agentLibrary.read(name)) {
    return c.json(
      {
        ok: false,
        kind: 'shadows-global' as const,
        error: `name "${name}" matches a global. Pick a different name or Edit the global to create a project override.`,
      },
      409,
    );
  }

  let fileText: string;
  if (typeof payload.body === 'string') {
    fileText = payload.body;
  } else if (payload.def && typeof payload.markdown === 'string') {
    const validation = validateAgentDef(payload.def);
    if (!validation.ok) {
      return c.json({ ok: false, error: 'invalid agent', errors: validation.errors }, 400);
    }
    fileText = serializeAgentFile({ def: payload.def, body: payload.markdown });
  } else {
    return c.json(
      { ok: false, error: 'either `body` or `{ def, markdown }` required' },
      400,
    );
  }

  try {
    const agent = writeProjectAgent(runtime.folderPath, name, fileText);
    broadcastTo(id, { type: 'project-agents-changed', change: 'created', name });
    return c.json({ ok: true, agent }, 201);
  } catch (err) {
    const msg = (err as Error).message;
    const is400 = /^invalid agent name|^agent name required/.test(msg);
    return c.json({ ok: false, error: msg }, is400 ? 400 : 500);
  }
});

/** Edit an agent in the context of a project. If the name matches a global,
 *  this writes the per-project override file; the global stays untouched.
 *  If not, it edits an existing project-only agent.
 *
 *  Accepts EITHER:
 *    - `{ body: string }` — raw full-file text (YAML-view save path).
 *    - `{ def: AgentDef, markdown: string }` — typed view from the form
 *      editor. Server validates `def`, then serializes via the round-trip
 *      basis (the existing file text), so unknown frontmatter keys,
 *      comments, and YAML node style survive. */
app.patch('/api/projects/:projectId/agents/:name', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const name = c.req.param('name');
  const payload = await c.req.json<{ body?: string; def?: AgentDef; markdown?: string }>();

  // Must match either an existing project file or a global by this name.
  const projectEntry = readProjectAgent(runtime.folderPath, name);
  const globalEntry = agentLibrary.read(name);
  if (!projectEntry && !globalEntry) {
    return c.json({ ok: false, error: `unknown agent: ${name}` }, 404);
  }

  let fileText: string;
  if (typeof payload.body === 'string') {
    fileText = payload.body;
  } else if (payload.def && typeof payload.markdown === 'string') {
    const validation = validateAgentDef(payload.def);
    if (!validation.ok) {
      return c.json({ ok: false, error: 'invalid agent', errors: validation.errors }, 400);
    }
    // Round-trip basis: existing project file if present, else the global
    // we're about to shadow. Either way the parse-and-diff approach
    // preserves comments / unknown keys / key order from the basis.
    const basis = projectEntry?.body ?? globalEntry?.body;
    fileText = serializeAgentFile({ def: payload.def, body: payload.markdown, original: basis });
  } else {
    return c.json(
      { ok: false, error: 'either `body` or `{ def, markdown }` required' },
      400,
    );
  }

  try {
    const agent = writeProjectAgent(runtime.folderPath, name, fileText);
    return c.json({ ok: true, agent });
  } catch (err) {
    const msg = (err as Error).message;
    const is400 = /^invalid agent name|^agent name required/.test(msg);
    return c.json({ ok: false, error: msg }, is400 ? 400 : 500);
  }
});

/** Promote a project agent to the global library. Two cases:
 *
 *  - The name matches an existing global → REPLACE the global. The project
 *    file (which is the override) is deleted so this project picks up the
 *    new global cleanly. `kind: 'replaced-global'`.
 *  - The name does NOT match a global → ADD a new global. The project file
 *    is deleted so this project (and all others) sees it as a Global entry.
 *    `kind: 'added-global'`.
 *
 *  The promoted body is validated before write — a broken project agent
 *  can't pollute the global library. */
app.post('/api/projects/:projectId/agents/:name/promote-to-global', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const name = c.req.param('name');

  const projectEntry = readProjectAgent(runtime.folderPath, name);
  if (!projectEntry) {
    return c.json({ ok: false, error: `no project agent named ${name}` }, 404);
  }

  const parsed = parseAgentFile(projectEntry.body);
  if (!parsed.ok) {
    return c.json({ ok: false, error: `cannot promote: ${parsed.message}` }, 400);
  }
  const validation = validateAgentDef(parsed.def);
  if (!validation.ok) {
    return c.json(
      { ok: false, error: 'cannot promote: agent has validation errors', errors: validation.errors },
      400,
    );
  }

  try {
    const { entry, replaced } = agentLibrary.upsert(name, projectEntry.body);
    deleteProjectAgent(runtime.folderPath, name);
    return c.json({
      ok: true,
      kind: replaced ? ('replaced-global' as const) : ('added-global' as const),
      agent: entry,
    });
  } catch (err) {
    const msg = (err as Error).message;
    const is400 = /^invalid agent name|^agent name required/.test(msg);
    return c.json({ ok: false, error: msg }, is400 ? 400 : 500);
  }
});

/** Delete a project agent file. Two meanings depending on whether the name
 *  matches a global:
 *
 *  - Override of a global → "reset to global". The global stays in the
 *    library and surfaces unmodified on the next list call.
 *  - Project-only agent → fully removes the agent from the project.
 *
 *  Response includes `kind: 'reset-to-global' | 'project-only'` so the UI
 *  can phrase the confirmation correctly. */
app.delete('/api/projects/:projectId/agents/:name', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const name = c.req.param('name');
  const wasGlobal = agentLibrary.read(name) !== null;
  try {
    deleteProjectAgent(runtime.folderPath, name);
    return c.json({ ok: true, kind: wasGlobal ? 'reset-to-global' : 'project-only' });
  } catch (err) {
    const msg = (err as Error).message;
    if (/^unknown project agent/.test(msg)) {
      return c.json({ ok: false, error: msg }, 404);
    }
    if (/^invalid agent name|^agent name required/.test(msg)) {
      return c.json({ ok: false, error: msg }, 400);
    }
    return c.json({ ok: false, error: msg }, 500);
  }
});

/** Custom commands for the Abilities tray. Scans `.claude/commands/*.md` in
 *  both project and `~/.claude/commands/`. Project shadows user on name
 *  collision (CC parity). */
app.get('/api/projects/:projectId/commands', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  return c.json({ ok: true, commands: listCustomCommands(runtime.folderPath) });
});

/** Memory file (`CLAUDE.md`) read for one scope. `?scope=user|project|workspace`. */
app.get('/api/projects/:projectId/memory/:scope', (c) => {
  const id = c.req.param('projectId');
  const scope = c.req.param('scope');
  if (scope !== 'user' && scope !== 'project' && scope !== 'workspace') {
    return c.json({ ok: false, error: `invalid scope: ${scope}` }, 400);
  }
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  return c.json({ ok: true, file: readMemoryFile(scope as MemoryScope, runtime.folderPath) });
});

/** Memory file write. Body: `{ content: string }`. Creates parent dirs and the
 *  file itself if missing. */
app.put('/api/projects/:projectId/memory/:scope', async (c) => {
  const id = c.req.param('projectId');
  const scope = c.req.param('scope');
  if (scope !== 'user' && scope !== 'project' && scope !== 'workspace') {
    return c.json({ ok: false, error: `invalid scope: ${scope}` }, 400);
  }
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{ content?: string }>();
  if (typeof body.content !== 'string') {
    return c.json({ ok: false, error: 'content required' }, 400);
  }
  const file = writeMemoryFile(scope as MemoryScope, runtime.folderPath, body.content);
  return c.json({ ok: true, file });
});

// ── Project-scoped endpoints ──────────────────────────────────────────────

app.get('/api/projects/:projectId', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  return c.json(runtime.workflowRuntime().readProject());
});

/** Active orchestrator session for the project (the one the chat is bound to).
 *  Returns null if no session exists yet — first ensurePty mints one. */
app.get('/api/projects/:projectId/session', (c) => {
  const id = c.req.param('projectId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const session = getActiveOrchestratorSession(id);
  return c.json({ ok: true, session });
});

/** Full history of orchestrator sessions for the project (most recent first).
 *  Feeds the "previous sessions" rail tab. */
app.get('/api/projects/:projectId/sessions', (c) => {
  const id = c.req.param('projectId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  return c.json({ ok: true, sessions: listOrchestratorSessionsForProject(id) });
});

/** Replay a specific session's events.jsonl. Used by the Sessions tab to
 *  render past chats in read-only mode. */
app.get('/api/projects/:projectId/sessions/:sessionId/events', (c) => {
  const id = c.req.param('projectId') as ULID;
  const sessionId = c.req.param('sessionId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const eventsFile = resolve(runtime.sessionDataPath(sessionId), 'events.jsonl');
  if (!existsSync(eventsFile)) return c.json({ ok: true, events: [] });
  try {
    const lines = readFileSync(eventsFile, 'utf-8').split('\n').filter(Boolean);
    const events: unknown[] = [];
    for (const line of lines) {
      try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
    return c.json({ ok: true, events });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

/** Start a fresh session: end the active row, wipe per-project chat files,
 *  kill the PTY, then immediately respawn so the UI sees a live state. */
app.post('/api/projects/:projectId/sessions/new', (c) => {
  const id = c.req.param('projectId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const session = runtime.startNewSession();
  const pty = runtime.ensurePty();
  attachPtyHandlers(id, runtime, pty);
  // Tell every subscriber to clear its local chat state; the next replay will
  // be empty (we just wiped events.jsonl) so the panel starts blank.
  broadcastTo(id, { type: 'session-changed', session });
  return c.json({ ok: true, session });
});

// ── Agent-creator transient session (Section 3 phase 3e.3) ─────────────────
//
// One-off PtySession per project for the conversational "Create Agent" modal.
// Layers `agent-creator-prompt.md` on top of CC's default system prompt; same
// project cwd as the orchestrator so `.mcp.json` (pc-rig) is wired in. Lifetime
// = modal-open. Closes implicitly when `pc_create_agent` fires (the route
// broadcasts `project-agents-changed`, modal handles cleanup).
//
// WS envelopes are distinct from the orchestrator stream so the modal can
// subscribe without filtering on session origin:
//   { type: 'agent-creator-state', state }
//   { type: 'agent-creator-event', event }       — legacy hook events
//   { type: 'agent-creator-jsonl', event }       — JSONL tailer events
//   { type: 'agent-creator-exit', code, signal }

function attachAgentCreatorHandlers(
  projectId: ULID,
  session: ReturnType<ProjectRuntime['startAgentCreator']>,
): void {
  const flag = session as unknown as { __pcAgentCreatorAttached?: boolean };
  if (flag.__pcAgentCreatorAttached) return;
  session.on('state', (state: string) =>
    broadcastTo(projectId, { type: 'agent-creator-state', state }),
  );
  session.on('event', (event: unknown) =>
    broadcastTo(projectId, { type: 'agent-creator-event', event }),
  );
  session.on('jsonl-event', (event: unknown) =>
    broadcastTo(projectId, { type: 'agent-creator-jsonl', event }),
  );
  session.on('exit', (code: number | undefined, signal: string | undefined) => {
    broadcastTo(projectId, { type: 'agent-creator-exit', code, signal });
  });
  flag.__pcAgentCreatorAttached = true;
}

app.post('/api/projects/:projectId/agent-creator/start', (c) => {
  const id = c.req.param('projectId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const session = runtime.startAgentCreator();
  attachAgentCreatorHandlers(id, session);
  return c.json({ ok: true, state: session.getState() });
});

app.post('/api/projects/:projectId/agent-creator/send', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const session = runtime.agentCreatorPty();
  if (!session) return c.json({ ok: false, error: 'no agent-creator session' }, 409);
  const body = await c.req.json<{ text?: string }>();
  if (typeof body.text !== 'string' || body.text === '') {
    return c.json({ ok: false, error: 'text required' }, 400);
  }
  session.send(body.text);
  return c.json({ ok: true });
});

app.post('/api/projects/:projectId/agent-creator/interrupt', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  runtime.agentCreatorPty()?.interrupt();
  return c.json({ ok: true });
});

app.delete('/api/projects/:projectId/agent-creator', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  runtime.endAgentCreator();
  return c.json({ ok: true });
});

// ── Workflow-creator transient session (Section 4b phase 4b.3) ─────────────
//
// Mirror of the agent-creator wiring above. One-off PtySession per project
// for the conversational "+ New workflow" modal. Layers
// `workflow-creator-prompt.md` on top of CC's default system prompt; same
// project cwd as the orchestrator so `.mcp.json` (pc-rig) is wired in.
//
// WS envelopes (distinct from the orchestrator + agent-creator streams):
//   { type: 'workflow-creator-state', state }
//   { type: 'workflow-creator-event', event }       — legacy hook events
//   { type: 'workflow-creator-jsonl', event }       — JSONL tailer events
//   { type: 'workflow-creator-exit', code, signal }
//   { type: 'workflow-creator-draft', sessionId, def } — broadcast by the
//     /workflow-creator/draft POST handler when pc_update_workflow_draft fires

function attachWorkflowCreatorHandlers(
  projectId: ULID,
  session: ReturnType<ProjectRuntime['startWorkflowCreator']>,
): void {
  const flag = session as unknown as { __pcWorkflowCreatorAttached?: boolean };
  if (flag.__pcWorkflowCreatorAttached) return;
  session.on('state', (state: string) =>
    broadcastTo(projectId, { type: 'workflow-creator-state', state }),
  );
  session.on('event', (event: unknown) =>
    broadcastTo(projectId, { type: 'workflow-creator-event', event }),
  );
  session.on('jsonl-event', (event: unknown) =>
    broadcastTo(projectId, { type: 'workflow-creator-jsonl', event }),
  );
  session.on('exit', (code: number | undefined, signal: string | undefined) => {
    broadcastTo(projectId, { type: 'workflow-creator-exit', code, signal });
  });
  flag.__pcWorkflowCreatorAttached = true;
}

app.post('/api/projects/:projectId/workflow-creator/start', (c) => {
  const id = c.req.param('projectId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const session = runtime.startWorkflowCreator();
  attachWorkflowCreatorHandlers(id, session);
  return c.json({
    ok: true,
    state: session.getState(),
    sessionId: runtime.workflowCreatorSession(),
  });
});

app.post('/api/projects/:projectId/workflow-creator/send', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const session = runtime.workflowCreatorPty();
  if (!session) return c.json({ ok: false, error: 'no workflow-creator session' }, 409);
  const body = await c.req.json<{ text?: string }>();
  if (typeof body.text !== 'string' || body.text === '') {
    return c.json({ ok: false, error: 'text required' }, 400);
  }
  session.send(body.text);
  return c.json({ ok: true });
});

app.post('/api/projects/:projectId/workflow-creator/interrupt', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  runtime.workflowCreatorPty()?.interrupt();
  return c.json({ ok: true });
});

app.delete('/api/projects/:projectId/workflow-creator', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  runtime.endWorkflowCreator();
  return c.json({ ok: true });
});

// ── Setup-wizard transient session (Section 5.6 / D82) ─────────────────────
//
// Conversational interview that writes CLAUDE.md. Mirrors the agent-creator
// + workflow-creator wiring above. WS envelopes:
//   { type: 'setup-wizard-state', state }
//   { type: 'setup-wizard-event', event }
//   { type: 'setup-wizard-jsonl', event }
//   { type: 'setup-wizard-exit', code, signal }

function attachSetupWizardHandlers(
  projectId: ULID,
  session: ReturnType<ProjectRuntime['startSetupWizard']>,
): void {
  const flag = session as unknown as { __pcSetupWizardAttached?: boolean };
  if (flag.__pcSetupWizardAttached) return;
  session.on('state', (state: string) =>
    broadcastTo(projectId, { type: 'setup-wizard-state', state }),
  );
  session.on('event', (event: unknown) =>
    broadcastTo(projectId, { type: 'setup-wizard-event', event }),
  );
  session.on('jsonl-event', (event: unknown) =>
    broadcastTo(projectId, { type: 'setup-wizard-jsonl', event }),
  );
  session.on('exit', (code: number | undefined, signal: string | undefined) => {
    broadcastTo(projectId, { type: 'setup-wizard-exit', code, signal });
  });
  flag.__pcSetupWizardAttached = true;
}

app.post('/api/projects/:projectId/setup-wizard/start', (c) => {
  const id = c.req.param('projectId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const session = runtime.startSetupWizard();
  attachSetupWizardHandlers(id, session);
  return c.json({ ok: true, state: session.getState() });
});

app.post('/api/projects/:projectId/setup-wizard/send', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const session = runtime.setupWizardPty();
  if (!session) return c.json({ ok: false, error: 'no setup-wizard session' }, 409);
  const body = await c.req.json<{ text?: string }>();
  if (typeof body.text !== 'string' || body.text === '') {
    return c.json({ ok: false, error: 'text required' }, 400);
  }
  session.send(body.text);
  return c.json({ ok: true });
});

app.post('/api/projects/:projectId/setup-wizard/interrupt', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  runtime.setupWizardPty()?.interrupt();
  return c.json({ ok: true });
});

app.delete('/api/projects/:projectId/setup-wizard', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  runtime.endSetupWizard();
  return c.json({ ok: true });
});

/** D82 detection: is the project's CLAUDE.md missing or effectively empty?
 *  "Empty" means a file whose content is whitespace-only — the nag surface
 *  in Project Settings keys off this. */
app.get('/api/projects/:projectId/claude-md-status', (c) => {
  const id = c.req.param('projectId') as ULID;
  const project = getProjectById(id);
  if (!project) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const path = resolve(project.folderPath, 'CLAUDE.md');
  if (!existsSync(path)) return c.json({ ok: true, exists: false, empty: true });
  try {
    const content = readFileSync(path, 'utf-8');
    return c.json({ ok: true, exists: true, empty: content.trim().length === 0 });
  } catch (err) {
    return c.json({ ok: false, error: `read failed: ${(err as Error).message}` }, 500);
  }
});

/** D82 write — backs the `pc_write_claude_md` MCP tool. Writes the full body
 *  to `<folder>/CLAUDE.md`, overwriting whatever was there. Broadcasts
 *  `project-claude-md-changed` so the wizard modal can close itself + the
 *  Project Settings nag banner can clear. */
app.put('/api/projects/:projectId/claude-md', async (c) => {
  const id = c.req.param('projectId') as ULID;
  const project = getProjectById(id);
  if (!project) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{ content?: string }>();
  if (typeof body.content !== 'string' || body.content.trim().length === 0) {
    return c.json({ ok: false, error: 'content required (non-empty)' }, 400);
  }
  const path = resolve(project.folderPath, 'CLAUDE.md');
  try {
    writeFileSync(path, body.content, 'utf-8');
  } catch (err) {
    return c.json({ ok: false, error: `write failed: ${(err as Error).message}` }, 500);
  }
  broadcastTo(id, { type: 'project-claude-md-changed' });
  return c.json({ ok: true });
});

/** List work items with optional filters + cursor pagination. Query params:
 *    stage             — filter to a single stage id
 *    parentId          — '' (string) means top-level (parentId === null); other = exact match
 *    includeArchived   — '1' = return soft-deleted rows instead of live ones
 *    cursor            — ULID; returns items where id > cursor
 *    limit             — 1..500, default 200
 *  Legacy callers that omit all params keep the prior `{ workItems: [...] }` shape. */
app.get('/api/projects/:projectId/work-items', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const q = c.req.query();
  const hasFilters =
    q.stage !== undefined ||
    q.parentId !== undefined ||
    q.includeArchived !== undefined ||
    q.cursor !== undefined ||
    q.limit !== undefined;
  if (!hasFilters) {
    return c.json(runtime.workflowRuntime().readWorkItems());
  }
  const listOpts: {
    stage?: string;
    parentId?: ULID | null;
    includeArchived?: boolean;
    cursor?: ULID;
    limit?: number;
  } = {};
  if (q.stage !== undefined) listOpts.stage = q.stage;
  if (q.parentId !== undefined) listOpts.parentId = q.parentId === '' ? null : (q.parentId as ULID);
  if (q.includeArchived === '1') listOpts.includeArchived = true;
  if (q.cursor !== undefined) listOpts.cursor = q.cursor as ULID;
  if (q.limit !== undefined) {
    const n = Number(q.limit);
    if (Number.isFinite(n)) listOpts.limit = n;
  }
  return c.json(runtime.workItemService().list(listOpts));
});

/** Legacy move endpoint. Delegates to workflowRuntime.moveWorkItem (workflow-
 *  firing path). The new `/work-items/:wiId/move` is the version-checked UI
 *  path; this one stays for MCP backwards-compat + workflow re-fire flows. */
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
    broadcastTo(id as ULID, { type: 'work-items-changed', change: 'moved', workItem });
    return c.json({ ok: true, workItem });
  } catch (err) {
    const msg = (err as Error).message;
    const is409 = /^ambiguous trigger|^no valid workflow|is locked: workflow in progress/.test(msg);
    return c.json({ ok: false, error: msg }, is409 ? 409 : 500);
  }
});

/** Legacy fields-merge endpoint. Used by MCP `pc_update_work_item`. The new
 *  `PATCH /work-items/:wiId` is the version-checked UI path. */
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
    broadcastTo(id as ULID, { type: 'work-items-changed', change: 'updated', workItem });
    return c.json({ ok: true, workItem });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

/** Create endpoint. Routes directly through WorkItemService so the UI can pass
 *  parentId for child creation. Workflow-runtime's createWorkItem shim still
 *  delegates to the same service for internal callers (no parentId there). */
app.post('/api/projects/:projectId/work-items/create', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{
    title?: string;
    stageId?: string;
    body?: string;
    parentId?: string | null;
    fields?: Record<string, unknown>;
  }>();
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const stageId = typeof body.stageId === 'string' ? body.stageId.trim() : '';
  if (!title || !stageId) return c.json({ ok: false, error: 'title and stageId required' }, 400);
  try {
    // Service broadcasts 'created' internally; the route does not re-broadcast.
    const workItem = runtime.workItemService().create({
      title,
      stageId,
      ...(body.body !== undefined ? { body: body.body } : {}),
      ...(body.parentId !== undefined ? { parentId: body.parentId as ULID | null } : {}),
      ...(body.fields !== undefined ? { fields: body.fields } : {}),
    });
    return c.json({ ok: true, workItem });
  } catch (err) {
    if (err instanceof FieldValidationError) {
      return c.json({ ok: false, error: err.message, errors: err.errors }, 400);
    }
    if (err instanceof UnknownStageError) {
      return c.json({ ok: false, error: err.message }, 400);
    }
    const msg = (err as Error).message;
    const is400 = /^unknown stage:|^title required$/.test(msg);
    return c.json({ ok: false, error: msg }, is400 ? 400 : 500);
  }
});

// ── Work item :wiId routes (new) ──────────────────────────────────────────

/** Fetch a single work item by id. `?includeArchived=1` returns soft-deleted
 *  rows too (used by restore flows). */
app.get('/api/projects/:projectId/work-items/:wiId', (c) => {
  const id = c.req.param('projectId');
  const wiId = c.req.param('wiId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const includeArchived = c.req.query('includeArchived') === '1';
  const workItem = runtime.workItemService().get(wiId, { includeArchived });
  if (!workItem) return c.json({ ok: false, error: `unknown work item: ${wiId}` }, 404);
  if (workItem.projectId !== id) return c.json({ ok: false, error: `unknown work item: ${wiId}` }, 404);
  return c.json({ ok: true, workItem });
});

/** Version-checked patch. Body: `{ version, title?, body?, stageId?, parentId?,
 *  position?, fields? }`. 409 on version mismatch with the current row. */
app.patch('/api/projects/:projectId/work-items/:wiId', async (c) => {
  const id = c.req.param('projectId');
  const wiId = c.req.param('wiId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{
    version?: number;
    title?: string;
    body?: string;
    stageId?: string;
    parentId?: string | null;
    position?: number;
    fields?: Record<string, unknown>;
  }>();
  if (typeof body.version !== 'number') {
    return c.json({ ok: false, error: 'version required' }, 400);
  }
  try {
    const input: Parameters<ReturnType<typeof runtime.workItemService>['patch']>[1] = {
      expectedVersion: body.version,
    };
    if (body.title !== undefined) input.title = body.title;
    if (body.body !== undefined) input.body = body.body;
    if (body.stageId !== undefined) input.stageId = body.stageId;
    if (body.parentId !== undefined) input.parentId = body.parentId as ULID | null;
    if (body.position !== undefined) input.position = body.position;
    if (body.fields !== undefined) input.fields = body.fields;
    const workItem = runtime.workItemService().patch(wiId, input);
    return c.json({ ok: true, workItem });
  } catch (err) {
    if (err instanceof WorkItemVersionConflictError) {
      return c.json({ ok: false, error: err.message, current: err.current }, 409);
    }
    if (err instanceof FieldValidationError) {
      return c.json({ ok: false, error: err.message, errors: err.errors }, 400);
    }
    if (err instanceof UnknownStageError) {
      return c.json({ ok: false, error: err.message }, 400);
    }
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

/** Version-checked stage move + optional position. Body: `{ version, stageId,
 *  position? }`. Does NOT fire workflows in this slice — UI drag-and-drop
 *  routes through this; workflow-firing routes (legacy /move) handle the
 *  on_enter trigger path separately. */
app.post('/api/projects/:projectId/work-items/:wiId/move', async (c) => {
  const id = c.req.param('projectId');
  const wiId = c.req.param('wiId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{ version?: number; stageId?: string; position?: number }>();
  if (typeof body.version !== 'number') {
    return c.json({ ok: false, error: 'version required' }, 400);
  }
  const stageId = typeof body.stageId === 'string' ? body.stageId.trim() : '';
  if (!stageId) return c.json({ ok: false, error: 'stageId required' }, 400);
  try {
    const moveArgs: Parameters<ReturnType<typeof runtime.workflowRuntime>['moveAndFire']>[0] = {
      id: wiId,
      toStage: stageId,
      expectedVersion: body.version,
    };
    if (body.position !== undefined) moveArgs.position = body.position;
    const workItem = await runtime.workflowRuntime().moveAndFire(moveArgs);
    return c.json({ ok: true, workItem });
  } catch (err) {
    if (err instanceof WorkItemVersionConflictError) {
      return c.json({ ok: false, error: err.message, current: err.current }, 409);
    }
    if (err instanceof UnknownStageError) {
      return c.json({ ok: false, error: err.message }, 400);
    }
    const msg = (err as Error).message;
    const is409 = /^ambiguous trigger|^no valid workflow|is locked: workflow in progress/.test(msg);
    return c.json({ ok: false, error: msg }, is409 ? 409 : 500);
  }
});

/** Soft-delete a work item. Sets `deletedAt` + `status='archived'`. */
app.delete('/api/projects/:projectId/work-items/:wiId', (c) => {
  const id = c.req.param('projectId');
  const wiId = c.req.param('wiId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  try {
    runtime.workItemService().softDelete(wiId);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 404);
  }
});

/** Restore a soft-deleted work item. Clears `deletedAt`, resets status to
 *  `pending`. 404 if the row isn't archived. */
app.post('/api/projects/:projectId/work-items/:wiId/restore', (c) => {
  const id = c.req.param('projectId');
  const wiId = c.req.param('wiId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  try {
    const workItem = runtime.workItemService().restore(wiId);
    return c.json({ ok: true, workItem });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 404);
  }
});

// ── Attachments ───────────────────────────────────────────────────────────

/** List a work item's attachments. */
app.get('/api/projects/:projectId/work-items/:wiId/attachments', (c) => {
  const id = c.req.param('projectId');
  const wiId = c.req.param('wiId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  try {
    return c.json({ ok: true, items: runtime.attachmentService().list(wiId) });
  } catch (err) {
    if (err instanceof AttachmentNotInProjectError) {
      return c.json({ ok: false, error: err.message }, 404);
    }
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

/** Fetch one attachment by id (includes inline content). */
app.get('/api/projects/:projectId/work-items/:wiId/attachments/:aId', (c) => {
  const id = c.req.param('projectId');
  const aId = c.req.param('aId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  try {
    return c.json({ ok: true, attachment: runtime.attachmentService().get(aId) });
  } catch (err) {
    if (err instanceof AttachmentNotInProjectError) {
      return c.json({ ok: false, error: err.message }, 404);
    }
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

/** Hard-delete an attachment. */
app.delete('/api/projects/:projectId/work-items/:wiId/attachments/:aId', (c) => {
  const id = c.req.param('projectId');
  const aId = c.req.param('aId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  try {
    runtime.attachmentService().delete(aId);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof AttachmentNotInProjectError) {
      return c.json({ ok: false, error: err.message }, 404);
    }
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

/** Create an attachment on a work item. Body: `{ kind, name, content,
 *  contentType?, runId?, source?, agentName?, nodeId? }`. Used by the MCP
 *  `pc_attach_to_work_item` tool (subagent path) and any UI/test path that
 *  needs to seed an attachment. Provenance defaults to `source: 'user'`. */
app.post('/api/projects/:projectId/work-items/:wiId/attachments', async (c) => {
  const id = c.req.param('projectId');
  const wiId = c.req.param('wiId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const payload = await c.req.json<{
    kind?: string;
    name?: string;
    content?: string;
    contentType?: string | null;
    runId?: ULID | null;
    source?: 'agent' | 'user';
    agentName?: string | null;
    nodeId?: string | null;
  }>();
  const kind = typeof payload.kind === 'string' && payload.kind.trim() ? payload.kind.trim() : 'text';
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  const content = typeof payload.content === 'string' ? payload.content : '';
  if (!name) return c.json({ ok: false, error: 'name required' }, 400);
  if (!content) return c.json({ ok: false, error: 'content required' }, 400);
  try {
    const attachment = runtime.attachmentService().create({
      workItemId: wiId,
      kind,
      name,
      content,
      contentType: payload.contentType ?? null,
      runId: payload.runId ?? null,
      source: payload.source === 'agent' ? 'agent' : 'user',
      agentName: payload.agentName ?? null,
      nodeId: payload.nodeId ?? null,
    });
    return c.json({ ok: true, attachment }, 201);
  } catch (err) {
    if (err instanceof AttachmentNotInProjectError) {
      return c.json({ ok: false, error: err.message }, 404);
    }
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

// ── Stages editor (orphan-check on delete) ────────────────────────────────

/** Bulk replace a project's stages. Body: `{ stages: Stage[], force?: boolean,
 *  fallbackStageId?: string }`. If `force !== true`, removing a stage that has
 *  live work items returns 409 `STAGE_HAS_ITEMS` with the item count. With
 *  `force: true` + `fallbackStageId`, items in removed stages are reassigned. */
app.patch('/api/projects/:projectId/stages', async (c) => {
  const id = c.req.param('projectId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{
    stages?: Stage[];
    force?: boolean;
    fallbackStageId?: string;
  }>();
  if (!Array.isArray(body.stages)) {
    return c.json({ ok: false, error: 'stages array required' }, 400);
  }
  const incoming = body.stages.map((s, idx) => ({
    id: String(s.id ?? '').trim(),
    name: String(s.name ?? '').trim(),
    order: typeof s.order === 'number' ? s.order : idx,
  }));
  if (incoming.some((s) => !s.id || !s.name)) {
    return c.json({ ok: false, error: 'each stage requires id + name' }, 400);
  }
  const ids = new Set(incoming.map((s) => s.id));
  if (ids.size !== incoming.length) {
    return c.json({ ok: false, error: 'duplicate stage id' }, 400);
  }

  const project = getProjectById(id);
  if (!project) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);

  const removed = project.stages.filter((s) => !ids.has(s.id));
  if (removed.length > 0 && body.force !== true) {
    const orphans = removed.map((s) => ({ id: s.id, name: s.name, count: countWorkItemsInStage(id, s.id) }));
    const totalCount = orphans.reduce((sum, o) => sum + o.count, 0);
    if (totalCount > 0) {
      return c.json(
        {
          ok: false,
          error: 'STAGE_HAS_ITEMS',
          orphans: orphans.filter((o) => o.count > 0),
        },
        409,
      );
    }
  }

  if (removed.length > 0 && body.force === true) {
    const fallbackId = String(body.fallbackStageId ?? '').trim();
    if (!fallbackId || !ids.has(fallbackId)) {
      return c.json({ ok: false, error: 'fallbackStageId required + must reference a retained stage' }, 400);
    }
    for (const r of removed) {
      reassignStage(id, r.id, fallbackId);
    }
  }

  updateProjectStages(id, incoming);
  const updated = getProjectById(id);
  if (!updated) return c.json({ ok: false, error: 'project disappeared after stage update' }, 500);
  projectRegistry.refresh(updated);
  broadcastTo(id, { type: 'stages-changed', stages: updated.stages });
  return c.json({ ok: true, project: updated });
});

// ── Field schemas ─────────────────────────────────────────────────────────

app.get('/api/projects/:projectId/field-schemas', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  return c.json({ ok: true, items: runtime.fieldSchemaService().list() });
});

/** Bulk-replace field schemas. Body: `{ items: FieldSchema[] }`. Explicit ids
 *  in the input are preserved (so edits keep stable identity); missing ids get
 *  freshly minted ULIDs. */
app.put('/api/projects/:projectId/field-schemas', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{ items?: unknown }>();
  if (!Array.isArray(body.items)) {
    return c.json({ ok: false, error: 'items array required' }, 400);
  }
  try {
    const items = runtime.fieldSchemaService().replace(body.items as Parameters<ReturnType<typeof runtime.fieldSchemaService>['replace']>[0]);
    return c.json({ ok: true, items });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
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
      // 4f / D62 + D67. UI reads these to drive the disabled-row visual +
      // the Run-now / manual-fire shape. Defaults preserve today's behavior
      // (disabled=false; attached defaults to 'optional' when absent).
      disabled: e.workflow.disabled === true,
      attachedToWorkItem: e.workflow.attached_to_work_item ?? 'optional',
      fileName: e.fileName,
    })),
    invalid: state.invalid.map((e) => ({
      fileName: e.fileName,
      partialStageId: e.partialStageId ?? null,
      errors: e.errors,
    })),
  });
});

// 4e.4 / D51. Per-workflow detail. Returns the full Workflow def so the
// drawer's Definition tab can render the read-only graph viewer without a
// separate "list with full defs" inflated payload. 404 on unknown id (parse
// failures stay invisible here — the list endpoint already surfaces them
// under `invalid[]`).
app.get('/api/projects/:projectId/workflows/:wfId', (c) => {
  const id = c.req.param('projectId');
  const wfId = c.req.param('wfId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const state = runtime.workflowRegistry().reload();
  const entry = state.valid.find((e) => e.workflow.id === wfId);
  if (!entry) return c.json({ ok: false, error: `unknown workflow: ${wfId}` }, 404);
  // 4f.2 — also return the raw YAML text on disk so the edit modal's
  // raw-YAML tab (D61 PM escape hatch) can render exactly what's saved,
  // comments + key order intact. Best-effort read; falls back to an empty
  // string if the file vanished between reload + read.
  const dir = resolve(runtime.folderPath, '.project-companion', 'workflows');
  const filePath = resolve(dir, entry.fileName);
  let yamlText = '';
  try {
    yamlText = readFileSync(filePath, 'utf-8');
  } catch {
    /* best-effort */
  }
  // 4h.11a — typed edges accompany the workflow def so the graph viewer can
  // walk structured wires instead of regex-parsing legacy strings.
  return c.json({
    ok: true,
    workflow: entry.workflow,
    edges: entry.edges,
    fileName: entry.fileName,
    yamlText,
  });
});

/** 4b.1: create a new project-scoped workflow YAML from a typed `def`. Mirrors
 *  the agent-creation path. `def` is the same shape parseWorkflowText would
 *  produce, minus the post-parse `kind:` discriminator (which never appears
 *  on disk). Server validates against the workflow parser, serializes via
 *  serializeWorkflow, writes to `<project>/.project-companion/workflows/<id>.yaml`,
 *  and broadcasts `project-workflows-changed`. 409 on id collision; 400 on
 *  validation errors. */
app.post('/api/projects/:projectId/workflows', async (c) => {
  const id = c.req.param('projectId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const payload = await c.req.json<{ def?: unknown }>();
  if (!payload.def || typeof payload.def !== 'object') {
    return c.json({ ok: false, error: 'def required' }, 400);
  }
  const rawDef = payload.def as Record<string, unknown>;
  const wfId = typeof rawDef.id === 'string' ? rawDef.id : '';
  if (!wfId) {
    return c.json({ ok: false, error: 'def.id required' }, 400);
  }

  const validation = validateWorkflow(rawDef, { expectedId: wfId });
  if (!validation.ok || !validation.workflow) {
    return c.json(
      { ok: false, error: 'invalid workflow', errors: validation.errors },
      400,
    );
  }

  const dir = resolve(runtime.folderPath, '.project-companion', 'workflows');
  const filePath = resolve(dir, `${wfId}.yaml`);
  if (existsSync(filePath)) {
    return c.json(
      { ok: false, error: `workflow already exists: ${wfId}` },
      409,
    );
  }

  try {
    mkdirSync(dir, { recursive: true });
    const yamlText = serializeWorkflow(validation.workflow);
    writeFileSync(filePath, yamlText, 'utf-8');
    broadcastTo(id, { type: 'project-workflows-changed', change: 'created', id: wfId });
    return c.json(
      {
        ok: true,
        workflow: { id: wfId, fileName: `${wfId}.yaml`, path: filePath },
      },
      201,
    );
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

/** 4f.1 / D61. Edit an existing workflow in place. Reuses the create-time
 *  validator + serializer. Rejects an id rename (use duplicate + delete
 *  instead). Same shape rules as create: 400 on shape errors, 404 when the
 *  target file doesn't exist. WS broadcast carries `change: 'updated'` so
 *  the disabled/enable toggle (PUT with body.disabled flipped) and content
 *  edits all surface through the same envelope. */
app.put('/api/projects/:projectId/workflows/:wfId', async (c) => {
  const id = c.req.param('projectId') as ULID;
  const wfId = c.req.param('wfId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);

  // 4f.2 / D61. Accepts either `def` (typed path, used by conversational
  // edits + lifecycle toggles like disable/enable) or `yamlText` (PM
  // escape hatch — the raw-YAML tab). yamlText is parsed via parseWorkflowText
  // so it goes through the same validator; round-trip preserves comments +
  // key order via the serializer.
  const payload = await c.req.json<{ def?: unknown; yamlText?: string }>();

  let rawDef: Record<string, unknown> | null = null;
  if (typeof payload.yamlText === 'string') {
    const parsed = parseWorkflowText(payload.yamlText, { expectedId: wfId });
    if (!parsed.ok || !parsed.workflow) {
      return c.json(
        { ok: false, error: 'invalid workflow', errors: parsed.errors },
        400,
      );
    }
    rawDef = parsed.workflow as unknown as Record<string, unknown>;
  } else if (payload.def && typeof payload.def === 'object') {
    rawDef = payload.def as Record<string, unknown>;
  } else {
    return c.json({ ok: false, error: 'def or yamlText required' }, 400);
  }

  if (typeof rawDef.id !== 'string' || rawDef.id !== wfId) {
    return c.json(
      {
        ok: false,
        error: `def.id must match URL workflow id (${wfId}); rename via duplicate + delete`,
      },
      400,
    );
  }

  const dir = resolve(runtime.folderPath, '.project-companion', 'workflows');
  const filePath = resolve(dir, `${wfId}.yaml`);
  if (!existsSync(filePath)) {
    return c.json({ ok: false, error: `unknown workflow: ${wfId}` }, 404);
  }

  const validation = validateWorkflow(rawDef, { expectedId: wfId });
  if (!validation.ok || !validation.workflow) {
    return c.json(
      { ok: false, error: 'invalid workflow', errors: validation.errors },
      400,
    );
  }

  try {
    const yamlText = serializeWorkflow(validation.workflow);
    writeFileSync(filePath, yamlText, 'utf-8');
    // The `change` value lets clients distinguish a content edit from a
    // pure disable/enable flip. Use the persisted disabled flag (not the
    // request body) so a save that flips `disabled` is identified faithfully.
    const change =
      validation.workflow.disabled === true ? 'disabled' : 'updated';
    broadcastTo(id, { type: 'project-workflows-changed', change, id: wfId });
    return c.json({
      ok: true,
      workflow: { id: wfId, fileName: `${wfId}.yaml`, path: filePath },
    });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

/** 4f.1 / D60. Delete a workflow YAML. Blocks on in-flight runs (returns 409
 *  with the run-id list); use the cancel-runs-and-delete endpoint to force
 *  through. Historical `workflow_runs` rows stay — they're orphan-by-
 *  workflowId after delete but still reachable from 4e's drawer by runId. */
app.delete('/api/projects/:projectId/workflows/:wfId', (c) => {
  const id = c.req.param('projectId') as ULID;
  const wfId = c.req.param('wfId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);

  const dir = resolve(runtime.folderPath, '.project-companion', 'workflows');
  const filePath = resolve(dir, `${wfId}.yaml`);
  if (!existsSync(filePath)) {
    return c.json({ ok: false, error: `unknown workflow: ${wfId}` }, 404);
  }

  const inFlight = runtime.workflowRuntime().inFlightRunsForWorkflow(wfId);
  if (inFlight.length > 0) {
    return c.json(
      {
        ok: false,
        error: `workflow has ${inFlight.length} in-flight run(s); cancel them first`,
        inFlightRunIds: inFlight.map((r) => r.id),
      },
      409,
    );
  }

  try {
    rmSync(filePath);
    broadcastTo(id, { type: 'project-workflows-changed', change: 'deleted', id: wfId });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

/** 4f.1 / D60. Cancel-then-delete escape for the in-flight-runs guard.
 *  Walks every in-flight run for this workflow, marks each cancelled with
 *  the supplied reason (defaults to "workflow deleted"), then removes the
 *  YAML. 404 when the workflow file is missing. */
app.post('/api/projects/:projectId/workflows/:wfId/cancel-runs-and-delete', async (c) => {
  const id = c.req.param('projectId') as ULID;
  const wfId = c.req.param('wfId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);

  const body = await c.req
    .json<{ reason?: string }>()
    .catch(() => ({}) as { reason?: string });
  const reason =
    typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim()
      : 'workflow deleted';

  const dir = resolve(runtime.folderPath, '.project-companion', 'workflows');
  const filePath = resolve(dir, `${wfId}.yaml`);
  if (!existsSync(filePath)) {
    return c.json({ ok: false, error: `unknown workflow: ${wfId}` }, 404);
  }

  const wfRuntime = runtime.workflowRuntime();
  const inFlight = wfRuntime.inFlightRunsForWorkflow(wfId);
  for (const run of inFlight) {
    await wfRuntime.cancelRunExternal(run.id, reason);
  }

  try {
    rmSync(filePath);
    broadcastTo(id, { type: 'project-workflows-changed', change: 'deleted', id: wfId });
    return c.json({ ok: true, cancelledRunIds: inFlight.map((r) => r.id) });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

/** 4f.1 / D63. Duplicate a workflow YAML. New id required; defaults to
 *  `<source>-copy[-N]` if absent. Duplicate is force-disabled so the user
 *  doesn't accidentally fire two near-identical workflows on the same
 *  trigger. Triggers block is preserved as-is — user reviews + adjusts via
 *  the edit modal. 409 on newId collision; 404 on missing source. */
app.post('/api/projects/:projectId/workflows/:wfId/duplicate', async (c) => {
  const id = c.req.param('projectId') as ULID;
  const wfId = c.req.param('wfId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);

  const body = await c.req
    .json<{ newId?: string }>()
    .catch(() => ({}) as { newId?: string });

  const dir = resolve(runtime.folderPath, '.project-companion', 'workflows');
  const srcPath = resolve(dir, `${wfId}.yaml`);
  if (!existsSync(srcPath)) {
    return c.json({ ok: false, error: `unknown workflow: ${wfId}` }, 404);
  }

  // Default new id walks `<src>-copy`, `<src>-copy-2`, `<src>-copy-3`, …
  let newId = typeof body.newId === 'string' && body.newId.trim() ? body.newId.trim() : '';
  if (!newId) {
    newId = `${wfId}-copy`;
    let n = 2;
    while (existsSync(resolve(dir, `${newId}.yaml`))) {
      newId = `${wfId}-copy-${n++}`;
    }
  }
  const newPath = resolve(dir, `${newId}.yaml`);
  if (existsSync(newPath)) {
    return c.json({ ok: false, error: `workflow already exists: ${newId}` }, 409);
  }

  let srcText = '';
  try {
    srcText = readFileSync(srcPath, 'utf-8');
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }

  // Parse + mutate + validate with the new id; serialize round-trip-stable.
  const parsed = parseWorkflowText(srcText, { expectedId: wfId });
  if (!parsed.ok || !parsed.workflow) {
    return c.json(
      {
        ok: false,
        error: `source workflow is invalid; cannot duplicate. Errors: ${parsed.errors
          .map((e) => `${e.path}: ${e.message}`)
          .join('; ')}`,
      },
      400,
    );
  }
  const cloned: Workflow = { ...parsed.workflow, id: newId, disabled: true };
  const reValidation = validateWorkflow(cloned, { expectedId: newId });
  if (!reValidation.ok || !reValidation.workflow) {
    return c.json(
      {
        ok: false,
        error: 'cloned workflow failed validation',
        errors: reValidation.errors,
      },
      400,
    );
  }

  try {
    writeFileSync(newPath, serializeWorkflow(reValidation.workflow), 'utf-8');
    broadcastTo(id, { type: 'project-workflows-changed', change: 'duplicated', id: newId });
    return c.json(
      {
        ok: true,
        workflow: { id: newId, fileName: `${newId}.yaml`, path: newPath },
      },
      201,
    );
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

/** 4f.3 / D64. Manual fire from the WorkflowList "Run now" menu. Body:
 *  `{ workItemId?, inputs? }`. The runtime enforces D62 (no disabled),
 *  D67/D71 (Work Contract attached_to_work_item), and the card-lock guard
 *  (matches drag-fire). 4xx error shapes:
 *    - 404 → unknown project / unknown workflow id / ambiguous id
 *    - 409 → workflow disabled / work item locked
 *    - 400 → Work Contract mismatch (required without card, forbidden with)
 *  Returns `{ runId }` on success — the web side opens the run-detail view. */
app.post('/api/projects/:projectId/workflows/:wfId/fire', async (c) => {
  const id = c.req.param('projectId') as ULID;
  const wfId = c.req.param('wfId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);

  const body = await c.req
    .json<{ workItemId?: string; inputs?: Record<string, unknown> }>()
    .catch(() => ({}) as { workItemId?: string; inputs?: Record<string, unknown> });

  const workItemId =
    typeof body.workItemId === 'string' && body.workItemId.trim()
      ? body.workItemId.trim()
      : undefined;
  const inputs =
    body.inputs && typeof body.inputs === 'object' && !Array.isArray(body.inputs)
      ? body.inputs
      : undefined;

  try {
    const run = await runtime.workflowRuntime().fireManually({
      workflowId: wfId,
      ...(workItemId ? { workItemId } : {}),
      ...(inputs ? { inputs } : {}),
    });
    return c.json({ ok: true, runId: run.id });
  } catch (err) {
    const msg = (err as Error).message;
    // Map runtime error shapes to HTTP codes the modal can surface cleanly.
    if (/^unknown workflow:|^no valid workflow|^ambiguous workflow id/.test(msg)) {
      return c.json({ ok: false, error: msg }, 404);
    }
    if (/ is disabled$| is locked: workflow in progress$/.test(msg)) {
      return c.json({ ok: false, error: msg }, 409);
    }
    if (
      / requires a work item to run$| cannot be attached to a work item$|^unknown work item:/.test(
        msg,
      )
    ) {
      return c.json({ ok: false, error: msg }, 400);
    }
    return c.json({ ok: false, error: msg }, 500);
  }
});

/** 4b.1: stash an in-progress draft from the workflow-creator interview.
 *  Does NOT write to disk — only the final `pc_create_workflow` does that.
 *  Broadcasts `workflow-creator-draft` so the modal's visualizer re-renders. */
app.post('/api/projects/:projectId/workflow-creator/draft', async (c) => {
  const id = c.req.param('projectId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const payload = await c.req.json<{ sessionId?: string; def?: unknown }>();
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
  if (!sessionId) {
    return c.json({ ok: false, error: 'sessionId required' }, 400);
  }
  if (!payload.def || typeof payload.def !== 'object') {
    return c.json({ ok: false, error: 'def required' }, 400);
  }
  const rawDef = payload.def as Record<string, unknown>;
  const wfId = typeof rawDef.id === 'string' && rawDef.id ? rawDef.id : '';
  if (!wfId) {
    return c.json({ ok: false, error: 'def.id required' }, 400);
  }
  // Validate so the visualizer never receives a broken draft. Errors flow
  // back through the tool-call result so the model self-corrects mid-chat.
  //
  // 4h.11a — typed-edge extraction piggy-backs on the legacy validation pass.
  // Drafts pass through iff the legacy validator accepts the structural shape
  // (preserves pre-4h authoring tolerance for mid-interview partial drafts);
  // typed edges are populated when the typed-validator additionally passes,
  // empty otherwise (so the visualizer renders sockets-without-wires, not a
  // blanket rejection mid-conversation).
  const validation = parseTypedWorkflowDef(rawDef, { expectedId: wfId });
  if (!validation.workflow) {
    return c.json(
      { ok: false, error: 'invalid workflow draft', errors: validation.errors },
      400,
    );
  }
  const def: Workflow = validation.workflow;
  const edges = validation.edges ?? {};
  runtime.setWorkflowCreatorDraft(sessionId, def);
  broadcastTo(id, { type: 'workflow-creator-draft', sessionId, def, edges });
  return c.json({ ok: true });
});

app.get('/api/projects/:projectId/workflow-runs', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const runs = runtime.workflowRuntime().readRunsForProject();
  return c.json({ runs });
});

// 4e.1 / D54. Per-run detail with the full nodeOutputs map. The list
// endpoint above already includes nodeOutputs today, so this endpoint
// exists mainly to (a) give the drawer a stable per-run cache key it can
// re-fetch, and (b) leave room for the response to grow run-detail-only
// fields without bloating the list payload (4e.6 may add resolved-inputs
// previews, attempt counters, etc.). Returns 404 for unknown projects
// AND unknown / cross-project run ids — no info leak on cross-project ids.
app.get('/api/projects/:projectId/workflow-runs/:runId', (c) => {
  const id = c.req.param('projectId');
  const runId = c.req.param('runId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const run = runtime.workflowRuntime().readRunForProject(runId);
  if (!run) return c.json({ ok: false, error: `unknown run: ${runId}` }, 404);
  return c.json({ run });
});

// 4e.2 / D53. Re-fire a failed run from a specific failed node. Returns the
// new run's id; the original run row stays intact with a lineage suffix on
// `lastReason`. 404 for unknown project / cross-project run; 400 for
// shape errors (missing nodeId, target run not failed/cancelled, target
// node not failed).
app.post('/api/projects/:projectId/workflow-runs/:runId/retry-from', async (c) => {
  const id = c.req.param('projectId');
  const runId = c.req.param('runId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{ nodeId?: string }>().catch(() => ({}) as { nodeId?: string });
  const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : '';
  if (!nodeId) return c.json({ ok: false, error: 'nodeId required' }, 400);
  const result = await runtime.workflowRuntime().retryFromFailedNode(runId, nodeId);
  if (!result.ok) {
    // Treat "unknown run" as 404; everything else (validation) as 400.
    const status = result.error.startsWith('unknown run:') ? 404 : 400;
    return c.json({ ok: false, error: result.error }, status);
  }
  return c.json({ ok: true, runId: result.runId });
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

/** Read a subagent transcript JSONL file, parse it, and return the per-line
 *  events. Path is required and MUST live under `~/.claude/projects/` — any
 *  attempt to escape (relative segments, paths outside the allowlist) returns
 *  403. Pure read-only; Section 3 / 3g transcript viewer is the only caller. */
app.get('/api/subagent-transcript', async (c) => {
  const rawPath = c.req.query('path');
  if (!rawPath || !isAbsolute(rawPath)) {
    return c.json({ ok: false, error: 'absolute path query param required' }, 400);
  }
  const allowedRoot = resolve(homedir(), '.claude', 'projects');
  const requested = resolve(rawPath);
  const rel = relative(allowedRoot, requested);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return c.json({ ok: false, error: 'path must live under ~/.claude/projects/' }, 403);
  }
  if (!existsSync(requested)) return c.json({ ok: false, error: 'transcript not found' }, 404);
  try {
    const text = await readFile(requested, 'utf-8');
    const events: unknown[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        // Skip malformed lines — JSONL tolerates partial writes mid-tail.
      }
    }
    return c.json({ ok: true, path: requested, relPath: rel, events });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
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
    // 4f / D62 — a disabled workflow surfaces as a 409 (not 500) so the
    // orchestrator can react with the right conversational turn ("that
    // workflow is paused — enable it or pick another?").
    const is409 = /^ambiguous trigger|^no valid workflow|^unknown workflow|is not callable|is disabled/.test(msg);
    return c.json({ ok: false, error: msg }, is409 ? 409 : 500);
  }
});

// Proxy to the channel server. POSTs the UI's test message to the path-routed
// channel entry at `/channel/<slug>/test` (4c / D35) so the channel server
// accepts it. Source segment `test` matches the existing `X-Sender: test`
// header.
app.post('/api/projects/:projectId/channel-send', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const slug = runtime.project.slug;
  const body = await c.req.json<{ message?: string }>();
  const message = typeof body.message === 'string' ? body.message : '';
  if (!message) return c.json({ ok: false, error: 'empty message' }, 400);

  try {
    const path = `/channel/${encodeURIComponent(slug)}/test`;
    const result = await new Promise<{ status: number; body: string }>((res, rej) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: CHANNEL_PORT,
          method: 'POST',
          path,
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
  attachPtyHandlers(projectId, runtime, session);

  // P14: tag direct-to-client sends with projectId, same as broadcastTo does
  // for fan-out paths. Keeps the envelope contract uniform.
  ws.send(JSON.stringify({ projectId, type: 'state', state: session.getState() }));

  // Replay the active session's events.jsonl so a reloaded tab doesn't lose
  // its chat panel. Past sessions render via GET /api/projects/:id/sessions/
  // :sessionId/events, not the WS replay.
  const activeSession = getActiveOrchestratorSession(projectId);
  if (activeSession) {
    const eventsFile = resolve(runtime.sessionDataPath(activeSession.id), 'events.jsonl');
    if (existsSync(eventsFile)) {
      try {
        const lines = readFileSync(eventsFile, 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
          let event: unknown;
          try { event = JSON.parse(line); } catch { continue; }
          ws.send(JSON.stringify({ projectId, type: 'event', event }));
        }
      } catch {
        /* best-effort replay */
      }
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
