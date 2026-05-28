import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { homedir } from 'node:os';

import type {
  ULID,
} from '@pc/domain';
import { validateWorkflowV2 } from '@pc/workflows';
import {
  getActiveOrchestratorSession,
  dismissFailedRun,
  insertPostTurnSummary,
  getProjectById,
  listFailedRunDismissalsForProject,
  listProjects,
  newId,
  reconcileOrphanedRunningRuns,
  runMigrations,
  setOrchestratorSessionJsonlCursor,
  setOrchestratorSessionJsonlPath,
  setOrchestratorSessionTitle,
  workflowRunsV2Repo,
} from '@pc/db';
import type { WorkflowV2 } from '@pc/domain';
import { getDataDir } from '@pc/utils';

import {
  deliverNextQueuedPrompt,
  maybeAdvanceSendQueueConfirmation,
  sendQueueSnapshotPayload,
} from './services/orchestrator-send-queue-delivery.ts';
import { OrchestratorRuntimeSnapshots } from './services/orchestrator-runtime-snapshot.ts';
import { ProjectWebSocketHub } from './services/websocket-hub.ts';
import { drainPendingForSession } from './services/agent-delivery.ts';
import { getActiveRunRegistry } from './services/agent-active-runs.ts';
import { notifyWorkflowSubagentHandshake } from './services/workflow-subagent-handshake.ts';
import { sweepStaleJsonl } from './services/jsonl-sweep.ts';
import { sweepEphemeralWorkItems } from './services/ephemeral-work-item-sweep.ts';
import { backfillStageFlags } from './services/stage-flags-backfill.ts';
import { ChannelServer } from './services/channel-server.ts';
import { ProjectCreate } from './services/project-create.ts';
import { ProjectRegistry } from './services/project-registry.ts';
import type { ProjectRuntime } from './services/project-runtime.ts';
import { ProjectScaffold } from './services/project-scaffold.ts';
import { registerFileRoutes } from './features/files/routes.ts';
import {
  applyClaudeRuntimeSettings,
  readSettings,
  registerSettingsOnboardingRoutes,
} from './features/settings-onboarding/routes.ts';
import { createRuntimeHostPtyController } from './features/runtime-host/pty-handlers.ts';
import {
  registerProjectDetailRoute,
  registerProjectRoutes,
} from './features/projects/routes.ts';
import { registerRuntimeHostRoutes } from './features/runtime-host/routes.ts';
import { registerRuntimeHostWebSocketServer } from './features/runtime-host/websocket-server.ts';
import { registerTransientSessionRoutes } from './features/transient-sessions/routes.ts';
import { registerWorkItemRoutes } from './features/work-items/routes.ts';
import { registerAgentRunRoutes } from './features/agent-runs/routes.ts';
import { registerWorktreeRoutes } from './features/project-worktrees/routes.ts';
import { registerStatuslineRoutes } from './features/statusline/routes.ts';
import { registerProjectContextRoutes } from './features/project-context/routes.ts';
import { registerPodRoutes } from './routes/pod-routes.ts';
import { registerQuickTasksRoutes } from './routes/quick-tasks-routes.ts';
import { registerWorkflowRoutes } from './routes/workflow-routes.ts';
import { seedOrchestratorPodIfMissing } from './services/orchestrator-pod-seed.ts';
import { ensureQuickTasksProject } from './services/quick-tasks-seed.ts';
import { cleanupLegacyProjectRuntimeFiles } from './services/legacy-runtime-cleanup.ts';
import { resetStockPodToDefault } from './services/stock-pod-reset.ts';
import { detectStockPodDrift, listCanonicalStockPodNames } from './services/pod-drift.ts';
import { seedStockPods } from './services/stock-pod-seed.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// apps/server/src/index.ts → trunk root is three levels up. In a packaged
// Electron build the server runs as a bundled `server.mjs` whose location
// bears no relation to the resource layout, so PC_ROOT (set by the desktop
// main process to the unpacked resources dir) overrides. PUBLIC / TEMPLATES /
// the scaffold trunk path all derive from ROOT, so they relocate with it.
const ROOT = process.env.PC_ROOT
  ? resolve(process.env.PC_ROOT)
  : resolve(__dirname, '..', '..', '..');
const PUBLIC = resolve(ROOT, 'apps', 'web', 'dist');
// Section 22.3 — single runtime contract: every server-internal data path
// resolves through `getDataDir()` (`PC_DATA_DIR` env or workspace-root/data).
// The persisted `dataDir` settings field is cosmetic/informational; changing
// it is rejected at PATCH time and the GET always surfaces this value.
const DATA = getDataDir();
const TEMPLATES = resolve(ROOT, 'templates');

const PORT = Number(process.env.PORT ?? 4040);
const CHANNEL_PORT = Number(process.env.CHANNEL_PORT ?? 8788);

// ROOT-relative so the staged `drizzle/` is found in a packaged build (where
// migrate.ts's __dirname points inside the bundle). Dev resolves to the trunk.
runMigrations(resolve(ROOT, 'packages', 'db', 'drizzle'));

// Section 10 / 33 — push stored Claude binary/profile overrides into runtime
// resolvers before any project PTY starts. The settings module captures the
// shell-inherited CLAUDE_CONFIG_DIR at import time so clearing an override can
// restore it later.
applyClaudeRuntimeSettings(readSettings());

// Section 16a.2 — seed the global orchestrator pod if it doesn't already
// exist. Idempotent on every boot; user/MCP edits to the row survive (the
// reseed path skips when any non-system audit row is present). 16a.3's
// spawn path depends on this row being live.
{
  const result = seedOrchestratorPodIfMissing();
  switch (result.action) {
    case 'inserted':
      console.log(`[pc] orchestrator pod seeded (id=${result.agentId})`);
      break;
    case 'reseeded':
      console.log(
        `[pc] orchestrator pod auto-reseeded (id=${result.agentId}, fields=[${result.reseededFields.join(', ')}])`,
      );
      break;
    case 'skipped-user-edited':
      console.warn(
        `[pc] orchestrator pod has drifted from ORCHESTRATOR_POD_CONTENT on fields [${result.reseededFields.join(', ')}] but the row has user-authored audit rows — leaving it alone. Apply the latest seed manually via the Pod UI (17d) or by clearing user edits.`,
      );
      break;
    case 'unchanged':
      break;
  }
}

// Stock specialist pods — insert-or-drift-reseed per pod. Non-user-edited
// rows auto-pick up source changes; user-edited rows are left intact and a
// warning is logged so the user knows their row has drifted. Researcher,
// writer, reviewer, planner, extractor, code-writer, agent-designer all
// flow through here. (The legacy `seedResearcherPodIfMissing` was retired
// when seedStockPods got drift-reseed parity — 2026-05-22 cleanup.)
{
  const result = seedStockPods();
  for (const entry of result.entries) {
    switch (entry.action) {
      case 'inserted':
        console.log(`[pc] stock pod '${entry.name}' seeded (id=${entry.agentId})`);
        break;
      case 'reseeded':
        console.log(
          `[pc] stock pod '${entry.name}' auto-reseeded (id=${entry.agentId}, fields=[${entry.reseededFields.join(', ')}])`,
        );
        break;
      case 'skipped-user-edited':
        console.warn(
          `[pc] stock pod '${entry.name}' has drifted from source on fields [${entry.reseededFields.join(', ')}] but the row has user-authored audit rows — leaving it alone. Use "Reset to default" in Global Settings → Specialists to pick up the seed.`,
        );
        break;
      case 'unchanged':
        break;
    }
  }
}

// Per-project WS subscriber hub. Multiple browser clients can observe the same
// project; reconnecting one client must not detach another from broadcasts.
const wsHub = new ProjectWebSocketHub<ULID>();

/**
 * Send `msg` to every WS subscribed to this project. P14: every outgoing
 * object envelope is tagged with `projectId` so UI clients can route events
 * to the right project's panel (and an "all projects" subscriber knows
 * where each event came from). An explicit `projectId` already on the
 * payload wins so call sites stay self-describing.
 */
function broadcastTo(projectId: ULID, msg: unknown): void {
  wsHub.broadcast(projectId, msg);
}

/**
 * Global broadcast (17d.1) — fan out to every subscribed WebSocket regardless
 * of project. Used for envelopes that aren't project-scoped (pods are global
 * in v1). No `projectId` tag is injected; consumers filter by `type`.
 */
function broadcastAll(msg: unknown): void {
  wsHub.broadcastAll(msg);
}

const runtimeSnapshots = new OrchestratorRuntimeSnapshots();

function broadcastRuntimeSnapshot(projectId: ULID, runtime: ProjectRuntime): void {
  broadcastTo(projectId, runtimeSnapshots.payload(projectId, runtime));
}

function broadcastSendQueueSnapshot(projectId: ULID, sessionId: ULID): void {
  broadcastTo(projectId, sendQueueSnapshotPayload(sessionId));
  const runtime = resolveProject(projectId);
  if (runtime) broadcastRuntimeSnapshot(projectId, runtime);
}

const {
  attachPtyHandlers,
  ensureOrchestratorPty,
  startOrchestratorPtyInBackground,
} = createRuntimeHostPtyController<ReturnType<ProjectRuntime['ensurePty']>, ProjectRuntime>({
  runtimeSnapshots,
  getActiveOrchestratorSession,
  setOrchestratorSessionJsonlCursor,
  setOrchestratorSessionJsonlPath,
  broadcastTo,
  broadcastRuntimeSnapshot,
  broadcastSendQueueSnapshot,
  deliverNextQueuedPrompt,
  maybeAdvanceSendQueueConfirmation,
  maybeSetSessionTitle,
  maybeApplyAiTitle,
  maybePersistPostTurnSummary,
});

const projectScaffold = new ProjectScaffold({
  trunkPath: ROOT,
  templatesDir: TEMPLATES,
  dataDir: DATA,
  serverPort: PORT,
  channelPort: CHANNEL_PORT,
});

// Section 34.1 — Quick Tasks pinned cross-project surface. Idempotent
// boot-time seed creates the row + scaffolded folder once; no-ops thereafter.
// MUST run before `projectRegistry.loadAll()` so the runtime picks it up
// like any other project.
{
  try {
    const result = await ensureQuickTasksProject({
      dataDir: DATA,
      scaffold: projectScaffold,
    });
    if (result.action === 'created') {
      console.log(
        `[pc] Quick Tasks project seeded (id=${result.projectId}, folder=${result.folderPath})`,
      );
    }
  } catch (err) {
    console.warn(`[pc] Quick Tasks seed failed: ${(err as Error).message}`);
  }
}

// Remove/quarantine legacy PC Claude runtime files from project roots before
// any Claude process starts. PC now passes session-local `--settings`,
// `--mcp-config`, and `--plugin-dir`; leaving old root files in place would
// still affect terminal-launched Claude Code in those folders.
{
  const result = cleanupLegacyProjectRuntimeFiles(listProjects({ includeDeleted: true }), {
    dataDir: DATA,
  });
  const changed = result.removed.length + result.rewritten.length;
  if (changed > 0) {
    console.log(
      `[pc] quarantined legacy Claude runtime files from ${changed} project file(s)`,
    );
  }
}

const projectRegistry = new ProjectRegistry({
  dataDir: DATA,
  templatesDir: TEMPLATES,
  trunkPath: ROOT,
  serverPort: PORT,
  channelPort: CHANNEL_PORT,
  broadcastFor: (projectId) => (event) => broadcastTo(projectId, event),
});
projectRegistry.loadAll();

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
  // 18.3 / Phase D — When a fresh bridge registers (post-restart / post-
  // respawn), drain any pending inbox rows for the (projectId, sessionId)
  // pair so the orchestrator catches up autonomously.
  onRegister: ({ projectId, sessionId, slug }) => {
    const result = drainPendingForSession(channelServer, projectId, sessionId, slug);
    if (result.attempted > 0) {
      console.log(
        `[channel] auto-flush ${projectId} / ${sessionId}: drained ${result.drained}/${result.attempted}`,
      );
    }
  },
});
channelServer.start();

// Section 18.8 — JSONL retention sweep at boot. Fire-and-forget so a slow
// or failing sweep can't block startup. Reads `jsonl.retentionDays` from
// the current settings envelope (default 30 days, `'never'` opts out).
{
  const retention = readSettings().jsonl.retentionDays;
  void sweepStaleJsonl({ retention })
    .then((result) => {
      if (retention === 'never') {
        console.log('[pc] jsonl-sweep skipped (retention=never)');
        return;
      }
      console.log(
        `[pc] jsonl-sweep: scanned ${result.scanned}, deleted ${result.deleted}, skipped ${result.skipped}, freed ${result.bytesFreed} bytes (retention=${retention}d)`,
      );
    })
    .catch((err) => {
      console.warn(`[pc] jsonl-sweep failed: ${(err as Error).message}`);
    });
}

// Section 27.3 — one-time stage-flag backfill. Idempotent: skips projects
// whose stages already carry any flag. Tags is_new on stages[0] of untouched
// projects, plus is_done on a single "Done"-named stage if exactly one
// matches (case-insensitive).
{
  try {
    const result = backfillStageFlags();
    if (result.updated > 0) {
      console.log(
        `[pc] stage-flags-backfill: scanned ${result.scanned}, updated ${result.updated}, skipped ${result.skipped}`,
      );
    }
  } catch (err) {
    console.warn(`[pc] stage-flags-backfill failed: ${(err as Error).message}`);
  }
}

// Section 26.8 — ephemeral work-item sweep at boot. Soft-deletes ephemeral
// agent contracts (`pc_create_agent_work_item` with `ephemeral: true`) that
// have been `complete` and idle for 24h+. No interval timer — long-running
// servers catch the next batch on restart.
{
  try {
    const result = sweepEphemeralWorkItems();
    if (result.archived > 0) {
      console.log(
        `[pc] ephemeral-work-item-sweep: scanned ${result.scanned}, archived ${result.archived}`,
      );
    }
  } catch (err) {
    console.warn(`[pc] ephemeral-work-item-sweep failed: ${(err as Error).message}`);
  }
}

// Boot-time orphan sweep on agent_runs. Dispatch + broadcast wiring lives in
// `agent-run-factory` per-spawn (the `broadcast` dep is injected at route
// time). Orphan sweep stays as a boot-time idempotent UPDATE — any
// non-terminal row outlives a prior server lifetime and gets flipped to
// `failed` so the Activity Panel doesn't show stale running cards.
{
  try {
    const reconciled = reconcileOrphanedRunningRuns(Date.now());
    if (reconciled > 0) {
      console.log(
        `[agent-runs] reconciled ${reconciled} orphaned running row(s) from prior server lifetime`,
      );
    }
  } catch (err) {
    console.error('[agent-runs] orphan reconciliation failed:', (err as Error).message);
  }
}

const app = new Hono();

/** Holds resolvers for in-flight AskUserQuestion / ExitPlanMode calls. */
const pendingAsks = new Map<string, (answer: string) => void>();

// ── Helpers ───────────────────────────────────────────────────────────────

/** Look up the runtime for `projectId`. Returns null if unknown. */
function resolveProject(projectId: string): ProjectRuntime | null {
  return projectRegistry.ensure(projectId as ULID);
}

/**
 * Listens on the `jsonl-event` channel for the first `jsonl-user` envelope of
 * a session and derives a title from its text. Idempotent once a title is set
 * — every subsequent `jsonl-user` is a no-op until `ai-title` (which doesn't
 * fire under `--agent`) overwrites.
 *
 * Wiring history:
 *   - pre-Section-23: read from PtySession's `event` channel (hook-driven user
 *     events). Hooks stopped emitting user events when 23 made JSONL canonical.
 *   - Section 31.9: deferred to CC's `ai-title` envelope. Worked only for
 *     non-`--agent` spawns — i.e. NOT the orchestrator or any PM pod.
 *   - Current: consumes the tailer's `jsonl-user` envelope. Same heuristic,
 *     live channel.
 *
 * Uses `session-title-updated` (NOT `session-changed`): the client treats
 * `session-changed` as a hard checkpoint that wipes the chat event buffer
 * (correct for new-session / resume — claude.exe context just changed).
 * A title-only metadata update must NOT wipe — would blank the chat panel
 * mid-conversation. Burned: tool calls right after the first user prompt
 * caused chat to "go blank" until refresh, because title-set fired
 * session-changed and the buffer reset just as tool events were landing.
 */
function maybeSetSessionTitle(projectId: ULID, event: unknown): void {
  if (!event || typeof event !== 'object') return;
  const ev = event as { kind?: string; text?: string };
  if (ev.kind !== 'jsonl-user' || typeof ev.text !== 'string') return;
  const active = getActiveOrchestratorSession(projectId);
  if (!active || active.title) return;
  const title = deriveTitleFromText(ev.text);
  if (!title) return;
  setOrchestratorSessionTitle(active.id, title);
  const updated = getActiveOrchestratorSession(projectId);
  if (updated) broadcastTo(projectId, { type: 'session-title-updated', session: updated });
}

/** Section 31.9 — bind the rail session row title + chat title bar to CC's
 *  `ai-title`. Fires repeatedly through the session as CC refines the title;
 *  every update overwrites the persisted value + broadcasts.
 *  Replaces the pre-31.9 first-user-prompt heuristic (`maybeSetSessionTitle`
 *  stays in place as a fallback for sessions that never get an ai-title —
 *  e.g. very short sessions, or pre-31.9 historical rows).
 */
function maybeApplyAiTitle(projectId: ULID, event: unknown): void {
  if (!event || typeof event !== 'object') return;
  const ev = event as { kind?: string; title?: string };
  if (ev.kind !== 'jsonl-ai-title' || typeof ev.title !== 'string') return;
  const title = ev.title.trim();
  if (!title) return;
  const active = getActiveOrchestratorSession(projectId);
  if (!active) return;
  if (active.title === title) return;
  setOrchestratorSessionTitle(active.id, title);
  const updated = getActiveOrchestratorSession(projectId);
  if (updated) broadcastTo(projectId, { type: 'session-title-updated', session: updated });
}

/** First non-empty line, collapsed whitespace, truncated to ~60 chars. Skips
 *  CC's `<local-command-caveat>` / `<command-name>` / `<command-message>` /
 *  `<command-args>` wrapper lines so titles capture the user's actual prompt
 *  rather than the meta envelope. */
function deriveTitleFromText(text: string): string {
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('<')) continue;
    const collapsed = line.replace(/\s+/g, ' ').trim();
    if (!collapsed) continue;
    return collapsed.length <= 60 ? collapsed : collapsed.slice(0, 57).trimEnd() + '…';
  }
  return '';
}

/**
 * Section 31.12 — persist CC's `system:post_turn_summary` JSONL events to the
 * DB. Idempotent by (projectId, summarizes_uuid); replay won't double-write.
 *
 * SessionId comes from the raw entry — CC always tags JSONL rows with their
 * owning session uuid. Best-effort: if a row arrives without it (legacy
 * shape), we still log with sessionId=null rather than dropping the data.
 */
function maybePersistPostTurnSummary(projectId: ULID, event: unknown): void {
  if (!event || typeof event !== 'object') return;
  const ev = event as {
    kind?: string;
    summarizesUuid?: string | null;
    statusCategory?: string | null;
    statusDetail?: string | null;
    isNoteworthy?: boolean;
    title?: string | null;
    description?: string | null;
    recentAction?: string | null;
    needsAction?: boolean;
    artifactUrls?: unknown;
    timestamp?: string | null;
    raw?: unknown;
  };
  if (ev.kind !== 'jsonl-post-turn-summary') return;
  const raw = (ev.raw ?? {}) as { sessionId?: unknown };
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : null;
  try {
    insertPostTurnSummary({
      id: newId(),
      projectId,
      sessionId,
      summarizesUuid: ev.summarizesUuid ?? null,
      statusCategory: ev.statusCategory ?? null,
      statusDetail: ev.statusDetail ?? null,
      isNoteworthy: ev.isNoteworthy === true,
      title: ev.title ?? null,
      description: ev.description ?? null,
      recentAction: ev.recentAction ?? null,
      needsAction: ev.needsAction === true,
      artifactUrls: ev.artifactUrls ?? null,
      timestamp: ev.timestamp ?? null,
      createdAt: Date.now(),
      raw: ev.raw ?? null,
    });
  } catch (err) {
    console.error(
      '[pc] insertPostTurnSummary failed:',
      (err as Error).message,
    );
  }
}

// ── Global endpoints ──────────────────────────────────────────────────────

// MCP heartbeats are written per-project by `packages/mcp/src/server.ts`
// (`PC_PROJECT_ID` is supplied in PC's session-local MCP env). Pass
// `?projectId=` to read that project's heartbeat; the legacy global path is
// the fallback for pre-per-project clients.
app.get('/api/mcp-status', (c) => {
  const projectId = c.req.query('projectId');
  const file = projectId
    ? resolve(DATA, 'projects', projectId, 'mcp-status.json')
    : resolve(DATA, 'mcp-status.json');
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

registerSettingsOnboardingRoutes(app);

registerFileRoutes(app, {
  projectFolderPath: (projectId) => getProjectById(projectId)?.folderPath ?? null,
});

registerProjectRoutes(app, {
  createProject: (input) => projectCreate.create(input),
  refreshProject: (project) => projectRegistry.refresh(project),
  removeProject: (projectId) => projectRegistry.remove(projectId),
  resolveProject,
});

// Section 17d.1 — Pod (DB-resident agent) routes. Pods are global-scope in
// v1; v2 (17c) overlays project rows.
//
// 17d.10 — `onPodChanged` triggers restart-on-edit for the orchestrator
// pod across every loaded ProjectRuntime. Worker pods (researcher, etc.)
// are intentionally NOT restarted — killing them mid-task would orphan
// their work, and the next dispatch re-reads the DB anyway.
// Section 34.3 — Quick Tasks HTTP routes. Surfaces the cross-project capture
// verbs for the chrome quick-add button (34.7) + the MCP tools
// (`pc_create_quick_task`, `pc_list_quick_tasks`, `pc_list_quick_tasks_for_project`).
registerQuickTasksRoutes(app, { registry: projectRegistry });

/** Section 19.17 — workflows are first-class scoped rows (mirrors agents
 *  pattern). CRUD + lifecycle live under `/api/workflows/*`; the legacy
 *  `/api/projects/:projectId/workflow-v2/*` GET endpoints survive only as
 *  read-only compat for the existing web client (19.18 rewires). */
registerWorkflowRoutes(app, {
  broadcastTo,
  broadcastAll,
  countInFlightRuns: (projectId, slug) => {
    const runs = workflowRunsV2Repo.listRunsByProject(projectId);
    return runs.filter(
      (r) =>
        r.workflowId === slug &&
        (r.status === 'pending' || r.status === 'running' || r.status === 'paused'),
    ).length;
  },
  cancelInFlightRuns: (projectId, slug) => {
    const runs = workflowRunsV2Repo.listRunsByProject(projectId);
    for (const r of runs) {
      if (
        r.workflowId === slug &&
        (r.status === 'pending' || r.status === 'running' || r.status === 'paused')
      ) {
        workflowRunsV2Repo.setStatus(r.id, 'cancelled', {
          lastReason: 'workflow soft-deleted',
        });
        broadcastTo(projectId, {
          type: 'workflow-v2-run-changed',
          runId: r.id,
          status: 'cancelled',
        });
      }
    }
  },
  fireWorkflow: async (projectId, def, trigger) => {
    const runtime = resolveProject(projectId);
    if (!runtime) throw new Error(`unknown project: ${projectId}`);
    return runtime.fireV2Workflow(def, trigger);
  },
});

registerPodRoutes(app, {
  broadcastAll,
  resetStockPodToDefault: (name, reason) => {
    const r = resetStockPodToDefault(name, reason);
    return { agent: r.agent, resetFields: r.resetFields };
  },
  detectStockPodDrift,
  listCanonicalStockPodNames,
  onPodChanged: (podName) => {
    if (podName !== 'orchestrator') return;
    for (const runtime of projectRegistry.list()) {
      const restarted = runtime.restartIfOrchestratorPod(podName);
      if (!restarted) continue;
      try {
        ensureOrchestratorPty(runtime.project.id, runtime);
        // No replayActiveSessionEvents — chat history already in the UI;
        // the user sees a brief reconnect blip + the next prompt-turn
        // reflects the new orchestrator identity.
      } catch (err) {
        console.error(
          `[pc] orchestrator restart-on-pod-edit failed for ${runtime.project.id}: ${(err as Error).message}`,
        );
      }
    }
  },
});

registerRuntimeHostRoutes(app, {
  resolveProject,
  runtimeSnapshotPayload: (projectId, runtime) => runtimeSnapshots.payload(projectId, runtime),
  broadcastTo,
  broadcastRuntimeSnapshot,
  broadcastSendQueueSnapshot,
  ensureOrchestratorPty,
  startOrchestratorPtyInBackground,
});

registerProjectContextRoutes(app, {
  resolveProject,
  broadcastTo,
  getProjectFolderPath: (projectId) => getProjectById(projectId)?.folderPath ?? null,
});

registerProjectDetailRoute(app, { resolveProject });

registerTransientSessionRoutes<ReturnType<ProjectRuntime['startAgentDesigner']>, ProjectRuntime>(
  app,
  {
    resolveProject,
    broadcastTo,
  },
);

registerWorkItemRoutes(app, {
  resolveProject,
  broadcastTo,
  refreshProject: (project) => projectRegistry.refresh(project),
  channelServer,
});

// 19.12 — v1 workflows CRUD removed. The v2 surface lives at
// `/api/projects/:projectId/workflow-v2/definitions` (list/get/publish) and
// `/workflow-v2/fire`. The workflow-builder draft endpoints below replace the
// pre-19 workflow-creator/draft path.

/** Section 19.9 — stash an in-progress v2 workflow-builder draft.
 *  Does NOT write to disk — only `pc_publish_workflow` does that.
 *  Broadcasts `workflow-builder-draft` so the modal's visualizer re-renders.
 *
 *  Drafts are loosely validated — they need a top-level `id` (string) so the
 *  draft store can key them, but the rest of the shape may be incomplete
 *  during mid-interview saves. The visualizer renders whatever shape arrives;
 *  full validation runs only at `pc_publish_workflow` time. */
app.post('/api/projects/:projectId/workflow-builder/draft', async (c) => {
  const id = c.req.param('projectId') as ULID;
  const runtime = resolveProject(id);
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
  // No full v2 validation here — drafts can be incomplete mid-interview.
  // Cast through unknown so the in-memory store accepts the partial shape;
  // pc_publish_workflow runs the full validator before any YAML hits disk.
  const def = payload.def as unknown as WorkflowV2.Workflow;
  runtime.setWorkflowBuilderDraft(sessionId, def);
  broadcastTo(id, { type: 'workflow-builder-draft', sessionId, def });
  return c.json({ ok: true });
});

/** Section 19.9 — read the current draft for a workflow-builder session.
 *  Used by `pc_read_workflow_draft` so the agent can pick up user drags
 *  between turns (sync-model-A). Returns `{ ok: true, def: <draft or null> }`. */
app.get('/api/projects/:projectId/workflow-builder/draft/:sessionId', (c) => {
  const id = c.req.param('projectId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const sessionId = c.req.param('sessionId');
  const def = runtime.getWorkflowBuilderDraft(sessionId);
  return c.json({ ok: true, def: def ?? null });
});

// 6.6 — activity-panel "Failed recently" dismissals. The dismissals side-table
// is generic across v1/v2; the validation step below confirms the runId
// corresponds to a real v2 run before recording. 19.12 — v1 workflow_runs
// list / get / retry-from / cancel removed; v2 runs are read via
// /workflow-v2/runs[/:runId].
app.get('/api/projects/:projectId/failed-run-dismissals', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const runIds = listFailedRunDismissalsForProject(id as ULID);
  return c.json({ runIds });
});

app.post('/api/projects/:projectId/workflow-runs/:runId/dismiss', (c) => {
  const id = c.req.param('projectId');
  const runId = c.req.param('runId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const run = workflowRunsV2Repo.getRunForProject(runId as never, runtime.project.id);
  if (!run) return c.json({ ok: false, error: `unknown run: ${runId}` }, 404);
  const dismissedAt = dismissFailedRun(runId as ULID, Date.now());
  return c.json({ ok: true, dismissedAt });
});

registerWorktreeRoutes(app, { resolveProject });

// 19.12 — v1 /workflow/node-complete, /workflow/node-failed, /approvals
// routes removed. v2 DAG handles node completion + approvals internally;
// review responses go through POST /workflow-v2/review.

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

// 19.12 — v1 /approval/respond and /workflow/run routes removed. v2 paths:
// POST /workflow-v2/review for review decisions; POST /workflow-v2/fire
// (or via MCP) for manual runs by name.

// Section 19.17 — POST `/api/projects/:projectId/workflow-v2/fire` and
// POST `/api/projects/:projectId/workflow-v2/definitions` deleted. The new
// canonical surface is `/api/workflows/:id/fire` (id-based, DB-backed) and
// `POST/PUT /api/workflows` for create/update. The MCP tools were repointed
// alongside the route move. GET endpoints below survive as 19.18 compat.

// list: valid + invalid v2 definitions for the Workflows tab. Reads from
// DB post-19.17. 19.18 swaps the web client over to `/api/workflows`; this
// compat shape (using `fileName` for invalids — a legacy of the on-disk
// registry) is preserved so a mid-19 web client doesn't crash.
app.get('/api/projects/:projectId/workflow-v2/definitions', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
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

// get one by id (slug-based; legacy web-client contract). DB-backed.
app.get('/api/projects/:projectId/workflow-v2/definitions/:wfId', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const entry = runtime.findV2WorkflowBySlug(c.req.param('wfId'));
  if (!entry) return c.json({ ok: false, error: 'workflow not found' }, 404);
  return c.json({ ok: true, workflow: entry.workflow, yamlText: entry.yamlText });
});

// Section 19.4f — read a v2 run (sidecar state + event log). Project-scoped.
app.get('/api/projects/:projectId/workflow-v2/runs/:runId', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const run = workflowRunsV2Repo.getRunForProject(c.req.param('runId') as never, runtime.project.id);
  if (!run) return c.json({ ok: false, error: 'run not found' }, 404);
  return c.json({ ok: true, run, events: workflowRunsV2Repo.listEvents(run.id) });
});

// Section 19.11 — list every v2 run for a project (Workflows tab uses this
// to render per-definition run counts + status pills). Project-scoped.
app.get('/api/projects/:projectId/workflow-v2/runs', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const runs = workflowRunsV2Repo.listRunsByProject(runtime.project.id);
  return c.json({ ok: true, runs });
});

// Section 19.4f — apply an orchestrator/human review decision to a paused v2 run.
app.post('/api/projects/:projectId/workflow-v2/review', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{ runId?: string; nodeId?: string; decision?: string; notes?: string }>();
  if (!body.runId || !body.nodeId || (body.decision !== 'approve' && body.decision !== 'reject')) {
    return c.json({ ok: false, error: 'require { runId, nodeId, decision: approve|reject }' }, 400);
  }
  try {
    const decision =
      body.decision === 'reject'
        ? { kind: 'reject' as const, ...(body.notes ? { notes: body.notes } : {}) }
        : { kind: 'approve' as const };
    const status = await runtime.applyV2Review(body.runId as never, body.nodeId, decision);
    if (status === null) return c.json({ ok: false, error: 'run not found' }, 404);
    return c.json({ ok: true, status });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 400);
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

registerAgentRunRoutes(app, {
  channelServer,
  broadcastTo,
});

registerStatuslineRoutes(app, { broadcastTo });

/** Section 22 / Phase D — internal endpoint posted by pc-rig (the per-spawn
 *  MCP child) when CC's MCP client finishes the JSON-RPC handshake (the
 *  `initialized` notification). Routes the signal to whichever surface owns
 *  the session: the v2 active-runs registry (dispatched agents) or the
 *  workflow-subagent-handshake map (workflow-runtime subagents). */
app.post('/api/internal/mcp-handshake', async (c) => {
  const body = await c.req.json<{ projectId?: string; agentSessionId?: string }>();
  if (!body.projectId || !body.agentSessionId) {
    return c.json({ ok: false, error: 'projectId + agentSessionId required' }, 400);
  }
  const v2Entry = getActiveRunRegistry().getByCcSession(body.agentSessionId);
  if (v2Entry) {
    v2Entry.run.notifyMcpHandshake();
    return c.json({ ok: true, found: true, transport: 'agent' });
  }
  if (notifyWorkflowSubagentHandshake(body.agentSessionId)) {
    return c.json({ ok: true, found: true, transport: 'workflow' });
  }
  const runtime = resolveProject(body.projectId);
  if (runtime?.notifyOrchestratorMcpHandshake(body.agentSessionId)) {
    return c.json({ ok: true, found: true, transport: 'orchestrator' });
  }
  return c.json({ ok: true, found: false });
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
  // Section 22.7 — `startsWith(PUBLIC)` is unsafe across sibling-prefix
  // paths (a sibling directory "dist-evil" would match the "dist" prefix).
  // `path.relative` containment rejects '..' walks AND sibling prefixes.
  const rel = relative(PUBLIC, filePath);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    // Empty `rel` means filePath === PUBLIC — treat as "no file" not as the
    // public dir itself.
    if (rel !== '') return c.text('Forbidden', 403);
  }

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

registerRuntimeHostWebSocketServer<ReturnType<ProjectRuntime['ensurePty']>, ProjectRuntime>({
  server,
  path: '/ws',
  wsHub,
  resolveProject,
  attachPtyHandlers,
  runtimeSnapshotPayload: (id, targetRuntime) => runtimeSnapshots.payload(id, targetRuntime),
  startOrchestratorPtyInBackground,
  broadcastTo,
  broadcastSendQueueSnapshot,
  ensureOrchestratorPty,
  resolvePendingAsk: (id, answer) => {
    if (!pendingAsks.has(id)) return;
    const resolveFn = pendingAsks.get(id)!;
    pendingAsks.delete(id);
    resolveFn(answer);
  },
});

process.on('SIGINT', () => {
  console.log('[pc] SIGINT — shutting down project runtimes + channel server');
  projectRegistry.shutdownAll();
  channelServer.shutdown();
  process.exit(0);
});
