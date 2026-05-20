// Section 16b.2b — Resume primitive for paused agents.
//
// Called from the `pc_answer_pending` HTTP path. Atomically transitions the
// pending-ask row from `waiting → answered`, materialises the paused agent's
// pod, re-spawns claude.exe with `--agent <name> --resume <sessionId>`, and
// writes the answer as the next user message once the boot banner clears.
//
// Returns immediately after the answer is sent — does NOT block on the
// agent's subsequent turn. The next pause / completion fires its own
// channel event (16b.3+) and surfaces to the orchestrator separately.
//
// JSONL-replay defence-in-depth (skip already-answered `<channel>` events
// at source) is a follow-up; for now the atomic `waiting → answered`
// transition in markPendingAskAnswered + the orchestrator's pod-prompt
// status guard cover the safety case.

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  getPendingAsk,
  getProjectById,
  markPendingAskAnswered,
} from '@pc/db';
import { encodeCwdForClaude, PtySession, type PtySessionOptions } from '@pc/runtime';
import type { PcAnswerPendingResult, ULID } from '@pc/domain';
import { preparePodSpawn, type PodSpawnPrep } from './pod-spawn.ts';

export interface RespawnAgentInput {
  pendingAskId: ULID;
  answer: string;
  answeredBy: 'orchestrator' | 'user';
  now: number;
}

/** Sub-protocol the resume primitive depends on: a PtySession-shaped child
 *  with `send`, `kill`, and the lifecycle events. Real `PtySession`
 *  satisfies this; tests pass a fake. */
export interface ResumeSessionLike {
  send(text: string): void;
  kill(): void;
  on(event: 'state', listener: (state: 'spawning' | 'ready' | 'thinking' | 'exited') => void): this;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
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
   *  Defaults to 30s — banner boot is normally <2s, but cold-start over a
   *  slow disk has run ~10s. */
  readyTimeoutMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;

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
    });
  } catch (err) {
    return {
      ok: false,
      error: `pod materialisation failed for "${ask.agentName}": ${(err as Error).message}`,
      cause: 'resume-failed',
    };
  }

  const jsonlPath = resolveJsonlPath(project.folderPath, ask.sessionId);

  const sessionOpts: PtySessionOptions = {
    workspaceDir: project.folderPath,
    stopMarkerPath: resolve(sessionDir, 'stop-markers.txt'),
    eventsPath: resolve(sessionDir, 'events.jsonl'),
    transcriptPath: resolve(sessionDir, 'transcript.log'),
    claudeSessionId: ask.sessionId,
    resume: true,
    extraEnv: podPrep?.extraEnv ?? {},
    jsonlPath,
    jsonlStartLine: 0, // Resume tails from the top; caller-side dedup is the orchestrator's job.
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
