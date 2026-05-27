import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { homedir } from 'node:os';

import type {
  AgentRunStatus,
  GlobalSettings,
  PendingAskKind,
  PendingAskOption,
  ULID,
  WorkItemType,
} from '@pc/domain';
import {
  isWorkItemType,
  normalizeOrchestratorSurfacePreference,
  resolveClaudeConfigDirEnv,
  withSettingsDefaults,
} from '@pc/domain';
import {
  claudeConfigDir,
  jsonlPathFor,
  setConfiguredClaudeExe,
  type JsonlReplayMeta,
} from '@pc/runtime';
import { validateWorkflowV2 } from '@pc/workflows';
import {
  countWorkItemsInStage,
  cancelOpenOrchestratorSendsForSession,
  cancelQueuedOrchestratorSend,
  enqueueOrchestratorSend,
  getOrchestratorSendQueueRow,
  getActiveOrchestratorSession,
  getOrchestratorSession,
  dismissFailedRun,
  getAgentRunRow,
  insertPostTurnSummary,
  listVisibleOrchestratorSendsForSession,
  listActiveAgentRunsForProject,
  listAgentRunsForSession,
  getGlobalSettings,
  getProjectById,
  listFailedRunDismissalsForProject,
  listOrchestratorSessionsForProject,
  listProjects,
  listWorkItems as dbListWorkItems,
  newId,
  reassignStage,
  reconcileOrphanedRunningRuns,
  reorderProjects,
  runMigrations,
  setGlobalSettings,
  hasOpenOrchestratorSendsForSession,
  recordDeliveredOrchestratorSend,
  retryFailedOrchestratorSend,
  setOrchestratorSessionJsonlCursor,
  setOrchestratorSessionJsonlPath,
  setOrchestratorSessionTitle,
  softDeleteProject,
  updateProjectMeta,
  updateProjectStages,
  updateWorkItemFields as dbUpdateWorkItemFields,
  insertStatuslineSnapshot,
  listLatestSnapshotPerSession,
  getLatestSnapshotForProject,
  type OrchestratorSendQueueRow,
  workflowRunsV2Repo,
} from '@pc/db';
import type { Stage, StatuslineSnapshot, WorkflowV2 } from '@pc/domain';
import { getDataDir } from '@pc/utils';

import {
  loadSessionReplayCheckpoint,
  type SessionReplayCheckpoint,
} from './services/session-replay.ts';
import {
  deriveRuntimeHealth,
  deriveRuntimeWaitPoint,
  type RuntimeHealth,
  type RuntimeWaitPoint,
} from './services/orchestrator-runtime-health.ts';
import {
  deliverNextQueuedPrompt,
  maybeAdvanceSendQueueConfirmation,
  queuedStatusForState,
} from './services/orchestrator-send-queue-delivery.ts';
import { ProjectWebSocketHub } from './services/websocket-hub.ts';
import { runPreflight, probeAuth } from './services/preflight.ts';
import { installClaude, installGit } from './services/onboarding-install.ts';
import { startLogin, getLoginState, cancelLogin } from './services/onboarding-auth.ts';
import { drainPendingForSession } from './services/agent-delivery.ts';
import {
  dispatchContinueAgent,
  dispatchFreshAgent,
} from './services/agent-run-factory.ts';
import {
  answerPendingAsk,
  cancelPendingAsk,
  recordExplicitPause,
} from './services/pause-resume.ts';
import { getActiveRunRegistry } from './services/agent-active-runs.ts';
import { notifyWorkflowSubagentHandshake } from './services/workflow-subagent-handshake.ts';
import { sweepStaleJsonl } from './services/jsonl-sweep.ts';
import { sweepEphemeralWorkItems } from './services/ephemeral-work-item-sweep.ts';
import { backfillStageFlags } from './services/stage-flags-backfill.ts';
import { AttachmentNotInProjectError } from './services/attachment.ts';
import { ChannelServer } from './services/channel-server.ts';
import { listCustomCommands } from './services/custom-commands.ts';
import {
  FieldValidationError,
  looksLikeUlid,
  resolveWorkItemRef,
  UnknownStageError,
  WorkItemVersionConflictError,
} from './services/work-item.ts';
import {
  AgentWorkItemInputError,
  createAgentWorkItem,
  type CreateAgentWorkItemInput,
} from './services/agent-work-item.ts';
import {
  approveAgentWorkItem,
  rejectAgentWorkItem,
  VerificationReviewError,
} from './services/agent-verification-review.ts';
import {
  type MemoryScope,
  readMemoryFile,
  writeMemoryFile,
} from './services/memory-files.ts';
import {
  forwardTerminalInput,
  normalizeTerminalTranscriptTailBytes,
  readTerminalTranscriptTail,
} from './services/terminal-mode.ts';
import {
  browseFolder,
  BrowseError,
  createChildFolder,
  listDrives,
} from './services/fs-browse.ts';
import { probeFolder } from './services/fs-probe.ts';
import {
  FileNotFoundError,
  FilePathOutsideProjectError,
  getFilesTree,
  previewFile,
} from './services/files-tree.ts';
import { ProjectCreate, type CreateProjectMode } from './services/project-create.ts';
import { ProjectRegistry } from './services/project-registry.ts';
import type { ProjectRuntime } from './services/project-runtime.ts';
import { ProjectScaffold } from './services/project-scaffold.ts';
import { registerPodRoutes } from './routes/pod-routes.ts';
import { registerQuickTasksRoutes } from './routes/quick-tasks-routes.ts';
import { registerWorkflowRoutes } from './routes/workflow-routes.ts';
import { seedOrchestratorPodIfMissing } from './services/orchestrator-pod-seed.ts';
import { ensureQuickTasksProject } from './services/quick-tasks-seed.ts';
import { cleanupLegacyProjectRuntimeFiles } from './services/legacy-runtime-cleanup.ts';
import { resetStockPodToDefault } from './services/stock-pod-reset.ts';
import { detectStockPodDrift, listCanonicalStockPodNames } from './services/pod-drift.ts';
import { seedStockPods } from './services/stock-pod-seed.ts';
import { recordAgentInvoke } from './services/agent-audit.ts';
import { checkInvokeDepth } from './services/invoke-depth.ts';

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

// Section 10 Phase 0 — push the configured claude.exe override (if any) into
// the runtime resolver so every spawn honors GlobalSettings.claudeExe. Null =
// resolver falls through to CLAUDE_EXE → PATH → ~/.local/bin. readSettings is
// a hoisted declaration; the DB is ready post-migration.
setConfiguredClaudeExe(readSettings().claudeExe);

// Section 33 — capture the shell-inherited CLAUDE_CONFIG_DIR ONCE, before any
// stored override is applied, so clearing the override later restores it
// rather than getting stuck on the last override.
const SHELL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;

/** Point `process.env.CLAUDE_CONFIG_DIR` at the chosen Claude profile (or
 *  restore the shell default when `override` is null). This single assignment
 *  is the whole mechanism: path-resolver reads the env var fresh on every call
 *  AND every claude.exe spawn inherits `process.env`, so chat JSONL location,
 *  the retention sweep, Usage aggregation, and fresh spawns all follow the
 *  chosen profile. Existing PtY sessions keep whatever dir they spawned under
 *  (resume derives it from the persisted JSONL path), so a change is
 *  restart-required for live chats but immediate for new ones. */
function applyClaudeConfigDirOverride(override: string | null): void {
  const next = resolveClaudeConfigDirEnv(override, SHELL_CLAUDE_CONFIG_DIR);
  if (next === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = next;
}

// Apply the stored profile override at boot (mirror of setConfiguredClaudeExe).
applyClaudeConfigDirOverride(readSettings().claudeConfigDir);

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

type SendAckStatus =
  | 'received'
  | 'queued'
  | 'invalid-message'
  | 'no-session'
  | 'error';

interface PublicSendQueueItem {
  id: ULID;
  clientMessageId: string;
  text: string;
  status: OrchestratorSendQueueRow['status'];
  createdAt: number;
  updatedAt: number;
  deliveryAttempts: number;
  failureReason: string | null;
}

interface RuntimeFailureState {
  health: 'failed_resume' | 'provider_missing';
  reason: string;
  at: number;
}

interface RuntimeLifecycleState {
  lastActivityAt: number | null;
  lastJsonlAt: number | null;
  lastExitAt: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  failure: RuntimeFailureState | null;
}

interface PublicRuntimeSnapshot {
  type: 'runtime-state';
  sessionId: ULID | null;
  provider: 'claude';
  providerSessionId: string | null;
  health: RuntimeHealth;
  waitPoint: RuntimeWaitPoint;
  ptyState: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  spawnAttemptId: string | null;
  spawnAttempt: number;
  lastReadyAt: number | null;
  nextRetryAt: number | null;
  lastExitAt: number | null;
  lastJsonlAt: number | null;
  lastActivityAt: number | null;
  failureReason: string | null;
  rawJsonlPath: string | null;
  rawJsonlExists: boolean;
  rawJsonlCursor: number | null;
  replayPath: string | null;
  replayExists: boolean;
  replayLineCount: number;
  replayHighWaterSeq: number;
  queueDepth: number;
  queue: PublicSendQueueItem[];
}

const runtimeLifecycle = new Map<ULID, RuntimeLifecycleState>();

function publicSendQueueItem(row: OrchestratorSendQueueRow): PublicSendQueueItem {
  return {
    id: row.id,
    clientMessageId: row.clientMessageId,
    text: row.text,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deliveryAttempts: row.deliveryAttempts,
    failureReason: row.failureReason,
  };
}

function runtimeLifecycleFor(projectId: ULID): RuntimeLifecycleState {
  let state = runtimeLifecycle.get(projectId);
  if (!state) {
    state = {
      lastActivityAt: null,
      lastJsonlAt: null,
      lastExitAt: null,
      exitCode: null,
      exitSignal: null,
      failure: null,
    };
    runtimeLifecycle.set(projectId, state);
  }
  return state;
}

function noteRuntimeActivity(projectId: ULID): void {
  runtimeLifecycleFor(projectId).lastActivityAt = Date.now();
}

function noteRuntimeJsonl(projectId: ULID): void {
  const state = runtimeLifecycleFor(projectId);
  const now = Date.now();
  state.lastActivityAt = now;
  state.lastJsonlAt = now;
}

function clearRuntimeFailure(projectId: ULID): void {
  runtimeLifecycleFor(projectId).failure = null;
}

function clearRuntimeExit(projectId: ULID): void {
  const state = runtimeLifecycleFor(projectId);
  state.lastExitAt = null;
  state.exitCode = null;
  state.exitSignal = null;
}

function noteRuntimeFailure(projectId: ULID, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  runtimeLifecycleFor(projectId).failure = {
    health: classifyRuntimeFailure(message),
    reason: message,
    at: Date.now(),
  };
}

function classifyRuntimeFailure(message: string): RuntimeFailureState['health'] {
  return /no transcript|conversation found|provider session|jsonl|transcript/i.test(message)
    ? 'provider_missing'
    : 'failed_resume';
}

function noteRuntimeExit(
  projectId: ULID,
  code: number | undefined,
  signal: string | undefined,
): void {
  const state = runtimeLifecycleFor(projectId);
  const now = Date.now();
  state.lastActivityAt = now;
  state.lastExitAt = now;
  state.exitCode = code ?? null;
  state.exitSignal = signal ?? null;
}

function countJsonlLines(filePath: string): number {
  try {
    return readFileSync(filePath, 'utf-8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

function fileMtimeMs(filePath: string | null): number | null {
  if (!filePath) return null;
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function runtimeSnapshotPayload(
  projectId: ULID,
  runtime: ProjectRuntime,
): PublicRuntimeSnapshot {
  const active = getActiveOrchestratorSession(projectId);
  const lifecycle = runtimeLifecycleFor(projectId);
  const ptyState = runtime.orchestratorPtyState();
  const runtimeDetails = runtime.orchestratorRuntimeSnapshot();
  const health = deriveRuntimeHealth({
    ptyState,
    lastExitAt: lifecycle.lastExitAt,
    failureHealth: lifecycle.failure?.health ?? null,
  });
  const rawJsonlPath = active?.jsonlPath
    ?? (active?.providerSessionId ? jsonlPathFor(runtime.folderPath, active.providerSessionId) : null);
  const replayPath = active ? resolve(runtime.sessionDataPath(active.id), 'jsonl-events.jsonl') : null;
  const rawJsonlExists = rawJsonlPath ? existsSync(rawJsonlPath) : false;
  const replayExists = replayPath ? existsSync(replayPath) : false;
  const replay = active ? loadSessionReplay(runtime, active.id) : null;
  const queue = active
    ? listVisibleOrchestratorSendsForSession(active.id).map(publicSendQueueItem)
    : [];
  const queueDepth = queue.filter((item) => item.status !== 'failed').length;
  const rawJsonlCursor = active ? active.jsonlLineCursor : null;
  const lastJsonlAt = lifecycle.lastJsonlAt ?? fileMtimeMs(rawJsonlPath);
  const waitPoint = deriveRuntimeWaitPoint({
    sessionId: active?.id ?? null,
    health,
    queueDepth,
    rawJsonlExists,
    lastJsonlAt,
  });

  return {
    type: 'runtime-state',
    sessionId: active?.id ?? null,
    provider: 'claude',
    providerSessionId: active?.providerSessionId ?? null,
    health,
    waitPoint,
    ptyState,
    exitCode: lifecycle.exitCode,
    exitSignal: lifecycle.exitSignal,
    spawnAttemptId: runtimeDetails.spawnAttemptId,
    spawnAttempt: runtimeDetails.spawnAttempt,
    lastReadyAt: runtimeDetails.lastReadyAt,
    nextRetryAt: runtimeDetails.nextRetryAt,
    lastExitAt: lifecycle.lastExitAt,
    lastJsonlAt,
    lastActivityAt: lifecycle.lastActivityAt ?? lastJsonlAt ?? active?.startedAt ?? null,
    failureReason: lifecycle.failure?.reason ?? runtimeDetails.runtimeFailureReason,
    rawJsonlPath,
    rawJsonlExists,
    rawJsonlCursor,
    replayPath,
    replayExists,
    replayLineCount: replayExists && replayPath ? countJsonlLines(replayPath) : 0,
    replayHighWaterSeq: replay?.highWaterSeq ?? 0,
    queueDepth,
    queue,
  };
}

function broadcastRuntimeSnapshot(projectId: ULID, runtime: ProjectRuntime): void {
  broadcastTo(projectId, runtimeSnapshotPayload(projectId, runtime));
}

function sendQueueSnapshotPayload(sessionId: ULID): {
  type: 'send-queue-snapshot';
  sessionId: ULID;
  items: PublicSendQueueItem[];
} {
  return {
    type: 'send-queue-snapshot',
    sessionId,
    items: listVisibleOrchestratorSendsForSession(sessionId).map(publicSendQueueItem),
  };
}

function broadcastSendQueueSnapshot(projectId: ULID, sessionId: ULID): void {
  broadcastTo(projectId, sendQueueSnapshotPayload(sessionId));
  const runtime = resolveProject(projectId);
  if (runtime) broadcastRuntimeSnapshot(projectId, runtime);
}

function replayMetaPayload(replay: JsonlReplayMeta | undefined): {
  id?: string;
  sessionId?: string;
  seq?: number;
  kind?: string;
  source?: JsonlReplayMeta['source'];
} {
  if (!replay) return {};
  return {
    id: replay.id,
    sessionId: replay.sessionId,
    seq: replay.seq,
    kind: replay.kind,
    source: replay.source,
  };
}

function ensureOrchestratorPty(
  projectId: ULID,
  runtime: ProjectRuntime,
): ReturnType<ProjectRuntime['ensurePty']> {
  try {
    const pty = runtime.ensurePty();
    clearRuntimeFailure(projectId);
    if (pty.getState() === 'ready') clearRuntimeExit(projectId);
    noteRuntimeActivity(projectId);
    attachPtyHandlers(projectId, runtime, pty);
    broadcastRuntimeSnapshot(projectId, runtime);
    return pty;
  } catch (err) {
    noteRuntimeFailure(projectId, err);
    broadcastRuntimeSnapshot(projectId, runtime);
    throw err;
  }
}

function startOrchestratorPtyInBackground(
  projectId: ULID,
  runtime: ProjectRuntime,
): void {
  setImmediate(() => {
    try {
      ensureOrchestratorPty(projectId, runtime);
    } catch (err) {
      console.error(
        `[pc] background orchestrator start failed for ${projectId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });
}

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
  const attachedSessionId = getActiveOrchestratorSession(projectId)?.id ?? null;
  let terminalSeq = 0;
  session.on('raw', (text: string) => {
    noteRuntimeActivity(projectId);
    terminalSeq += 1;
    broadcastTo(projectId, {
      type: 'raw',
      sessionId: attachedSessionId,
      terminalSeq,
      text,
    });
  });
  session.on('state', (state: string) => {
    noteRuntimeActivity(projectId);
    if (state === 'ready') {
      clearRuntimeFailure(projectId);
      clearRuntimeExit(projectId);
    }
    broadcastTo(projectId, { type: 'state', state });
    broadcastRuntimeSnapshot(projectId, runtime);
    if (state === 'ready') {
      deliverNextQueuedPrompt(projectId, runtime, broadcastSendQueueSnapshot);
    }
  });
  session.on('turn-end', () => {
    // 19.12 — v1 `onTurnEnd` removed (it swept in-flight v1 subagent nodes
    // marked still-running across an orchestrator turn boundary). v2 DAG
    // runs are self-contained with their own idle + wall-clock timeouts.
    noteRuntimeActivity(projectId);
    broadcastTo(projectId, { type: 'turn-end' });
    broadcastRuntimeSnapshot(projectId, runtime);
  });
  session.on('event', (event: unknown) => {
    noteRuntimeActivity(projectId);
    broadcastTo(projectId, { type: 'event', event });
    broadcastRuntimeSnapshot(projectId, runtime);
  });
  session.on('error', (err: unknown) => {
    noteRuntimeFailure(projectId, err);
    broadcastRuntimeSnapshot(projectId, runtime);
  });
  session.on('failed', (reason: string) => {
    noteRuntimeFailure(projectId, reason);
    broadcastRuntimeSnapshot(projectId, runtime);
  });
  // JSONL tailer events — Section 0 canonical signal for turn lifecycle +
  // tool calls. Distinct WS envelope kind from the hook-driven `event` stream
  // so the chat panel can merge them without ambiguity.
  session.on('jsonl-event', (event: unknown, replay?: JsonlReplayMeta) => {
    noteRuntimeJsonl(projectId);
    broadcastTo(projectId, { type: 'jsonl', event, ...replayMetaPayload(replay) });
    if (attachedSessionId && typeof replay?.source?.cursor === 'number') {
      setOrchestratorSessionJsonlCursor(attachedSessionId, replay.source.cursor);
    }
    maybeAdvanceSendQueueConfirmation(
      projectId,
      attachedSessionId,
      event,
      runtime,
      broadcastSendQueueSnapshot,
    );
    broadcastRuntimeSnapshot(projectId, runtime);
    // Section 31.12 — post-turn summary log. CC's `system:post_turn_summary`
    // row carries rich per-turn metadata; we log every one to the DB. Surface
    // design is deferred per the buildout — collect data first.
    maybePersistPostTurnSummary(projectId, event);
    // Section 31.9 — first-prompt heuristic + CC's `ai-title` envelope both
    // resolve the session-name surface. Heuristic fires on the first
    // `jsonl-user` and sticks; ai-title (when it fires) overwrites with the
    // refining model-generated name. Empirically, ai-title NEVER fires under
    // `--agent <name>` spawns (the entire orchestrator + every PM pod), so
    // the heuristic is the only path that lands a title for PC sessions.
    // See the implementation notes (2026-05-25 Session 36) for the bisect.
    maybeSetSessionTitle(projectId, event);
    maybeApplyAiTitle(projectId, event);
  });
  session.on('jsonl-path-resolved', (jsonlPath: string) => {
    const active = getActiveOrchestratorSession(projectId);
    if (active) setOrchestratorSessionJsonlPath(active.id, jsonlPath);
    noteRuntimeActivity(projectId);
    broadcastRuntimeSnapshot(projectId, runtime);
  });
  session.on('jsonl-cursor-tick', (_path: string, cursor: number) => {
    const active = getActiveOrchestratorSession(projectId);
    if (active) setOrchestratorSessionJsonlCursor(active.id, cursor);
  });
  session.on('exit', (code: number | undefined, signal: string | undefined) => {
    noteRuntimeExit(projectId, code, signal);
    broadcastTo(projectId, { type: 'exit', code, signal });
    broadcastRuntimeSnapshot(projectId, runtime);
    console.log(`[pc] ${projectId} session exited code=${code} signal=${signal}`);
  });
  const currentJsonlPath = session.getJsonlPath();
  if (currentJsonlPath) {
    const active = getActiveOrchestratorSession(projectId);
    if (active) setOrchestratorSessionJsonlPath(active.id, currentJsonlPath);
  }
  flag.__pcHandlersAttached = true;
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

function readSettings(): GlobalSettings {
  const stored = getGlobalSettings();
  // Section 22.3 — always surface the effective runtime dataDir (the value
  // every storage path actually uses), overriding any stale persisted value.
  // The modal field is informational and read-only; changing it requires
  // restarting with a different PC_DATA_DIR env var.
  const merged = withSettingsDefaults(stored ?? {}, getDataDir(), homedir());
  return { ...merged, dataDir: getDataDir() };
}

app.get('/api/settings', (c) => {
  return c.json({ ok: true, settings: readSettings() });
});

/** Partial settings update. Body accepts any subset of the envelope.
 *
 *  Section 22.3 — `dataDir` is informational only: ignored on PATCH, always
 *  returned as the effective `getDataDir()` value. Restart with a different
 *  `PC_DATA_DIR` env var to actually move storage. */
app.patch('/api/settings', async (c) => {
  const body = await c.req
    .json<Partial<GlobalSettings>>()
    .catch((): Partial<GlobalSettings> => ({}));
  const current = readSettings();
  const merged: GlobalSettings = withSettingsDefaults(
    {
      // dataDir is always the effective runtime value — see comment above.
      dataDir: getDataDir(),
      telemetryOptIn:
        typeof body.telemetryOptIn === 'boolean' ? body.telemetryOptIn : current.telemetryOptIn,
      claudeExe:
        body.claudeExe === undefined
          ? current.claudeExe
          : typeof body.claudeExe === 'string' && body.claudeExe.trim()
            ? body.claudeExe.trim()
            : null,
      claudeConfigDir:
        body.claudeConfigDir === undefined
          ? current.claudeConfigDir
          : typeof body.claudeConfigDir === 'string' && body.claudeConfigDir.trim()
            ? body.claudeConfigDir.trim()
            : null,
      onboardingCompletedAt:
        body.onboardingCompletedAt === undefined
          ? current.onboardingCompletedAt
          : typeof body.onboardingCompletedAt === 'string' && body.onboardingCompletedAt.trim()
            ? body.onboardingCompletedAt.trim()
            : null,
      defaultOrchestratorSurface: normalizeOrchestratorSurfacePreference(
        (body as { defaultOrchestratorSurface?: unknown }).defaultOrchestratorSurface,
        current.defaultOrchestratorSurface,
      ),
      projectsFolder:
        typeof body.projectsFolder === 'string' && body.projectsFolder.trim()
          ? body.projectsFolder.trim()
          : current.projectsFolder,
      activityPanel: {
        open: body.activityPanel?.open ?? current.activityPanel.open,
        showAllProjects:
          body.activityPanel?.showAllProjects ?? current.activityPanel.showAllProjects,
      },
      bugLogTargetProjectId:
        body.bugLogTargetProjectId === undefined
          ? current.bugLogTargetProjectId
          : body.bugLogTargetProjectId,
      fontScale:
        typeof body.fontScale === 'number' ? body.fontScale : current.fontScale,
      agentDispatch: {
        ackTimeoutMs:
          typeof body.agentDispatch?.ackTimeoutMs === 'number'
            ? body.agentDispatch.ackTimeoutMs
            : current.agentDispatch.ackTimeoutMs,
        maxConcurrent:
          typeof body.agentDispatch?.maxConcurrent === 'number'
            ? body.agentDispatch.maxConcurrent
            : current.agentDispatch.maxConcurrent,
      },
      jsonl: {
        retentionDays:
          body.jsonl?.retentionDays === 'never' ||
          typeof body.jsonl?.retentionDays === 'number'
            ? body.jsonl.retentionDays
            : current.jsonl.retentionDays,
      },
      hideCancelledStage:
        typeof body.hideCancelledStage === 'boolean'
          ? body.hideCancelledStage
          : current.hideCancelledStage,
    },
    getDataDir(),
    homedir(),
  );
  setGlobalSettings(merged);
  // Keep the runtime resolver in lockstep with the stored override. Takes
  // effect on the next spawn (existing PtY sessions keep their resolved path).
  setConfiguredClaudeExe(merged.claudeExe);
  // Section 33 — redirect CLAUDE_CONFIG_DIR immediately so the next fresh chat
  // session (and every JSONL path computed after this) uses the chosen
  // profile. Live sessions are unaffected; the UI nudges + New session.
  applyClaudeConfigDirOverride(merged.claudeConfigDir);
  const restartRequired = merged.dataDir !== current.dataDir;
  return c.json({ ok: true, settings: merged, restartRequired });
});

/** Section 33 — which Claude account/profile PC is actually talking to right
 *  now. `override` is the stored choice (null = inherit shell env); `effective`
 *  is the resolved CLAUDE_CONFIG_DIR every spawn + JSONL path uses; `source`
 *  explains where `effective` came from. Drives the General-tab read-out so the
 *  user can see which account is live without inspecting their shell env. */
app.get('/api/settings/claude-profile', (c) => {
  const override = readSettings().claudeConfigDir;
  return c.json({
    ok: true,
    override,
    effective: claudeConfigDir(),
    source: override ? 'override' : SHELL_CLAUDE_CONFIG_DIR ? 'shell' : 'default',
  });
});

// ── Preflight (Section 10 Phase 0) ────────────────────────────────────────

/** Structured report of runtime-dependency health (claude binary + version,
 *  git, soft deps). The onboarding wizard + a diagnostics view consume this. */
app.get('/api/preflight', async (c) => {
  const preflight = await runPreflight();
  return c.json({ ok: true, preflight });
});

// ── Onboarding installs (Section 10 Phase 2) ──────────────────────────────
// Run the OFFICIAL installers on an explicit wizard click. Each re-runs
// preflight and returns it so the wizard can advance. Long-running.

app.post('/api/onboarding/install/claude', async (c) => {
  try {
    const r = await installClaude();
    return c.json({ ok: true, ...r });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

app.post('/api/onboarding/install/git', async (c) => {
  try {
    const r = await installGit();
    return c.json({ ok: true, ...r });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

// Sign-in drive: spawn CC's own `claude auth login`; the wizard polls state.
app.post('/api/onboarding/auth/login', (c) => {
  try {
    return c.json({ ok: true, login: startLogin() });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

app.get('/api/onboarding/auth/state', async (c) => {
  const auth = await probeAuth();
  return c.json({ ok: true, login: getLoginState(), authed: auth.status === 'authed', auth });
});

app.post('/api/onboarding/auth/cancel', (c) => {
  cancelLogin();
  return c.json({ ok: true });
});

// ── Filesystem browse + probe (create-project UI) ─────────────────────────

/** List a directory for the folder picker. Query:
 *    path       — directory to list (defaults to ~/ or the gate root).
 *    gateRoot   — optional absolute path. When set, restricts browsing to
 *                 within this root (returns 403 for paths outside). Used by
 *                 the create-project flow with the global projectsFolder
 *                 setting; omitted by the App Settings picker that sets the
 *                 projectsFolder itself. */
app.get('/api/fs/browse', (c) => {
  const path = c.req.query('path') ?? '';
  const gateRoot = c.req.query('gateRoot');
  const opts = gateRoot && gateRoot.trim() ? { roots: [gateRoot.trim()] } : {};
  try {
    return c.json({ ok: true, ...browseFolder(path, opts) });
  } catch (err) {
    if (err instanceof BrowseError) {
      const status = err.kind === 'forbidden' ? 403 : err.kind === 'not_found' ? 404 : 400;
      return c.json({ ok: false, error: err.message, kind: err.kind }, status);
    }
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

/** Enumerate drive roots for the picker's drive-jump row (Windows). */
app.get('/api/fs/drives', (c) => {
  return c.json({ ok: true, drives: listDrives() });
});

/** Create one direct child directory under the currently viewed folder. Body:
 *    parentPath — absolute directory to create inside
 *    name       — single folder-name segment
 *    gateRoot   — optional browse gate; when set, parent + child must stay
 *                 inside it. */
app.post('/api/fs/mkdir', async (c) => {
  const body = await c.req.json<{ parentPath?: string; name?: string; gateRoot?: string }>();
  const parentPath = typeof body.parentPath === 'string' ? body.parentPath.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const gateRoot = typeof body.gateRoot === 'string' ? body.gateRoot.trim() : '';
  if (!parentPath) return c.json({ ok: false, error: 'parentPath required' }, 400);
  if (!name) return c.json({ ok: false, error: 'folder name required' }, 400);

  const opts = gateRoot ? { roots: [gateRoot] } : {};
  try {
    return c.json({ ok: true, ...createChildFolder(parentPath, name, opts) });
  } catch (err) {
    if (err instanceof BrowseError) {
      const status =
        err.kind === 'forbidden'
          ? 403
          : err.kind === 'not_found'
            ? 404
            : err.kind === 'already_exists'
              ? 409
              : 400;
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

/** 5+.4 (D87) — drag-reorder the LeftRail Projects list. Body:
 *  `{ orderedIds: ULID[] }` — the full list of live project IDs in their new
 *  display order. Server rewrites every row's `position` to its index in
 *  one transaction. Unknown / soft-deleted ids are silently dropped (repo-
 *  level enforcement). Registered before the :projectId variant for clarity;
 *  Hono's trie-router prefers literal segments anyway. */
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

/** Patch a project's mutable metadata (name + git_remote). Slug stays locked
 *  per the project settings contract. Body: `{ name?, git_remote? }`. */
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

/** Soft-delete a project. Filesystem is untouched per the multi-tenancy design;
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
  const skipped: { dir: string; reason: string }[] = [];
  for (const sub of ['.project-companion', '.claude']) {
    const target = resolve(folder, sub);
    if (!existsSync(target)) continue;
    // Section 22.7 — `.claude/` is a user-owned dir name (Claude Code itself
    // uses it). Only remove it when PC's ownership marker is present, so an
    // attach-to-git'd repo's pre-existing `.claude/` config isn't wiped.
    // `.project-companion/` is unambiguously PC-owned and skips the check.
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

/** 5+.2 — read-only file tree for the LeftRail Files tab. Walks the project's
 *  folderPath applying the D92 hard-skip list + .gitignore. Returns the full
 *  recursive tree; the renderer collapses/expands client-side. */
app.get('/api/projects/:projectId/files/tree', async (c) => {
  const id = c.req.param('projectId') as ULID;
  const project = getProjectById(id);
  if (!project) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  try {
    const tree = await getFilesTree(project.folderPath);
    return c.json({ ok: true, tree });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

/** 5+.2 — read-only preview for a single file under the project root. The
 *  `path` query param is relative + posix-style (the tree returns paths in
 *  that shape). Server resolves + bounds-checks to keep the read confined to
 *  folderPath. Renderer kinds: markdown / html / image / text / binary /
 *  oversized — see services/files-tree.ts for the cap + classification. */
app.get('/api/projects/:projectId/files/preview', async (c) => {
  const id = c.req.param('projectId') as ULID;
  const project = getProjectById(id);
  if (!project) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const relPath = c.req.query('path');
  if (typeof relPath !== 'string' || relPath.length === 0) {
    return c.json({ ok: false, error: 'path query param is required' }, 400);
  }
  try {
    const preview = await previewFile(project.folderPath, relPath);
    return c.json({ ok: true, preview });
  } catch (err) {
    if (err instanceof FilePathOutsideProjectError) {
      return c.json({ ok: false, error: err.message }, 400);
    }
    if (err instanceof FileNotFoundError) {
      return c.json({ ok: false, error: err.message }, 404);
    }
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

/** Create a project: git init in `folder_path`, write the PC scaffold, commit,
 *  insert the DB row, register the runtime. Body:
 *    { name, folder_path, mode: 'init-empty' | 'init-in-place' | 'attach-to-git', git_remote? }
 *
 *  Per the project settings contract the UI probes the folder first and picks the
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
  if (
    !name ||
    !folderPath ||
    (mode !== 'init-empty' && mode !== 'init-in-place' && mode !== 'attach-to-git')
  ) {
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
  const project = getProjectById(runtime.project.id);
  if (!project) return c.json({ ok: false, error: `project disappeared: ${id}` }, 404);
  return c.json(project);
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

/** Current orchestrator runtime snapshot. This endpoint is intentionally
 *  no-spawn: it reports whether Claude is live, busy, exited, respawnable, or
 *  inaccessible without creating a child process as a side effect. */
app.get('/api/projects/:projectId/orchestrator/runtime', (c) => {
  const id = c.req.param('projectId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  return c.json({ ok: true, runtime: runtimeSnapshotPayload(id, runtime) });
});

/** Smoke-only PTY control. Guarded by a header and the pc-smoke project prefix
 *  so browser tests can pin process-exit recovery without exposing a normal
 *  destructive control for user projects. */
app.post('/api/projects/:projectId/orchestrator/smoke/kill-pty', (c) => {
  const id = c.req.param('projectId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  if (
    c.req.header('x-pc-smoke-control') !== '1' ||
    !runtime.project.slug.startsWith('pc-smoke')
  ) {
    return c.json({ ok: false, error: 'smoke control is not available' }, 404);
  }
  const killed = runtime.killOrchestratorForSmoke();
  broadcastRuntimeSnapshot(id, runtime);
  return c.json({
    ok: true,
    killed,
    runtime: runtimeSnapshotPayload(id, runtime),
  });
});

/** Full history of orchestrator sessions for the project (most recent first).
 *  Feeds the "previous sessions" rail tab. */
app.get('/api/projects/:projectId/sessions', (c) => {
  const id = c.req.param('projectId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  return c.json({ ok: true, sessions: listOrchestratorSessionsForProject(id) });
});

/** Replay a specific session's normalized event log. Used by the Sessions
 *  tab to render past chats in read-only mode. Returns envelope-shape
 *  objects so the client can demux on `type` (jsonl vs legacy hook event). */
app.get('/api/projects/:projectId/sessions/:sessionId/events', (c) => {
  const id = c.req.param('projectId') as ULID;
  const sessionId = c.req.param('sessionId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const replay = loadSessionReplayCheckpoint(runtime.sessionDataPath(sessionId), sessionId);
  return c.json({
    ok: true,
    sessionId: replay.sessionId,
    highWaterSeq: replay.highWaterSeq,
    events: replay.events,
  });
});

/** Tail of the raw PTY transcript for the terminal renderer. This is a debug
 *  terminal surface only; chat replay remains jsonl-events.jsonl. */
app.get('/api/projects/:projectId/sessions/:sessionId/terminal-transcript', (c) => {
  const id = c.req.param('projectId') as ULID;
  const sessionId = c.req.param('sessionId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const persistedSession = getOrchestratorSession(sessionId);
  const transientSession =
    !persistedSession && runtime.hasLiveTransientSession(sessionId)
      ? { id: sessionId, projectId: id }
      : null;
  const result = readTerminalTranscriptTail({
    projectId: id,
    sessionId,
    session: persistedSession ?? transientSession,
    runtime,
    tailBytes: normalizeTerminalTranscriptTailBytes(c.req.query('tailBytes')),
  });
  if (!result.ok) return c.json({ ok: false, error: result.error }, result.status);
  return c.json(result);
});

/** Start a fresh session: end the active row, kill the PTY, return the empty
 *  replay checkpoint immediately, then respawn Claude in the background. */
app.post('/api/projects/:projectId/sessions/new', (c) => {
  const id = c.req.param('projectId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const previous = getActiveOrchestratorSession(id);
  if (previous) {
    cancelOpenOrchestratorSendsForSession(previous.id, 'session replaced by new session');
    broadcastSendQueueSnapshot(id, previous.id);
  }
  const session = runtime.startNewSession();
  const replay = loadSessionReplay(runtime, session.id);
  // Tell every subscriber to clear its local chat state; the next replay will
  // be empty (we just wiped events.jsonl) so the panel starts blank.
  broadcastTo(id, { type: 'session-changed', transition: 'new-session', session });
  broadcastSessionReplay(id, replay);
  broadcastSendQueueSnapshot(id, session.id);
  startOrchestratorPtyInBackground(id, runtime);
  return c.json({
    ok: true,
    transition: 'new-session',
    session,
    replay: replay.events,
    highWaterSeq: replay.highWaterSeq,
  });
});

/** Resume a past orchestrator session. Re-activates the target row, respawns
 *  the PTY with --resume so claude.exe loads the prior context, then sends an
 *  atomic replay snapshot so the chat panel re-populates immediately. Live
 *  JSONL tailing starts at the persisted cursor; replay comes from PC's
 *  durable per-session event log. */
app.post('/api/projects/:projectId/sessions/:targetId/resume', (c) => {
  const id = c.req.param('projectId') as ULID;
  const targetId = c.req.param('targetId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const previous = getActiveOrchestratorSession(id);
  let session;
  try {
    session = runtime.resumeSession(targetId);
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 400);
  }
  if (previous && previous.id !== session.id) {
    cancelOpenOrchestratorSendsForSession(previous.id, 'session replaced by resume');
    broadcastSendQueueSnapshot(id, previous.id);
  }
  const replay = loadSessionReplay(runtime, session.id);
  broadcastTo(id, { type: 'session-changed', transition: 'resume-session', session });
  broadcastSessionReplay(id, replay);
  broadcastSendQueueSnapshot(id, session.id);
  startOrchestratorPtyInBackground(id, runtime);
  return c.json({
    ok: true,
    transition: 'resume-session',
    session,
    replay: replay.events,
    highWaterSeq: replay.highWaterSeq,
  });
});

app.post('/api/projects/:projectId/send-queue/:sendId/cancel', (c) => {
  const id = c.req.param('projectId') as ULID;
  const sendId = c.req.param('sendId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const active = getActiveOrchestratorSession(id);
  if (!active) return c.json({ ok: false, error: 'No active orchestrator session' }, 404);

  const existing = getOrchestratorSendQueueRow(sendId);
  if (!existing || existing.projectId !== id || existing.sessionId !== active.id) {
    return c.json({ ok: false, error: 'Queued prompt not found' }, 404);
  }

  const cancelled = cancelQueuedOrchestratorSend(sendId, active.id, 'user cancelled');
  if (!cancelled) {
    return c.json({
      ok: false,
      error: `Queued prompt is already ${existing.status}`,
    }, 409);
  }

  broadcastSendQueueSnapshot(id, active.id);
  return c.json({ ok: true, item: publicSendQueueItem(cancelled) });
});

app.post('/api/projects/:projectId/send-queue/:sendId/retry', (c) => {
  const id = c.req.param('projectId') as ULID;
  const sendId = c.req.param('sendId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const active = getActiveOrchestratorSession(id);
  if (!active) return c.json({ ok: false, error: 'No active orchestrator session' }, 404);

  const existing = getOrchestratorSendQueueRow(sendId);
  if (!existing || existing.projectId !== id || existing.sessionId !== active.id) {
    return c.json({ ok: false, error: 'Queued prompt not found' }, 404);
  }
  if (existing.status !== 'failed') {
    return c.json({
      ok: false,
      error: `Queued prompt is ${existing.status}, not failed`,
    }, 409);
  }

  let live = runtime.ptySession();
  if (!live) {
    try {
      live = ensureOrchestratorPty(id, runtime);
    } catch (err) {
      return c.json({
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to restart Claude',
      }, 409);
    }
  }

  const state = live.getState();
  const hasBacklog = hasOpenOrchestratorSendsForSession(active.id);
  const retried = retryFailedOrchestratorSend(
    sendId,
    active.id,
    queuedStatusForState(state, hasBacklog),
  );
  if (!retried) {
    return c.json({ ok: false, error: 'Failed prompt could not be retried' }, 409);
  }

  broadcastSendQueueSnapshot(id, active.id);
  if (state === 'ready') {
    deliverNextQueuedPrompt(id, runtime, broadcastSendQueueSnapshot);
  }
  return c.json({ ok: true, item: publicSendQueueItem(retried) });
});

function loadSessionReplay(
  runtime: ProjectRuntime,
  sessionId: ULID,
): SessionReplayCheckpoint {
  return loadSessionReplayCheckpoint(runtime.sessionDataPath(sessionId), sessionId);
}

/** Send a session's normalized event log as one checkpoint. This keeps
 *  resume/reconnect deterministic on the client: the live buffer is replaced
 *  once with the replay snapshot, instead of being rebuilt from a burst of
 *  individual WS messages that can race local navigation state. */
function broadcastSessionReplay(
  projectId: ULID,
  replay: SessionReplayCheckpoint,
): void {
  broadcastTo(projectId, {
    type: 'session-replay',
    sessionId: replay.sessionId,
    highWaterSeq: replay.highWaterSeq,
    events: replay.events,
  });
}

// ── Agent-designer transient session (17b.12) ─────────────────────────────
//
// Mirror of the agent-creator wiring above, but spawns CC with
// `--agent agent-designer` (replaces CC's default system prompt with the
// pod's content) + session-local runtime files. Free-form chat conversation
// for designing a new agent.
//
// WS envelopes (distinct from agent-creator / workflow-creator streams):
//   { type: 'agent-designer-state', state }
//   { type: 'agent-designer-event', event }       — legacy hook events
//   { type: 'agent-designer-jsonl', event }       — JSONL tailer events
//   { type: 'agent-designer-exit', code, signal }
//
// Lifetime = modal-open. Closes implicitly when pc_create_agent fires
// (project-agents-changed → modal handles cleanup) OR explicitly via the
// DELETE route.

function attachAgentDesignerHandlers(
  projectId: ULID,
  session: ReturnType<ProjectRuntime['startAgentDesigner']>,
  sessionId: string | null,
): void {
  const flag = session as unknown as { __pcAgentDesignerAttached?: boolean };
  if (flag.__pcAgentDesignerAttached) return;
  let terminalSeq = 0;
  session.on('raw', (text: string) => {
    terminalSeq += 1;
    broadcastTo(projectId, {
      type: 'agent-designer-raw',
      sessionId,
      terminalSeq,
      text,
    });
  });
  session.on('state', (state: string) =>
    broadcastTo(projectId, { type: 'agent-designer-state', sessionId, state }),
  );
  session.on('event', (event: unknown) =>
    broadcastTo(projectId, { type: 'agent-designer-event', sessionId, event }),
  );
  session.on('jsonl-event', (event: unknown) =>
    broadcastTo(projectId, { type: 'agent-designer-jsonl', sessionId, event }),
  );
  session.on('exit', (code: number | undefined, signal: string | undefined) => {
    broadcastTo(projectId, { type: 'agent-designer-exit', sessionId, code, signal });
  });
  flag.__pcAgentDesignerAttached = true;
}

app.post('/api/projects/:projectId/agent-designer/start', (c) => {
  const id = c.req.param('projectId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  try {
    const session = runtime.startAgentDesigner();
    const sessionId = runtime.agentDesignerSession();
    attachAgentDesignerHandlers(id, session, sessionId);
    broadcastTo(id, { type: 'agent-designer-state', sessionId, state: session.getState() });
    return c.json({ ok: true, state: session.getState(), sessionId });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

app.post('/api/projects/:projectId/agent-designer/send', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const session = runtime.agentDesignerPty();
  if (!session) return c.json({ ok: false, error: 'no agent-designer session' }, 409);
  const body = await c.req.json<{ text?: string }>();
  if (typeof body.text !== 'string' || body.text === '') {
    return c.json({ ok: false, error: 'text required' }, 400);
  }
  session.send(body.text);
  return c.json({ ok: true });
});

app.post('/api/projects/:projectId/agent-designer/interrupt', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  runtime.agentDesignerPty()?.interrupt();
  return c.json({ ok: true });
});

app.post('/api/projects/:projectId/agent-designer/terminal-input', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{ data?: unknown }>().catch(() => ({}) as { data?: unknown });
  const result = forwardTerminalInput(
    { ptySession: () => runtime.agentDesignerPty() },
    body.data,
  );
  if (!result.ok) return c.json({ ok: false, error: result.error, status: result.status }, 400);
  return c.json({ ok: true, bytesWritten: result.bytesWritten });
});

app.post('/api/projects/:projectId/agent-designer/resize', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{ cols?: unknown; rows?: unknown }>().catch(
    () => ({}) as { cols?: unknown; rows?: unknown },
  );
  if (typeof body.cols === 'number' && typeof body.rows === 'number') {
    runtime.resizeAgentDesigner(body.cols, body.rows);
  }
  return c.json({ ok: true });
});

app.delete('/api/projects/:projectId/agent-designer', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  runtime.endAgentDesigner();
  return c.json({ ok: true });
});

// ── Workflow-builder transient session (Section 19.9, v2-aware) ────────────
//
// Mirror of agent-designer wiring. Spawns CC with `--agent workflow-builder`
// (replaces CC's default identity with the pod's content) + the materialised
// pod mcp.json. Distinct from `workflow-creator` above (which is the v1 pod);
// both coexist until Section 19.12.
//
// WS envelopes:
//   { type: 'workflow-builder-state', state }
//   { type: 'workflow-builder-event', event }       — legacy hook events
//   { type: 'workflow-builder-jsonl', event }       — JSONL tailer events
//   { type: 'workflow-builder-exit', code, signal }
//   { type: 'workflow-builder-draft', sessionId, def } — broadcast by the
//     /workflow-builder/draft POST handler when pc_save_workflow_draft fires

function attachWorkflowBuilderHandlers(
  projectId: ULID,
  session: ReturnType<ProjectRuntime['startWorkflowBuilder']>,
  sessionId: string | null,
): void {
  const flag = session as unknown as { __pcWorkflowBuilderAttached?: boolean };
  if (flag.__pcWorkflowBuilderAttached) return;
  let terminalSeq = 0;
  session.on('raw', (text: string) => {
    terminalSeq += 1;
    broadcastTo(projectId, {
      type: 'workflow-builder-raw',
      sessionId,
      terminalSeq,
      text,
    });
  });
  session.on('state', (state: string) =>
    broadcastTo(projectId, { type: 'workflow-builder-state', sessionId, state }),
  );
  session.on('event', (event: unknown) =>
    broadcastTo(projectId, { type: 'workflow-builder-event', sessionId, event }),
  );
  session.on('jsonl-event', (event: unknown) =>
    broadcastTo(projectId, { type: 'workflow-builder-jsonl', sessionId, event }),
  );
  session.on('exit', (code: number | undefined, signal: string | undefined) => {
    broadcastTo(projectId, { type: 'workflow-builder-exit', sessionId, code, signal });
  });
  flag.__pcWorkflowBuilderAttached = true;
}

app.post('/api/projects/:projectId/workflow-builder/start', (c) => {
  const id = c.req.param('projectId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  try {
    const session = runtime.startWorkflowBuilder();
    const sessionId = runtime.workflowBuilderSession();
    attachWorkflowBuilderHandlers(id, session, sessionId);
    broadcastTo(id, { type: 'workflow-builder-state', sessionId, state: session.getState() });
    return c.json({
      ok: true,
      state: session.getState(),
      sessionId,
    });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

app.post('/api/projects/:projectId/workflow-builder/send', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const session = runtime.workflowBuilderPty();
  if (!session) return c.json({ ok: false, error: 'no workflow-builder session' }, 409);
  const body = await c.req.json<{ text?: string }>();
  if (typeof body.text !== 'string' || body.text === '') {
    return c.json({ ok: false, error: 'text required' }, 400);
  }
  session.send(body.text);
  return c.json({ ok: true });
});

app.post('/api/projects/:projectId/workflow-builder/interrupt', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  runtime.workflowBuilderPty()?.interrupt();
  return c.json({ ok: true });
});

app.post('/api/projects/:projectId/workflow-builder/terminal-input', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{ data?: unknown }>().catch(() => ({}) as { data?: unknown });
  const result = forwardTerminalInput(
    { ptySession: () => runtime.workflowBuilderPty() },
    body.data,
  );
  if (!result.ok) return c.json({ ok: false, error: result.error, status: result.status }, 400);
  return c.json({ ok: true, bytesWritten: result.bytesWritten });
});

app.post('/api/projects/:projectId/workflow-builder/resize', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{ cols?: unknown; rows?: unknown }>().catch(
    () => ({}) as { cols?: unknown; rows?: unknown },
  );
  if (typeof body.cols === 'number' && typeof body.rows === 'number') {
    runtime.resizeWorkflowBuilder(body.cols, body.rows);
  }
  return c.json({ ok: true });
});

app.delete('/api/projects/:projectId/workflow-builder', (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  runtime.endWorkflowBuilder();
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
  sessionId: string | null,
): void {
  const flag = session as unknown as { __pcSetupWizardAttached?: boolean };
  if (flag.__pcSetupWizardAttached) return;
  let terminalSeq = 0;
  session.on('raw', (text: string) => {
    terminalSeq += 1;
    broadcastTo(projectId, {
      type: 'setup-wizard-raw',
      sessionId,
      terminalSeq,
      text,
    });
  });
  session.on('state', (state: string) =>
    broadcastTo(projectId, { type: 'setup-wizard-state', sessionId, state }),
  );
  session.on('event', (event: unknown) =>
    broadcastTo(projectId, { type: 'setup-wizard-event', sessionId, event }),
  );
  session.on('jsonl-event', (event: unknown) =>
    broadcastTo(projectId, { type: 'setup-wizard-jsonl', sessionId, event }),
  );
  session.on('exit', (code: number | undefined, signal: string | undefined) => {
    broadcastTo(projectId, { type: 'setup-wizard-exit', sessionId, code, signal });
  });
  flag.__pcSetupWizardAttached = true;
}

app.post('/api/projects/:projectId/setup-wizard/start', (c) => {
  const id = c.req.param('projectId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const session = runtime.startSetupWizard();
  const sessionId = runtime.setupWizardSession();
  attachSetupWizardHandlers(id, session, sessionId);
  broadcastTo(id, { type: 'setup-wizard-state', sessionId, state: session.getState() });
  return c.json({ ok: true, state: session.getState(), sessionId });
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

app.post('/api/projects/:projectId/setup-wizard/terminal-input', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{ data?: unknown }>().catch(() => ({}) as { data?: unknown });
  const result = forwardTerminalInput(
    { ptySession: () => runtime.setupWizardPty() },
    body.data,
  );
  if (!result.ok) return c.json({ ok: false, error: result.error, status: result.status }, 400);
  return c.json({ ok: true, bytesWritten: result.bytesWritten });
});

app.post('/api/projects/:projectId/setup-wizard/resize', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{ cols?: unknown; rows?: unknown }>().catch(
    () => ({}) as { cols?: unknown; rows?: unknown },
  );
  if (typeof body.cols === 'number' && typeof body.rows === 'number') {
    runtime.resizeSetupWizard(body.cols, body.rows);
  }
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
    return c.json({ workItems: dbListWorkItems(runtime.project.id) });
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
 *  path; this one stays for MCP backwards-compat + workflow re-fire flows.
 *
 *  Section 27 — accepts `toFlag: 'done' | 'cancelled' | 'new'` as an
 *  alternative to `toStage`. Exactly-one-of. Resolves to the project's stage
 *  carrying that flag; 400 if no such stage. Optional `notes?` lands on the
 *  card's move history entry. */
app.post('/api/projects/:projectId/work-items/move', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{
    id?: string;
    toStage?: string;
    toFlag?: 'done' | 'cancelled' | 'new';
    notes?: string;
  }>();
  const wiId = typeof body.id === 'string' ? body.id.trim() : '';
  const toStage = typeof body.toStage === 'string' ? body.toStage.trim() : '';
  const toFlag = typeof body.toFlag === 'string' ? body.toFlag.trim() : '';
  const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
  if (!wiId) return c.json({ ok: false, error: 'id required' }, 400);
  if (!toStage && !toFlag) {
    return c.json({ ok: false, error: 'toStage or toFlag required' }, 400);
  }
  if (toStage && toFlag) {
    return c.json({ ok: false, error: 'pass exactly one of toStage / toFlag' }, 400);
  }
  let resolvedStage = toStage;
  if (toFlag) {
    if (toFlag !== 'done' && toFlag !== 'cancelled' && toFlag !== 'new') {
      return c.json({ ok: false, error: `unknown toFlag: ${toFlag}` }, 400);
    }
    const project = getProjectById(id as ULID);
    if (!project) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const flagKey = toFlag === 'done' ? 'isDone' : toFlag === 'cancelled' ? 'isCancelled' : 'isNew';
    const match = project.stages.find((s) => s[flagKey]);
    if (!match) {
      return c.json(
        { ok: false, error: `no stage in project carries is_${toFlag}` },
        400,
      );
    }
    resolvedStage = match.id;
  }
  try {
    const workItem = await runtime.moveAndFireV2({
      id: wiId,
      toStage: resolvedStage,
      notes: notes || null,
    });
    broadcastTo(id as ULID, { type: 'work-items-changed', change: 'moved', workItem });
    return c.json({ ok: true, workItem });
  } catch (err) {
    const msg = (err as Error).message;
    const is409 = /^ambiguous trigger|^no valid workflow|is locked: workflow in progress/.test(msg);
    return c.json({ ok: false, error: msg }, is409 ? 409 : 500);
  }
});

/** Legacy fields-merge endpoint. Used by MCP `pc_update_work_item`. Also
 *  accepts optional `body` and `title` — those flow through WorkItemService
 *  .patch() (reads current version to avoid optimistic-lock conflicts). The new
 *  `PATCH /work-items/:wiId` is the version-checked UI path. */
app.post('/api/projects/:projectId/work-items/update', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{
    id?: string;
    fields?: Record<string, unknown>;
    body?: string;
    title?: string;
  }>();
  const wiId = typeof body.id === 'string' ? body.id.trim() : '';
  const fields = body.fields && typeof body.fields === 'object' ? body.fields : null;
  const bodyText = typeof body.body === 'string' ? body.body : undefined;
  const titleText = typeof body.title === 'string' ? body.title : undefined;
  if (!wiId) return c.json({ ok: false, error: 'id required' }, 400);
  if (!fields && bodyText === undefined && titleText === undefined) {
    return c.json({ ok: false, error: 'at least one of fields, body, or title required' }, 400);
  }
  try {
    if (bodyText !== undefined || titleText !== undefined) {
      // body/title changes use WorkItemService.patch (reads current version first).
      const current = runtime.workItemService().get(wiId as ULID);
      if (!current) return c.json({ ok: false, error: `unknown work item: ${wiId}` }, 404);
      const patchInput: Parameters<ReturnType<typeof runtime.workItemService>['patch']>[1] = {
        expectedVersion: current.version,
      };
      if (titleText !== undefined) patchInput.title = titleText;
      if (bodyText !== undefined) patchInput.body = bodyText;
      if (fields) patchInput.fields = fields;
      const workItem = runtime.workItemService().patch(wiId as ULID, patchInput);
      broadcastTo(id as ULID, { type: 'work-items-changed', change: 'updated', workItem });
      return c.json({ ok: true, workItem });
    }
    // Fields-only path — legacy unchecked merge.
    const workItem = dbUpdateWorkItemFields(wiId as ULID, fields!);
    if (!workItem) return c.json({ ok: false, error: `unknown work item: ${wiId}` }, 404);
    void runtime;
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
    type?: string;
    fields?: Record<string, unknown>;
    taggedProjectId?: string | null;
  }>();
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const stageId = typeof body.stageId === 'string' ? body.stageId.trim() : '';
  if (!title || !stageId) return c.json({ ok: false, error: 'title and stageId required' }, 400);
  let typeOpt: WorkItemType | undefined;
  if (body.type !== undefined) {
    if (!isWorkItemType(body.type)) {
      return c.json({ ok: false, error: `unknown work-item type: ${String(body.type)}` }, 400);
    }
    typeOpt = body.type;
  }
  try {
    // Service broadcasts 'created' internally; the route does not re-broadcast.
    const workItem = runtime.workItemService().create({
      title,
      stageId,
      ...(body.body !== undefined ? { body: body.body } : {}),
      ...(body.parentId !== undefined ? { parentId: body.parentId as ULID | null } : {}),
      ...(typeOpt !== undefined ? { type: typeOpt } : {}),
      ...(body.fields !== undefined ? { fields: body.fields } : {}),
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
    const msg = (err as Error).message;
    const is400 = /^unknown stage:|^title required$/.test(msg);
    return c.json({ ok: false, error: msg }, is400 ? 400 : 500);
  }
});

/** Section 26.3 — dispatch contract for agent work items. Same persistence as
 *  /work-items/create, plus is_agent_task=true, derived AC, and the contract
 *  fields. Bound to `pc_create_agent_work_item`. */
app.post('/api/projects/:projectId/work-items/create-agent-contract', async (c) => {
  const id = c.req.param('projectId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{
    title?: string;
    task?: string;
    pod?: string;
    expected_output?: unknown;
    verification_tier?: unknown;
    parent_work_item_id?: string | null;
    stage_id?: string;
    worktree?: string | null;
    ephemeral?: boolean;
    raw_acceptance_criteria?: unknown;
  }>();
  const input: CreateAgentWorkItemInput = {
    title: typeof body.title === 'string' ? body.title : '',
    task: typeof body.task === 'string' ? body.task : '',
    pod: typeof body.pod === 'string' ? body.pod : '',
    ...(body.expected_output !== undefined
      ? { expectedOutput: body.expected_output as CreateAgentWorkItemInput['expectedOutput'] }
      : {}),
    ...(typeof body.verification_tier === 'string'
      ? {
          verificationTier:
            body.verification_tier as CreateAgentWorkItemInput['verificationTier'],
        }
      : {}),
    ...(body.parent_work_item_id !== undefined
      ? { parentWorkItemId: body.parent_work_item_id as ULID | null }
      : {}),
    ...(typeof body.stage_id === 'string' ? { stageId: body.stage_id } : {}),
    ...(body.worktree !== undefined ? { worktree: body.worktree } : {}),
    ...(typeof body.ephemeral === 'boolean' ? { ephemeral: body.ephemeral } : {}),
    ...(body.raw_acceptance_criteria !== undefined
      ? {
          rawAcceptanceCriteria:
            body.raw_acceptance_criteria as CreateAgentWorkItemInput['rawAcceptanceCriteria'],
        }
      : {}),
  };
  try {
    const workItem = createAgentWorkItem(input, {
      workItemService: runtime.workItemService(),
      getProject: () => runtime.project,
    });
    return c.json({ ok: true, workItem });
  } catch (err) {
    if (err instanceof AgentWorkItemInputError) {
      return c.json({ ok: false, error: err.message }, 400);
    }
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

/** Section 26.6 — Approve a tier-2/3 verification hold. Flips
 *  `awaiting-verification` → `complete` + `verification_status: 'passed'`.
 *  Optional `notes` lands in `verificationNotes` + the history entry. */
app.post('/api/projects/:projectId/work-items/:wiId/approve', async (c) => {
  const id = c.req.param('projectId');
  const wiId = c.req.param('wiId') as ULID;
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const body = await c.req.json<{ notes?: string | null; actor?: 'orchestrator' | 'user' }>().catch(
    () => ({}) as { notes?: string | null; actor?: 'orchestrator' | 'user' },
  );
  try {
    const project = getProjectById(id as ULID);
    const workItem = approveAgentWorkItem({
      workItemId: wiId,
      notes: typeof body.notes === 'string' ? body.notes : null,
      ...(body.actor === 'orchestrator' || body.actor === 'user' ? { actor: body.actor } : {}),
      ...(project ? { project } : {}),
    });
    if (workItem.projectId !== id) {
      return c.json({ ok: false, error: `unknown work item: ${wiId}` }, 404);
    }
    return c.json({ ok: true, workItem });
  } catch (err) {
    if (err instanceof VerificationReviewError) {
      const statusFor: Record<string, number> = {
        'wi-not-found': 404,
        'not-agent-task': 400,
        'not-awaiting-verification': 409,
      };
      return c.json(
        { ok: false, error: err.message, cause: err.cause },
        (statusFor[err.cause] ?? 400) as 400,
      );
    }
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

/** Section 26.6 — Reject a tier-2/3 verification hold. Flips the WI back to
 *  `in-progress` + `verification_status: 'failed'` with feedback persisted in
 *  `verificationNotes`, then spawns a continuation of the producer run
 *  (Section 21's primitive) carrying the feedback as the resumed user
 *  message. The continuation dispatch's outcome rides in the response so the
 *  orchestrator sees the new runId. */
app.post('/api/projects/:projectId/work-items/:wiId/reject', async (c) => {
  const projectId = c.req.param('projectId') as ULID;
  const wiId = c.req.param('wiId') as ULID;
  const project = getProjectById(projectId);
  if (!project) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);
  const body = await c.req.json<{
    feedback?: string;
    actor?: 'orchestrator' | 'user';
    dispatcherSessionId?: string;
  }>();
  const dispatcherSessionId =
    typeof body.dispatcherSessionId === 'string' ? body.dispatcherSessionId.trim() : '';
  if (!dispatcherSessionId) {
    return c.json(
      { ok: false, error: 'dispatcherSessionId required (orchestrator must forward PC_SESSION_ID)' },
      400,
    );
  }
  try {
    const result = rejectAgentWorkItem(
      {
        workItemId: wiId,
        feedback: typeof body.feedback === 'string' ? body.feedback : '',
        ...(body.actor === 'orchestrator' || body.actor === 'user' ? { actor: body.actor } : {}),
        dispatcherSessionId,
        project,
      },
      {
        channelServer,
        broadcast: (env) => broadcastTo(projectId, env),
      },
    );
    if (result.workItem.projectId !== projectId) {
      return c.json({ ok: false, error: `unknown work item: ${wiId}` }, 404);
    }
    return c.json({
      ok: true,
      workItem: result.workItem,
      continuation: result.continuation,
    });
  } catch (err) {
    if (err instanceof VerificationReviewError) {
      const statusFor: Record<string, number> = {
        'wi-not-found': 404,
        'not-agent-task': 400,
        'not-awaiting-verification': 409,
        'feedback-required': 400,
        'no-assigned-run': 409,
      };
      return c.json(
        { ok: false, error: err.message, cause: err.cause },
        (statusFor[err.cause] ?? 400) as 400,
      );
    }
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

// ── Work item :wiId routes (new) ──────────────────────────────────────────

/** Fetch a single work item by id OR callsign (Section 35).
 *  `?includeArchived=1` returns soft-deleted rows too (used by restore flows).
 *  Accepts both shapes so chat rich-link clicks resolve whether the
 *  orchestrator wrote `pc://work-item/01KS...` or `pc://work-item/pc-2.1`. */
app.get('/api/projects/:projectId/work-items/:wiId', (c) => {
  const id = c.req.param('projectId') as ULID;
  const ref = c.req.param('wiId');
  const runtime = resolveProject(id);
  if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
  const includeArchived = c.req.query('includeArchived') === '1';
  const resolved = resolveWorkItemRef(id, ref);
  if (resolved) {
    if (includeArchived || resolved.deletedAt == null) {
      return c.json({ ok: true, workItem: resolved });
    }
  }
  // Fallback for the `?includeArchived=1` ULID-only path (resolver excludes
  // archived rows by design; the includeArchived branch needs the
  // including-archived read).
  if (includeArchived && looksLikeUlid(ref)) {
    const archived = runtime.workItemService().get(ref as ULID, { includeArchived: true });
    if (archived && archived.projectId === id) {
      return c.json({ ok: true, workItem: archived });
    }
  }
  return c.json({ ok: false, error: `unknown work item: ${ref}` }, 404);
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
    type?: string;
    fields?: Record<string, unknown>;
  }>();
  if (typeof body.version !== 'number') {
    return c.json({ ok: false, error: 'version required' }, 400);
  }
  if (body.type !== undefined && !isWorkItemType(body.type)) {
    return c.json({ ok: false, error: `unknown work-item type: ${String(body.type)}` }, 400);
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
    if (body.type !== undefined) input.type = body.type as WorkItemType;
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
    const moveArgs: Parameters<typeof runtime.moveAndFireV2>[0] = {
      id: wiId,
      toStage: stageId,
      expectedVersion: body.version,
    };
    if (body.position !== undefined) moveArgs.position = body.position;
    const workItem = await runtime.moveAndFireV2(moveArgs);
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

/** Section 1.5 — fetch attachment by id alone (rich-link URLs don't carry a
 *  work-item id, only the attachment id). Project-scoped through the same
 *  service guard as the work-item-scoped route above. */
app.get('/api/projects/:projectId/attachments/:aId', (c) => {
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
  const incoming: Stage[] = body.stages.map((s, idx) => ({
    id: String(s.id ?? '').trim(),
    name: String(s.name ?? '').trim(),
    order: typeof s.order === 'number' ? s.order : idx,
    ...(s.isDone === true ? { isDone: true } : {}),
    ...(s.isCancelled === true ? { isCancelled: true } : {}),
    ...(s.isNew === true ? { isNew: true } : {}),
  }));
  if (incoming.some((s) => !s.id || !s.name)) {
    return c.json({ ok: false, error: 'each stage requires id + name' }, 400);
  }
  const ids = new Set(incoming.map((s) => s.id));
  if (ids.size !== incoming.length) {
    return c.json({ ok: false, error: 'duplicate stage id' }, 400);
  }
  // Section 27 — at most one stage per flag per project.
  if (incoming.filter((s) => s.isDone).length > 1) {
    return c.json({ ok: false, error: 'at most one stage can be marked is_done' }, 400);
  }
  if (incoming.filter((s) => s.isCancelled).length > 1) {
    return c.json({ ok: false, error: 'at most one stage can be marked is_cancelled' }, 400);
  }
  if (incoming.filter((s) => s.isNew).length > 1) {
    return c.json({ ok: false, error: 'at most one stage can be marked is_new' }, 400);
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


// ── Section 16b / Section 25 Phase D — Agent comms primitives ──────────────

/** Activity Panel snapshot: this project's active agent runs (queued |
 *  spawning | running | paused). Card filtering happens client-side; the
 *  panel applies subsequent `agent-run-changed` WS envelopes as deltas. */
app.get('/api/projects/:projectId/agent-runs', (c) => {
  const projectId = c.req.param('projectId') as ULID;
  const project = getProjectById(projectId);
  if (!project) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);
  const rows = listActiveAgentRunsForProject(projectId);
  const shimmed = rows.map((r) => ({
    runId: r.id,
    sessionId: r.ccSessionId,
    agentName: r.podName,
    model: 'opus',
    projectId: r.projectId,
    parentWorkItemId: r.parentWorkItemId,
    dispatcherSessionId: r.dispatcherSessionId,
    wait: false,
    worktreeDir: project.folderPath,
    startedAt: r.queuedAt,
    status: r.status,
    result: r.result ?? '',
    failureReason: r.failureReason,
    failureCause: r.failureCause,
    endedAt: r.completedAt,
  }));
  return c.json({ ok: true, runs: shimmed });
});

/** Cancel an in-flight agent run. Looks up the AgentRun via the active-runs
 *  registry; `run.cancel()` flips the state machine to `cancelled` + kills
 *  the underlying LowLevelSpawn + triggers terminal handlers (which persist
 *  the row + emit the channel envelope). */
app.post('/api/projects/:projectId/agent-runs/:runId/cancel', (c) => {
  const projectId = c.req.param('projectId') as ULID;
  const project = getProjectById(projectId);
  if (!project) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);
  const runId = c.req.param('runId') as ULID;
  const entry = getActiveRunRegistry().get(runId);
  if (!entry) return c.json({ ok: false, error: `unknown run: ${runId}` }, 404);
  if (entry.projectId !== projectId) {
    return c.json({ ok: false, error: `run ${runId} not in project ${projectId}` }, 400);
  }
  entry.run.cancel();
  return c.json({ ok: true, status: 'cancelled' });
});

/** Section 31.7 — statusline-command bridge. CC's `statusLine.command` hook
 *  POSTs here on every status-line refresh (~1×/turn debounced) with the
 *  extracted snapshot. Latest-per-project wins; broadcast immediately to WS
 *  subscribers so the left rail's usage caps update live. Account-wide
 *  rate-limit fields stay correct because they ride every snapshot. */
const latestStatuslineByProject = new Map<string, StatuslineSnapshot>();

app.post('/api/internal/statusline-data', async (c) => {
  let body: Partial<StatuslineSnapshot & { projectId: string }>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'invalid json' }, 400);
  }
  if (!body.projectId || !body.pcSessionId) {
    return c.json({ ok: false, error: 'projectId + pcSessionId required' }, 400);
  }
  const snapshot: StatuslineSnapshot = {
    pcSessionId: body.pcSessionId,
    ccSessionId: body.ccSessionId ?? '',
    receivedAt: Date.now(),
    model: body.model ?? null,
    rateLimits: body.rateLimits ?? { fiveHour: null, sevenDay: null },
    cost: body.cost ?? null,
    contextWindow: body.contextWindow ?? null,
  };
  latestStatuslineByProject.set(body.projectId, snapshot);
  // Section 31.11 — persist every snapshot for the Global Settings Usage tab
  // + future cross-section aggregations. Fire-and-forget; the in-memory map
  // above stays load-bearing for the live rail caps. FK guards against an
  // unknown projectId by tipping the write to a no-op via try/catch.
  try {
    insertStatuslineSnapshot({
      id: newId(),
      projectId: body.projectId as ULID,
      pcSessionId: snapshot.pcSessionId,
      ccSessionId: snapshot.ccSessionId || null,
      receivedAt: snapshot.receivedAt,
      modelId: snapshot.model?.id ?? null,
      modelDisplayName: snapshot.model?.displayName ?? null,
      fiveHourPct: snapshot.rateLimits.fiveHour?.usedPercentage ?? null,
      fiveHourResetsAt: snapshot.rateLimits.fiveHour?.resetsAt ?? null,
      sevenDayPct: snapshot.rateLimits.sevenDay?.usedPercentage ?? null,
      sevenDayResetsAt: snapshot.rateLimits.sevenDay?.resetsAt ?? null,
      totalCostUsd: snapshot.cost?.totalCostUsd ?? null,
      totalDurationMs: snapshot.cost?.totalDurationMs ?? null,
      totalApiDurationMs: snapshot.cost?.totalApiDurationMs ?? null,
      contextCurrentUsage: snapshot.contextWindow?.currentUsage ?? null,
      contextWindowSize: snapshot.contextWindow?.contextWindowSize ?? null,
      contextUsedPercentage: snapshot.contextWindow?.usedPercentage ?? null,
      totalInputTokens: snapshot.contextWindow?.totalInputTokens ?? null,
      totalOutputTokens: snapshot.contextWindow?.totalOutputTokens ?? null,
    });
  } catch (err) {
    // Unknown project / DB write error. Live rail keeps working off the
    // in-memory map; only the historical table misses this row.
    console.warn('[31.11] statusline persist skipped:', (err as Error).message);
  }
  broadcastTo(body.projectId as ULID, { type: 'statusline-snapshot', snapshot });
  return c.json({ ok: true });
});

/** Section 31.11 — usage aggregation. Buckets the latest-cost-per-session
 *  by day / week / month over a window. Used by the Global Settings Usage
 *  tab; client picks the bucket size + window.
 *  - `bucket=day` / `week` / `month`
 *  - `windowDays=7` (default 30, max 365)
 *  Returns `[ { bucket: 'YYYY-MM-DD' (or 'YYYY-Www' / 'YYYY-MM'), costUsd, sessions } ]`
 *  newest bucket first. */
app.get('/api/usage/aggregate', (c) => {
  const bucket = (c.req.query('bucket') ?? 'day').toLowerCase();
  if (bucket !== 'day' && bucket !== 'week' && bucket !== 'month') {
    return c.json({ ok: false, error: "bucket must be day|week|month" }, 400);
  }
  const windowDays = Math.min(365, Math.max(1, Number(c.req.query('windowDays') ?? 30)));
  const sinceMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const rows = listLatestSnapshotPerSession(sinceMs);
  const buckets = new Map<
    string,
    { costUsd: number; sessions: number; inputTokens: number; outputTokens: number }
  >();
  for (const r of rows) {
    // Include sessions that emitted at least one snapshot in-window, even if
    // cost was null. Token counts may be zero on subscription accounts that
    // haven't seen the new columns populated yet.
    const key = formatBucket(new Date(r.receivedAt), bucket);
    const entry =
      buckets.get(key) ?? { costUsd: 0, sessions: 0, inputTokens: 0, outputTokens: 0 };
    entry.costUsd += r.totalCostUsd ?? 0;
    entry.inputTokens += r.totalInputTokens ?? 0;
    entry.outputTokens += r.totalOutputTokens ?? 0;
    entry.sessions += 1;
    buckets.set(key, entry);
  }
  const result = Array.from(buckets.entries())
    .map(([b, v]) => ({
      bucket: b,
      costUsd: v.costUsd,
      sessions: v.sessions,
      inputTokens: v.inputTokens,
      outputTokens: v.outputTokens,
    }))
    .sort((a, b) => (a.bucket < b.bucket ? 1 : a.bucket > b.bucket ? -1 : 0));
  return c.json({ ok: true, bucket, windowDays, rows: result });
});

function formatBucket(d: Date, kind: 'day' | 'week' | 'month'): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  if (kind === 'month') return `${y}-${m}`;
  if (kind === 'day') {
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  // ISO week — Monday-anchored.
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Latest snapshot for a project; null if none received yet. Used for the
 *  initial-fetch path so the rail isn't blank until the next statusline
 *  refresh. Falls back to the persisted table row if the in-memory map is
 *  empty (e.g. after a server restart, before any live snapshot lands). */
app.get('/api/projects/:projectId/statusline', (c) => {
  const projectId = c.req.param('projectId') as ULID;
  const memSnapshot = latestStatuslineByProject.get(projectId);
  if (memSnapshot) return c.json({ ok: true, snapshot: memSnapshot });
  const row = getLatestSnapshotForProject(projectId);
  if (!row) return c.json({ ok: true, snapshot: null });
  // Reconstruct the wire-shape from the persisted columns.
  const snapshot: StatuslineSnapshot = {
    pcSessionId: row.pcSessionId,
    ccSessionId: row.ccSessionId ?? '',
    receivedAt: row.receivedAt,
    model: row.modelId
      ? { id: row.modelId, displayName: row.modelDisplayName ?? row.modelId }
      : null,
    rateLimits: {
      fiveHour:
        row.fiveHourPct != null && row.fiveHourResetsAt
          ? { usedPercentage: row.fiveHourPct, resetsAt: row.fiveHourResetsAt }
          : null,
      sevenDay:
        row.sevenDayPct != null && row.sevenDayResetsAt
          ? { usedPercentage: row.sevenDayPct, resetsAt: row.sevenDayResetsAt }
          : null,
    },
    cost:
      row.totalCostUsd != null
        ? {
            totalCostUsd: row.totalCostUsd,
            totalDurationMs: row.totalDurationMs ?? 0,
            totalApiDurationMs: row.totalApiDurationMs ?? 0,
          }
        : null,
    contextWindow:
      row.contextCurrentUsage != null && row.contextWindowSize != null
        ? {
            currentUsage: row.contextCurrentUsage,
            contextWindowSize: row.contextWindowSize,
            usedPercentage: row.contextUsedPercentage ?? 0,
            totalInputTokens: row.totalInputTokens ?? 0,
            totalOutputTokens: row.totalOutputTokens ?? 0,
          }
        : null,
  };
  return c.json({ ok: true, snapshot });
});

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

// ─── Section 25 / Phase D — agent dispatch + comms routes ────────────────
//
// Routes back the `pc_*` MCP tools: invoke, continue, list-my-runs, ask-
// orchestrator, ask-user, request-approval, answer-pending. Every spawn
// flows through the v2 `AgentRun` wrapper + Session 7 delivery + Session 8
// pause/resume orchestration.

/** `pc_invoke_agent` HTTP surface. Every spawn goes through the `AgentRun`
 *  wrapper. Terminal `agent-completed` / `agent-failed` envelopes flow via
 *  `enqueueAndPush` (durable inbox + best-effort channel push). */
app.post('/api/projects/:projectId/agents/:name/invoke', async (c) => {
  const projectId = c.req.param('projectId') as ULID;
  const project = getProjectById(projectId);
  if (!project) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);

  const agentName = c.req.param('name').trim();
  if (!agentName) return c.json({ ok: false, error: 'agent name required' }, 400);

  const body = await c.req.json<{
    input?: string;
    parentWorkItemId?: ULID;
    workItemId?: ULID;
    parentInvokeDepth?: number;
    dispatcherSessionId?: string;
  }>();

  const input = typeof body.input === 'string' ? body.input : '';
  if (!input.trim()) return c.json({ ok: false, error: 'input required' }, 400);
  const parentWorkItemId =
    typeof body.parentWorkItemId === 'string' ? (body.parentWorkItemId as ULID) : null;
  const workItemId =
    typeof body.workItemId === 'string' && body.workItemId.trim()
      ? (body.workItemId.trim() as ULID)
      : null;
  const dispatcherSessionId =
    typeof body.dispatcherSessionId === 'string' ? body.dispatcherSessionId.trim() : '';
  if (!dispatcherSessionId) {
    return c.json(
      { ok: false, error: 'dispatcherSessionId required (orchestrator must forward PC_SESSION_ID)' },
      400,
    );
  }

  // Depth cap. Same shape as v1.
  const parentInvokeDepth =
    typeof body.parentInvokeDepth === 'number' ? body.parentInvokeDepth : 0;
  const depthCheck = checkInvokeDepth(parentInvokeDepth);
  if (!depthCheck.ok) {
    return c.json({ ok: false, error: depthCheck.error, cause: depthCheck.cause }, 400);
  }

  const result = dispatchFreshAgent(
    {
      projectId,
      worktreeDir: project.folderPath,
      agentName,
      input,
      dispatcherSessionId,
      parentWorkItemId,
      workItemId,
      invokeDepth: depthCheck.childDepth,
      slug: project.slug,
    },
    {
      channelServer,
      broadcast: (env) => broadcastTo(projectId, env),
    },
  );

  if (!result.ok) {
    return c.json({ ok: false, error: result.error, cause: result.cause });
  }

  // 16b.7 — audit row on the parent work item (v1 helper survives unchanged).
  recordAgentInvoke({
    workItemId: parentWorkItemId,
    agentName,
    sessionId: result.ccSessionId,
    runId: result.agentRunId,
    mode: 'async',
    input,
    now: Date.now(),
  });

  // v2 dispatches are always async on the wire (the orchestrator never blocks;
  // the wait:true / sync path was a v1 artifact for nested-agent chains —
  // those can re-add a wait flag later if needed, but v1 + v2 parallel-build
  // doesn't need the surface today). Match the v1 async response shape so the
  // orchestrator's existing handler protocol doesn't need a separate parser.
  return c.json({
    ok: true,
    mode: 'async',
    sessionId: result.ccSessionId,
    runId: result.agentRunId,
    agentName: result.podName,
    startedAt: result.startedAt,
    status: result.initialState,
  });
});

/** `pc_continue_agent` HTTP surface. Ownership check + JSONL-retention guard
 *  + single-active-continuation guard, then spawn through the `AgentRun`
 *  wrapper. Reuses `continueAgent` planning + `dispatchContinueAgent`
 *  orchestration in the agent-run factory. */
app.post('/api/projects/:projectId/agent-runs/:runId/continue', async (c) => {
  const projectId = c.req.param('projectId') as ULID;
  const project = getProjectById(projectId);
  if (!project) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);

  const parentAgentRunId = c.req.param('runId') as ULID;
  const body = await c.req.json<{
    input?: string;
    dispatcherSessionId?: string;
    workItemId?: ULID;
  }>();

  const input = typeof body.input === 'string' ? body.input : '';
  if (!input.trim()) return c.json({ ok: false, error: 'input required' }, 400);
  const dispatcherSessionId =
    typeof body.dispatcherSessionId === 'string' ? body.dispatcherSessionId.trim() : '';
  const continueWorkItemId =
    typeof body.workItemId === 'string' && body.workItemId.trim()
      ? (body.workItemId.trim() as ULID)
      : null;
  if (!dispatcherSessionId) {
    return c.json(
      { ok: false, error: 'dispatcherSessionId required (orchestrator must forward PC_SESSION_ID)' },
      400,
    );
  }

  // Ownership check happens at the agent_runs_v2 level — the factory's
  // continue plan reads the parent row + the dispatcherSessionId field. We
  // re-check here so the 403 happens BEFORE pod materialisation, matching
  // v1's surface. (The plan would still reject internally if we skipped this.)
  const parentRow = getAgentRunRow(parentAgentRunId);
  if (!parentRow) {
    return c.json(
      { ok: false, error: `unknown run: ${parentAgentRunId}`, cause: 'run-not-found' },
      404,
    );
  }
  if (parentRow.projectId !== projectId) {
    return c.json(
      {
        ok: false,
        error: `run ${parentAgentRunId} not in project ${projectId}`,
        cause: 'wrong-project',
      },
      400,
    );
  }
  if (parentRow.dispatcherSessionId !== dispatcherSessionId) {
    return c.json(
      {
        ok: false,
        error: `run ${parentAgentRunId} was dispatched by a different orchestrator session — only the dispatcher can continue it`,
        cause: 'ownership-mismatch',
      },
      403,
    );
  }

  const result = dispatchContinueAgent(
    {
      projectId,
      worktreeDir: project.folderPath,
      parentAgentRunId,
      input,
      dispatcherSessionId,
      workItemId: continueWorkItemId,
      slug: project.slug,
    },
    {
      channelServer,
      broadcast: (env) => broadcastTo(projectId, env),
    },
  );

  if (!result.ok) {
    const statusFor: Record<string, number> = {
      'run-not-found': 404,
      'not-continuable': 409,
      'concurrent-continuation': 409,
      'session-expired': 410,
      'project-missing': 404,
      'unknown-agent': 404,
      'pod-materialisation-failed': 500,
      'scratch-mkdir-failed': 500,
    };
    return c.json(
      { ok: false, error: result.error, cause: result.cause },
      (statusFor[result.cause] ?? 400) as 400,
    );
  }

  // Audit row on the parent work item — continuation reuses the same pattern
  // as v1's continue route.
  recordAgentInvoke({
    workItemId: parentRow.parentWorkItemId,
    agentName: result.podName,
    sessionId: result.ccSessionId,
    runId: result.agentRunId,
    mode: 'async',
    input,
    now: Date.now(),
  });

  return c.json({
    ok: true,
    mode: 'async',
    sessionId: result.ccSessionId,
    runId: result.agentRunId,
    agentName: result.podName,
    startedAt: result.startedAt,
    status: result.initialState,
    continues: parentAgentRunId,
  });
});

/** `pc_list_my_runs` HTTP surface. Reads from the `agent_runs` table. */
app.get('/api/projects/:projectId/agent-runs/by-dispatcher', (c) => {
  const projectId = c.req.param('projectId') as ULID;
  const project = getProjectById(projectId);
  if (!project) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);

  const dispatcherSessionId = (c.req.query('dispatcherSessionId') ?? '').trim();
  if (!dispatcherSessionId) {
    return c.json({ ok: false, error: 'dispatcherSessionId query param required' }, 400);
  }
  const podName = (c.req.query('agentName') ?? '').trim() || undefined;
  const statusRaw = (c.req.query('status') ?? '').trim();
  const VALID_AGENT_RUN_STATUSES: AgentRunStatus[] = [
    'queued',
    'spawning',
    'running',
    'paused',
    'completed',
    'failed',
    'cancelled',
  ];
  const status =
    statusRaw && (VALID_AGENT_RUN_STATUSES as string[]).includes(statusRaw)
      ? (statusRaw as AgentRunStatus)
      : undefined;
  const limitRaw = Number(c.req.query('limit') ?? 20);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.floor(limitRaw))) : 20;

  const rows = listAgentRunsForSession(projectId, dispatcherSessionId, {
    podName,
    status,
    limit,
  });
  const SUMMARY_LEN = 80;
  const summarised = rows.map((r) => ({
    runId: r.id,
    agentName: r.podName,
    status: r.status,
    dispatchedAt: r.queuedAt,
    completedAt: r.completedAt,
    summary:
      (r.input ?? '').length > SUMMARY_LEN
        ? (r.input ?? '').slice(0, SUMMARY_LEN).trimEnd() + '…'
        : (r.input ?? ''),
    continues: r.continues,
  }));
  return c.json({ ok: true, runs: summarised });
});

/** Single pending-ask creation endpoint for `pc_ask_orchestrator` /
 *  `pc_ask_user` / `pc_request_approval`. Routes through `recordExplicitPause`
 *  which flips the AgentRun in-memory state to paused + persists the
 *  `pending_asks` row + delivers via the hybrid transport. */
app.post('/api/projects/:projectId/agent-pending-asks', async (c) => {
  const projectId = c.req.param('projectId') as ULID;
  const project = getProjectById(projectId);
  if (!project) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);

  const body = await c.req.json<{
    agentRunId?: string;
    kind?: PendingAskKind;
    promptBody?: string;
    context?: string;
    options?: PendingAskOption[];
  }>();

  const agentRunId =
    typeof body.agentRunId === 'string' ? (body.agentRunId.trim() as ULID) : ('' as ULID);
  if (!agentRunId) return c.json({ ok: false, error: 'agentRunId required' }, 400);

  const kind = body.kind;
  if (kind !== 'orchestrator' && kind !== 'user' && kind !== 'approval') {
    return c.json(
      { ok: false, error: 'kind must be orchestrator | user | approval' },
      400,
    );
  }

  const promptBody = typeof body.promptBody === 'string' ? body.promptBody : '';
  if (!promptBody.trim()) return c.json({ ok: false, error: 'promptBody required' }, 400);

  if (kind === 'approval') {
    if (!Array.isArray(body.options) || body.options.length === 0) {
      return c.json(
        { ok: false, error: 'options required (non-empty array) for kind=approval' },
        400,
      );
    }
  }

  const result = recordExplicitPause(
    {
      agentRunId,
      kind,
      promptBody,
      context: typeof body.context === 'string' ? body.context : null,
      options: Array.isArray(body.options) ? body.options : null,
    },
    { channelServer, slug: project.slug },
  );

  if (!result.ok) {
    const statusFor: Record<string, number> = {
      'unknown-run': 404,
      'wrong-state': 409,
    };
    return c.json(
      { ok: false, error: result.error, cause: result.cause },
      (statusFor[result.cause] ?? 400) as 400,
    );
  }

  return c.json({
    ok: true,
    pendingAskId: result.pendingAskId,
    status: 'waiting',
    eventDelivered: result.eventDelivered,
  });
});

/** `pc_answer_pending` HTTP surface. `answerPendingAsk` atomically flips the
 *  row to answered, persists the spawning transition + pod-revision-at-resume,
 *  and drives the AgentRun's `_resumeWithAnswer`. */
app.post(
  '/api/projects/:projectId/agent-pending-asks/:askId/answer',
  async (c) => {
    const projectId = c.req.param('projectId') as ULID;
    const project = getProjectById(projectId);
    if (!project) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);

    const pendingAskId = c.req.param('askId') as ULID;
    const body = await c.req.json<{
      answer?: string;
      answeredBy?: 'orchestrator' | 'user';
    }>();

    const answer = typeof body.answer === 'string' ? body.answer : '';
    if (!answer) return c.json({ ok: false, error: 'answer required' }, 400);
    const answeredBy = body.answeredBy;
    if (answeredBy !== 'orchestrator' && answeredBy !== 'user') {
      return c.json({ ok: false, error: 'answeredBy must be orchestrator | user' }, 400);
    }

    const result = answerPendingAsk(
      { pendingAskId, answer, answeredBy },
      { channelServer, slug: project.slug },
    );

    if (!result.ok) {
      const statusFor: Record<string, number> = {
        'unknown-pending-ask': 404,
        'already-answered': 409,
        cancelled: 409,
        'unknown-run': 404,
        'wrong-state': 409,
        'resume-failed': 500,
      };
      return c.json(
        { ok: false, error: result.error, cause: result.cause },
        (statusFor[result.cause] ?? 400) as 400,
      );
    }

    return c.json({
      ok: true,
      agentRunId: result.agentRunId,
      ccSessionId: result.ccSessionId,
      podRevisionDrifted: result.podRevisionDrifted,
      podRevisionAtDispatch: result.podRevisionAtDispatch,
      podRevisionAtResume: result.podRevisionAtResume,
    });
  },
);

/** v2 pending-ask cancel surface. Lets the orchestrator (or any caller) drop
 *  a pending pause without resuming the agent. The agent gets cancelled
 *  through the registry's `run.cancel()` path. */
app.post(
  '/api/projects/:projectId/agent-pending-asks/:askId/cancel',
  async (c) => {
    const projectId = c.req.param('projectId') as ULID;
    const project = getProjectById(projectId);
    if (!project) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);

    const pendingAskId = c.req.param('askId') as ULID;
    const result = cancelPendingAsk({ pendingAskId }, {});
    if (!result.ok) {
      const statusFor: Record<string, number> = {
        'unknown-pending-ask': 404,
        'already-terminal': 409,
      };
      return c.json(
        { ok: false, error: result.error, cause: result.cause },
        (statusFor[result.cause] ?? 400) as 400,
      );
    }
    return c.json({ ok: true, agentRunId: result.agentRunId });
  },
);

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

  const detachSubscriber = wsHub.subscribe(projectId, ws);

  // Replay and session metadata must not block on Claude startup. Ensure the
  // durable PC session row exists, send the checkpoint surfaces synchronously,
  // then start the transient PTY in the background.
  const activeSession = runtime.ensureActiveSession();

  // P14: tag direct-to-client sends with projectId, same as broadcastTo does
  // for fan-out paths. Keeps the envelope contract uniform.
  ws.send(JSON.stringify({ projectId, type: 'session-changed', session: activeSession }));
  const liveSession = runtime.ptySession();
  if (liveSession) {
    attachPtyHandlers(projectId, runtime, liveSession);
    ws.send(JSON.stringify({ projectId, type: 'state', state: liveSession.getState() }));
  }
  ws.send(JSON.stringify({ projectId, ...runtimeSnapshotPayload(projectId, runtime) }));

  // Section 23 — replay the active session's normalized event log so a
  // reloaded tab doesn't lose its chat panel. Sources from PC-owned
  // jsonl-events.jsonl (canonical post-23) with a fallback to the legacy
  // events.jsonl for pre-23 sessions. Past sessions render via
  // GET /api/projects/:id/sessions/:sessionId/events, not the WS replay.
  if (activeSession) {
    const replay = loadSessionReplay(runtime, activeSession.id);
    ws.send(JSON.stringify({
      projectId,
      type: 'session-replay',
      sessionId: replay.sessionId,
      highWaterSeq: replay.highWaterSeq,
      events: replay.events,
    }));
    ws.send(JSON.stringify({ projectId, ...sendQueueSnapshotPayload(activeSession.id) }));
  }
  startOrchestratorPtyInBackground(projectId, runtime);

  ws.on('message', async (raw) => {
    let msg: {
      type?: string;
      text?: string;
      data?: unknown;
      clientMessageId?: unknown;
      cols?: number;
      rows?: number;
      nonce?: unknown;
      sentAt?: unknown;
    };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const sendAck = (
      clientMessageId: unknown,
      ack: {
        ok: boolean;
        status: SendAckStatus;
        error?: string;
        queueItem?: PublicSendQueueItem;
      },
    ) => {
      if (typeof clientMessageId !== 'string' || !clientMessageId) return;
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ projectId, type: 'send-ack', clientMessageId, ...ack }));
    };
    switch (msg.type) {
      case 'client-ping':
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            projectId,
            type: 'server-pong',
            nonce: typeof msg.nonce === 'string' ? msg.nonce : undefined,
            sentAt: typeof msg.sentAt === 'number' ? msg.sentAt : undefined,
            serverTime: Date.now(),
          }));
        }
        break;
      case 'send':
        if (typeof msg.text !== 'string') {
          sendAck(msg.clientMessageId, {
            ok: false,
            status: 'invalid-message',
            error: 'send.text must be a string',
          });
          break;
        }
        const clientMessageId =
          typeof msg.clientMessageId === 'string' && msg.clientMessageId
            ? msg.clientMessageId
            : newId();
        let active = getActiveOrchestratorSession(projectId);
        if (!active) {
          active = runtime.ensureActiveSession();
          broadcastTo(projectId, { type: 'session-changed', session: active });
          broadcastSessionReplay(projectId, loadSessionReplay(runtime, active.id));
          broadcastSendQueueSnapshot(projectId, active.id);
        }
        let live = runtime.ptySession();
        if (!live) {
          try {
            live = ensureOrchestratorPty(projectId, runtime);
          } catch (err) {
            sendAck(msg.clientMessageId, {
              ok: false,
              status: 'no-session',
              error: err instanceof Error
                ? err.message
                : 'No live orchestrator session is attached',
            });
            break;
          }
        }
        const state = live.getState();
        const hasBacklog = hasOpenOrchestratorSendsForSession(active.id);
        if (state !== 'ready' || hasBacklog) {
          try {
            const row = enqueueOrchestratorSend({
              projectId,
              sessionId: active.id,
              clientMessageId,
              text: msg.text,
              status: queuedStatusForState(state, hasBacklog),
            });
            sendAck(msg.clientMessageId, {
              ok: true,
              status: 'queued',
              queueItem: publicSendQueueItem(row),
            });
            broadcastSendQueueSnapshot(projectId, active.id);
            if (state === 'ready') {
              deliverNextQueuedPrompt(projectId, runtime, broadcastSendQueueSnapshot);
            }
          } catch (err) {
            sendAck(msg.clientMessageId, {
              ok: false,
              status: 'error',
              error: err instanceof Error ? err.message : 'Failed to queue prompt',
            });
          }
          break;
        }
        try {
          const result = await live.send(msg.text);
          if (result !== 'ok') {
            sendAck(msg.clientMessageId, {
              ok: false,
              status: 'error',
              error: `send returned ${result}`,
            });
            break;
          }
          const row = recordDeliveredOrchestratorSend({
            projectId,
            sessionId: active.id,
            clientMessageId,
            text: msg.text,
          });
          sendAck(msg.clientMessageId, {
            ok: true,
            status: 'received',
            queueItem: publicSendQueueItem(row),
          });
          broadcastSendQueueSnapshot(projectId, active.id);
        } catch (err) {
          sendAck(msg.clientMessageId, {
            ok: false,
            status: 'error',
            error: err instanceof Error ? err.message : 'Failed to send prompt',
          });
        }
        break;
      case 'interrupt':
        runtime.ptySession()?.interrupt();
        break;
      case 'terminal-input': {
        const result = forwardTerminalInput(runtime, msg.data);
        if (!result.ok && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            projectId,
            type: 'terminal-input-ack',
            ok: false,
            status: result.status,
            error: result.error,
          }));
        }
        break;
      }
      case 'resize':
        {
          if (typeof msg.cols === 'number' && typeof msg.rows === 'number') {
            runtime.resizeOrchestrator(msg.cols, msg.rows);
          }
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
    detachSubscriber();
  });
});

process.on('SIGINT', () => {
  console.log('[pc] SIGINT — shutting down project runtimes + channel server');
  projectRegistry.shutdownAll();
  channelServer.shutdown();
  process.exit(0);
});
