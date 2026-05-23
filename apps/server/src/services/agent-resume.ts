// Section 16b.2b — Resume primitive for paused agents.
//
// Called from the `pc_answer_pending` HTTP path. Atomically transitions the
// pending-ask row from `waiting → answered`, materialises the paused agent's
// pod, re-spawns claude.exe with `--agent <name> --resume <sessionId>`, and
// writes the answer as the next user message once the boot banner clears.
//
// 16b.4.2 — when an AgentRunManager singleton is tracking the paused run
// (i.e. it was spawned via `pc_invoke_agent`), the freshly-spawned resumed
// session is handed back to the manager via `attachResumedSession` so the
// run's lifecycle (status, idle timer, jsonl-event tracking, completion
// Promise) continues across the pause boundary. When no run is tracked
// (orchestrator-side resume, ad-hoc resumes from tests), the resume path
// stands alone — same shape as pre-16b.4.
//
// Returns immediately after the answer is sent — does NOT block on the
// agent's subsequent turn. The next pause / completion fires its own
// channel event (16b.3+) and surfaces to the orchestrator separately.
//
// JSONL-replay defence-in-depth (skip already-answered `<channel>` events
// at source) is a follow-up; for now the atomic `waiting → answered`
// transition in markPendingAskAnswered + the orchestrator's pod-prompt
// status guard cover the safety case.

import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  getPendingAsk,
  getProjectById,
  markPendingAskAnswered,
} from '@pc/db';
import { encodeCwdForClaude, PtySession, type PtySessionOptions, type SessionState } from '@pc/runtime';
import type { PcAnswerPendingResult, ULID } from '@pc/domain';
import { preparePodSpawn, type PodSpawnPrep } from './pod-spawn.ts';
import {
  getAgentRunManager,
  type AgentRunManager,
  type AgentSessionLike,
} from './agent-run-manager.ts';

export interface RespawnAgentInput {
  pendingAskId: ULID;
  answer: string;
  answeredBy: 'orchestrator' | 'user';
  now: number;
}

/** Sub-protocol the resume primitive depends on: a PtySession-shaped child
 *  with `send`, `kill`, `getState`, and the lifecycle events. Real
 *  `PtySession` satisfies this; tests pass a fake. The shape matches
 *  `AgentSessionLike` so the resumed session can be handed straight to the
 *  run manager's `attachResumedSession` without a cast. */
export interface ResumeSessionLike extends EventEmitter {
  send(text: string): void;
  kill(): void;
  getState(): SessionState;
}

export interface RespawnAgentDeps {
  /** Factory for the underlying session. Defaults to `new PtySession(opts)`. */
  createSession?: (opts: PtySessionOptions) => ResumeSessionLike;
  /** Where per-session scratch dirs land. Defaults to `data/projects/<projectId>/sessions/<sessionId>/`.
   *  Override only for tests. */
  sessionDataDirFor?: (projectId: ULID, sessionId: string) => string;
  /** Resolve `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. Override only
   *  for tests. */
  resolveJsonlPath?: (folderPath: string, sessionId: string) => string;
  /** Timeout (ms) for the spawned session to reach `ready` before we bail.
   *  Bumped to 60s after V-4 surfaced a false-negative at ~32s on resume —
   *  the resume actually completed end-to-end 2s after the 30s timeout
   *  fired, but the route had already returned `resume-failed`. Resume's
   *  cold-path is slower than fresh spawn (--resume reads + replays JSONL
   *  before banner-render on Windows). */
  readyTimeoutMs?: number;
  /** AgentRunManager to consult for an active run keyed by the paused
   *  session-id. Defaults to the process-wide singleton. Tests pass a fresh
   *  manager (with stubbed deps) to keep behaviour deterministic. */
  agentRunManager?: AgentRunManager;
}

const DEFAULT_READY_TIMEOUT_MS = 60_000;

export function defaultSessionDataDir(
  dataRoot: string,
  projectId: ULID,
  sessionId: string,
): string {
  return resolve(dataRoot, 'projects', projectId, 'sessions', sessionId);
}

export function defaultJsonlPath(folderPath: string, sessionId: string): string {
  return resolve(
    homedir(),
    '.claude',
    'projects',
    encodeCwdForClaude(folderPath),
    `${sessionId}.jsonl`,
  );
}

function countJsonlLines(filePath: string): number {
  try {
    if (!existsSync(filePath)) return 0;
    return readFileSync(filePath, 'utf-8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** Re-spawn a paused agent with the answer threaded in as the next user
 *  message. Returns the `pc_answer_pending` MCP result shape directly. */
export async function respawnAgentWithAnswer(
  input: RespawnAgentInput,
  deps: RespawnAgentDeps = {},
): Promise<PcAnswerPendingResult> {
  const createSession = deps.createSession ?? defaultCreateSession;
  const sessionDataDirFor =
    deps.sessionDataDirFor ??
    ((projectId, sessionId) =>
      defaultSessionDataDir(process.env.PC_DATA_DIR ?? 'data', projectId, sessionId));
  const resolveJsonlPath = deps.resolveJsonlPath ?? defaultJsonlPath;
  const readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  const ask = getPendingAsk(input.pendingAskId);
  if (!ask) {
    return {
      ok: false,
      error: `no pending-ask with id ${input.pendingAskId}`,
      cause: 'unknown-pending-ask',
    };
  }
  if (ask.status === 'answered') {
    return {
      ok: false,
      error: `pending-ask ${input.pendingAskId} already answered`,
      cause: 'already-answered',
    };
  }
  if (ask.status === 'cancelled') {
    return {
      ok: false,
      error: `pending-ask ${input.pendingAskId} was cancelled`,
      cause: 'cancelled',
    };
  }

  // Atomic flip — replay-safe against double-fire from JSONL replay.
  const flipped = markPendingAskAnswered({
    id: ask.id,
    answer: input.answer,
    answeredBy: input.answeredBy,
    now: input.now,
  });
  if (!flipped) {
    // Lost the race — another caller already answered. Treat as
    // already-answered (the answer they wrote wins).
    return {
      ok: false,
      error: `pending-ask ${input.pendingAskId} was answered concurrently`,
      cause: 'already-answered',
    };
  }

  const project = getProjectById(ask.projectId);
  if (!project) {
    return {
      ok: false,
      error: `project ${ask.projectId} not found for pending-ask ${ask.id}`,
      cause: 'resume-failed',
    };
  }

  const sessionDir = sessionDataDirFor(project.id as ULID, ask.sessionId);
  try {
    mkdirSync(sessionDir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      error: `mkdir session dir failed: ${(err as Error).message}`,
      cause: 'resume-failed',
    };
  }

  let podPrep: PodSpawnPrep | null = null;
  try {
    podPrep = preparePodSpawn({
      agentName: ask.agentName,
      worktreeDir: project.folderPath,
      scratchDir: sessionDir,
      filterMcpToReferencedTools: true,
    });
  } catch (err) {
    return {
      ok: false,
      error: `pod materialisation failed for "${ask.agentName}": ${(err as Error).message}`,
      cause: 'resume-failed',
    };
  }

  const jsonlPath = resolveJsonlPath(project.folderPath, ask.sessionId);
  const jsonlStartLine = countJsonlLines(jsonlPath);

  // Section 18.5a — re-establish PC_AGENT_* env vars on resume so the
  // resumed agent can pause again (its pc-rig MCP child reads them on
  // every pause emit). When the AgentRunManager is tracking this run, the
  // dispatcherSessionId lives on the record; otherwise the only path to
  // pause-after-resume is broken (no orchestrator to route back to), so
  // fall through with the field empty and let the agent's pc-rig surface
  // the missing-env error if it tries.
  const manager = deps.agentRunManager ?? getAgentRunManager();
  const trackedRunId = manager.findRunIdBySession(ask.sessionId);
  const trackedRun = trackedRunId ? manager.get(trackedRunId) : null;
  const resumedExtraEnv: Record<string, string> = {
    ...(podPrep?.extraEnv ?? {}),
    PC_AGENT_NAME: ask.agentName,
    PC_AGENT_SESSION_ID: ask.sessionId,
    PC_PROJECT_ID: ask.projectId,
    ...(ask.runId ? { PC_AGENT_RUN_ID: ask.runId } : {}),
    ...(ask.parentWorkItemId ? { PC_AGENT_PARENT_WORK_ITEM_ID: ask.parentWorkItemId } : {}),
    ...(trackedRun?.dispatcherSessionId
      ? { PC_DISPATCHER_SESSION_ID: trackedRun.dispatcherSessionId }
      : {}),
  };

  const sessionOpts: PtySessionOptions = {
    workspaceDir: project.folderPath,
    stopMarkerPath: resolve(sessionDir, 'stop-markers.txt'),
    eventsPath: resolve(sessionDir, 'events.jsonl'),
    transcriptPath: resolve(sessionDir, 'transcript.log'),
    claudeSessionId: ask.sessionId,
    resume: true,
    extraEnv: resumedExtraEnv,
    jsonlPath,
    // `--resume` reloads the prior conversation from the same JSONL. The
    // runtime tailer must start at EOF so historical turn-ends don't re-enter
    // AgentRunManager after the pending ask has already been marked answered.
    jsonlStartLine,
    agentName: ask.agentName,
    mcpConfigPath: podPrep?.mcpConfigPath,
    loadDevChannels: false,
  };

  let session: ResumeSessionLike;
  try {
    session = createSession(sessionOpts);
  } catch (err) {
    podPrep?.cleanup();
    return {
      ok: false,
      error: `pty spawn failed: ${(err as Error).message}`,
      cause: 'resume-failed',
    };
  }

  // Cleanup the materialised pod when the session exits — same pattern as
  // project-runtime's orchestrator path.
  session.on('exit', () => {
    try {
      podPrep?.cleanup();
    } catch {
      /* best-effort */
    }
  });

  // 16b.4.2 — when the paused run is tracked by the AgentRunManager (i.e.
  // it was spawned via `pc_invoke_agent`), hand the resumed session back to
  // the manager so the existing run record continues to track lifecycle
  // across the pause boundary (status flip, idle timer, jsonl-event, exit).
  // When no run is tracked (orchestrator-side resume, ad-hoc resume in
  // tests), the resume stands alone — same shape as pre-16b.4.
  // (manager + trackedRunId resolved earlier so resumedExtraEnv could read
  // the run record's dispatcherSessionId.)
  if (trackedRunId) {
    manager.attachResumedSession(trackedRunId, session as AgentSessionLike);
  }

  const sendResult = await waitReadyAndSend(session, input.answer, readyTimeoutMs);
  if (!sendResult.ok) {
    return {
      ok: false,
      error: sendResult.error ?? 'resume failed',
      cause: 'resume-failed',
    };
  }

  return {
    ok: true,
    sessionId: ask.sessionId,
    status: 'resuming',
  };
}

interface WaitReadyResult {
  ok: boolean;
  error?: string;
}

/** Resolve once the session reaches `ready` and the answer has been sent.
 *  Bails on early `exit` or readyTimeout. Never throws. */
function waitReadyAndSend(
  session: ResumeSessionLike,
  answer: string,
  readyTimeoutMs: number,
): Promise<WaitReadyResult> {
  return new Promise((res) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        session.kill();
      } catch {
        /* best-effort */
      }
      res({ ok: false, error: `session did not reach ready within ${readyTimeoutMs}ms` });
    }, readyTimeoutMs);

    session.on('state', (state) => {
      if (settled) return;
      if (state === 'ready') {
        settled = true;
        clearTimeout(timer);
        try {
          session.send(answer);
          res({ ok: true });
        } catch (err) {
          res({ ok: false, error: `send answer failed: ${(err as Error).message}` });
        }
      } else if (state === 'exited') {
        settled = true;
        clearTimeout(timer);
        res({ ok: false, error: 'session exited before reaching ready' });
      }
    });

    session.on('exit', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res({ ok: false, error: 'session exited before reaching ready' });
    });
  });
}

function defaultCreateSession(opts: PtySessionOptions): ResumeSessionLike {
  return new PtySession(opts) as unknown as ResumeSessionLike;
}
