// Section 4d — Independent subagent execution
//
// Spawns a one-shot claude.exe helper for a workflow subagent node and
// reports done-ness via Stop hook + JSONL tailer. Replaces the pre-4d
// channel-message-the-orchestrator path: the workflow runtime now owns the
// dispatch lifecycle directly.
//
// Pure module: no workflow-runtime imports. The default session factory uses
// the real PtySession; tests inject a fake that emits the same events.
//
// Lifecycle:
//   spawn → banner-ready → send initialInput → wait for jsonl-turn-end
//   Side-channels: pc_complete_node / pc_node_failed tool calls captured from
//   the JSONL stream; idle + wall-clock timers from D47.

import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { PtySession, type PtySessionOptions, type SessionState } from './pty-session.ts';
import type { JsonlEvent } from './jsonl-tailer.ts';

/** D47 failure modes for a dispatch. */
export type SubagentSpawnFailureCause =
  | 'spawn-error'
  | 'idle-timeout'
  | 'wall-clock-timeout'
  | 'empty-turn'
  | 'mcp-tool-error'
  | 'killed';

export interface SubagentSpawnRequest {
  /** Agent name → `--agent <name>`. claude.exe reads frontmatter (tools,
   *  model, prompt) from `<worktree>/.claude/agents/<name>.md`. */
  agentName: string;
  /** Worktree path. cwd for the spawned helper. */
  worktreeDir: string;
  /** Initial input sent after the helper reaches banner-ready. The dispatch
   *  envelope built by the workflow runtime (4d.2 owns the shape). */
  initialInput: string;
  /** Per-dispatch session data dir. Spawner writes stop-markers, events.jsonl,
   *  transcript.log inside. Caller mints + creates the dir. */
  sessionDataDir: string;
  /** PC_SESSION_ID env var. The Stop / event-capture / ask-intercept hooks
   *  route their writes back into `sessionDataDir/sessions/<pcSessionId>/…`. */
  pcSessionId: string;
  /** Optional override of the default `--model opus`. Agent file's declared
   *  model usually wins via claude.exe's frontmatter parse; this is the
   *  CLI-level override caller passes when it wants to force a model. */
  model?: string;
  /** D47 idle cutoff. Resets on each JSONL event. Default 300_000 (5 min). */
  idleTimeoutMs?: number;
  /** D47 wall-clock fail-safe. One-shot from spawn. Default 7_200_000 (2 h). */
  wallClockTimeoutMs?: number;
  /** Override the claude.exe path. */
  claudeExe?: string;
  /** Extra env vars merged on top of PC_SESSION_ID. */
  extraEnv?: Record<string, string>;
  /** JSONL paths claimed by prior or sibling dispatches in the same worktree.
   *  Threads through to PtySession so the discovery loop ignores them. */
  excludeJsonlPaths?: readonly string[];
}

export interface SubagentSpawnSuccess {
  kind: 'success';
  /** Concatenated text blocks from the final assistant message. May be empty
   *  if the helper closed via pc_complete_node without a text reply. */
  lastAssistantText: string;
  /** Structured payload passed to pc_complete_node, if the helper called it.
   *  4d.2 logic decides whether to use this in place of lastAssistantText. */
  pcCompletePayload: unknown | null;
  /** Absolute path to the transcript file on disk. */
  transcriptPath: string;
  /** Absolute path to the JSONL file claude.exe wrote into. Null if
   *  discovery never resolved (rare — usually a spawn-error). */
  jsonlPath: string | null;
}

export interface SubagentSpawnFailure {
  kind: 'failure';
  cause: SubagentSpawnFailureCause;
  message: string;
  /** Transcript path is always known (spawner creates the dir). */
  transcriptPath: string;
  /** JSONL path if discovery resolved before failure; null otherwise. */
  jsonlPath: string | null;
  /** Best-effort partial output captured before failure. */
  partialAssistantText: string;
}

export type SubagentSpawnResult = SubagentSpawnSuccess | SubagentSpawnFailure;

export interface SubagentSpawnHandle {
  /** Resolves once on success or failure. Never rejects — failure surfaces
   *  via `result.kind === 'failure'`. */
  done: Promise<SubagentSpawnResult>;
  /** Force-kill the dispatch. No-op if already resolved. */
  kill(reason?: string): void;
  /** Transcript path on disk. Known synchronously. */
  transcriptPath(): string;
  /** JSONL path once discovery resolved; null until then. */
  jsonlPath(): string | null;
}

/** Minimal session shape the spawner depends on. Real PtySession satisfies
 *  this via its EventEmitter base. Tests pass a fake. */
export interface SubagentSessionLike extends EventEmitter {
  send(text: string): void;
  kill(): void;
  getState(): SessionState;
}

export interface SubagentSpawnerDeps {
  /** Factory for the underlying session. Defaults to `new PtySession(opts)`. */
  createSession?: (opts: PtySessionOptions) => SubagentSessionLike;
  /** Override `setTimeout` for deterministic tests. Handle type is opaque —
   *  spawner only passes it back to `clearTimeout`. */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  /** Override `clearTimeout` for deterministic tests. */
  clearTimeout?: (handle: unknown) => void;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const DEFAULT_WALL_CLOCK_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 h

/** MCP tool names emitted in JSONL when a helper calls them. The MCP server
 *  exposes them under namespace `pc-rig`; tool names are prefixed accordingly. */
const PC_COMPLETE_NODE_TOOL = 'mcp__pc-rig__pc_complete_node';
const PC_NODE_FAILED_TOOL = 'mcp__pc-rig__pc_node_failed';

/** Spawn a helper for one workflow subagent node and return a handle that
 *  resolves once the helper completes a turn or fails per D47.
 *
 *  Note: this function never throws. Construction errors land in `done` as
 *  `failure: 'spawn-error'`. */
export function spawnSubagent(
  req: SubagentSpawnRequest,
  deps: SubagentSpawnerDeps = {},
): SubagentSpawnHandle {
  const createSession = deps.createSession ?? defaultCreateSession;
  const setTimeoutImpl: (cb: () => void, ms: number) => unknown =
    deps.setTimeout ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
  const clearTimeoutImpl: (handle: unknown) => void =
    deps.clearTimeout ?? ((h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>));

  const idleTimeoutMs = req.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const wallClockTimeoutMs = req.wallClockTimeoutMs ?? DEFAULT_WALL_CLOCK_TIMEOUT_MS;

  const transcriptPath = resolve(req.sessionDataDir, 'transcript.log');
  const stopMarkerPath = resolve(req.sessionDataDir, 'stop-markers.txt');
  const eventsPath = resolve(req.sessionDataDir, 'events.jsonl');

  let resolvedJsonlPath: string | null = null;
  let lastAssistantText = '';
  let pcCompletePayload: unknown | null = null;
  let pcNodeFailedReason: string | null = null;
  let resolved = false;
  let initialInputSent = false;
  let session: SubagentSessionLike | null = null;
  let idleTimer: unknown = null;
  let wallClockTimer: unknown = null;

  let resolveDone!: (result: SubagentSpawnResult) => void;
  const done = new Promise<SubagentSpawnResult>((res) => {
    resolveDone = res;
  });

  const finalize = (result: SubagentSpawnResult): void => {
    if (resolved) return;
    resolved = true;
    if (idleTimer) clearTimeoutImpl(idleTimer);
    if (wallClockTimer) clearTimeoutImpl(wallClockTimer);
    idleTimer = null;
    wallClockTimer = null;
    try {
      session?.kill();
    } catch {
      /* best-effort */
    }
    resolveDone(result);
  };

  const fail = (cause: SubagentSpawnFailureCause, message: string): void => {
    finalize({
      kind: 'failure',
      cause,
      message,
      transcriptPath,
      jsonlPath: resolvedJsonlPath,
      partialAssistantText: lastAssistantText,
    });
  };

  const succeedFromTurnEnd = (turnEndText: string): void => {
    lastAssistantText = turnEndText;
    if (pcNodeFailedReason !== null) {
      // pc_node_failed wins even when the helper produced text — the helper
      // explicitly signaled failure.
      finalize({
        kind: 'failure',
        cause: 'mcp-tool-error',
        message: `helper called pc_node_failed: ${pcNodeFailedReason}`,
        transcriptPath,
        jsonlPath: resolvedJsonlPath,
        partialAssistantText: lastAssistantText,
      });
      return;
    }
    if (turnEndText.trim() === '' && pcCompletePayload === null) {
      fail('empty-turn', 'helper produced no output before turn end');
      return;
    }
    finalize({
      kind: 'success',
      lastAssistantText,
      pcCompletePayload,
      transcriptPath,
      jsonlPath: resolvedJsonlPath,
    });
  };

  const resetIdleTimer = (): void => {
    if (resolved) return;
    if (idleTimer) clearTimeoutImpl(idleTimer);
    idleTimer = setTimeoutImpl(() => {
      fail(
        'idle-timeout',
        `helper idle for ${Math.round(idleTimeoutMs / 1000)}s — likely hung`,
      );
    }, idleTimeoutMs);
  };

  // Construct the session. PtySession's constructor performs the pty.spawn
  // synchronously, so a missing claude.exe or other spawn error throws here.
  const sessionOpts: PtySessionOptions = {
    workspaceDir: req.worktreeDir,
    claudeExe: req.claudeExe,
    stopMarkerPath,
    eventsPath,
    transcriptPath,
    extraEnv: { ...(req.extraEnv ?? {}), PC_SESSION_ID: req.pcSessionId },
    excludeJsonlPaths: req.excludeJsonlPaths,
    agentName: req.agentName,
    model: req.model,
    loadDevChannels: false,
  };

  try {
    session = createSession(sessionOpts);
  } catch (err) {
    // Defer so the caller can wire `.done.then(...)` before the rejection
    // fires. Without this, `.then()` registered after spawnSubagent returns
    // would still observe the failure (microtask ordering), but defer is
    // explicit + matches the async-everywhere convention.
    queueMicrotask(() => fail('spawn-error', errorMessage(err)));
    return {
      done,
      kill: (reason) => {
        if (resolved) return;
        fail('killed', reason ?? 'killed by runtime');
      },
      transcriptPath: () => transcriptPath,
      jsonlPath: () => null,
    };
  }

  wallClockTimer = setTimeoutImpl(() => {
    fail(
      'wall-clock-timeout',
      `helper exceeded wall-clock cap of ${Math.round(wallClockTimeoutMs / 1000)}s`,
    );
  }, wallClockTimeoutMs);

  resetIdleTimer();

  session.on('state', (state: SessionState) => {
    if (state === 'ready' && !initialInputSent && session) {
      initialInputSent = true;
      try {
        session.send(req.initialInput);
      } catch (err) {
        fail('spawn-error', `send initialInput failed: ${errorMessage(err)}`);
      }
    }
  });

  session.on('jsonl-path-resolved', (path: string) => {
    resolvedJsonlPath = path;
  });

  session.on('jsonl-event', (ev: JsonlEvent) => {
    resetIdleTimer();
    if (ev.kind === 'jsonl-tool-call') {
      if (ev.name === PC_COMPLETE_NODE_TOOL) {
        const input = ev.input as Record<string, unknown> | null;
        if (input && 'output' in input) {
          pcCompletePayload = (input as { output: unknown }).output;
        } else {
          // Tool was called with no output field — record an empty payload
          // so callers can still distinguish "helper called the tool" from
          // "helper didn't call the tool."
          pcCompletePayload = null;
        }
      } else if (ev.name === PC_NODE_FAILED_TOOL) {
        const input = ev.input as Record<string, unknown> | null;
        if (input && typeof input.reason === 'string') {
          pcNodeFailedReason = input.reason;
        } else {
          pcNodeFailedReason = '(no reason given)';
        }
      }
      return;
    }
    if (ev.kind === 'jsonl-turn-end') {
      succeedFromTurnEnd(ev.text);
    }
  });

  session.on('exit', (code: number | null, signal: string | null) => {
    if (resolved) return;
    fail(
      'spawn-error',
      `helper exited unexpectedly (code=${code ?? 'null'} signal=${signal ?? 'null'})`,
    );
  });

  return {
    done,
    kill: (reason) => {
      if (resolved) return;
      fail('killed', reason ?? 'killed by runtime');
    },
    transcriptPath: () => transcriptPath,
    jsonlPath: () => resolvedJsonlPath,
  };
}

function defaultCreateSession(opts: PtySessionOptions): SubagentSessionLike {
  return new PtySession(opts) as unknown as SubagentSessionLike;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
