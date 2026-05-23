// LowLevelSpawn — the foundation spawn primitive for the agent system rebuild.
//
// Every claude.exe spawn in PC goes through this one piece. Wraps node-pty
// with the three-signal ready gate, bracketed-paste + echo-ack send, env
// scrub, deterministic JSONL path resolution, and a single observability
// contract.
//
// Scope: just the spawn. Lifecycle state machines (AgentRun + InteractiveSession)
// live one layer above this and ship in Session 6. Delivery / tailer / persistence
// services ship in Session 7.
//
// Construction discipline: no synchronous emit during construction. The
// constructor returns the object; callers attach listeners; explicit start()
// begins the lifecycle. (Section 15 lesson — JSONL tailer's synchronous
// historical-line emit in the constructor body raced caller listener attach
// for the entire resume case.)

import pty from 'node-pty';
import { EventEmitter } from 'node:events';
import { existsSync, createWriteStream, mkdirSync, readFileSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { JsonlTailer, type JsonlEvent } from '../jsonl-tailer.ts';
import { scrubIdeEnv } from './env-scrub.ts';
import { stripAnsiPreserveSpacing, collapseAnsiToWhitespace } from './ansi.ts';
import { jsonlPathFor } from './path-resolver.ts';
import { ReadyGate, type ReadyTimestamps } from './ready-gate.ts';
import { sendBracketedPaste, type SendResult } from './send-protocol.ts';

const DEFAULT_CLAUDE_EXE = 'C:\\Users\\example\\.local\\bin\\claude.exe';
// 60s. Init-complete variance is 1013–2391ms in a clean sandbox; under banner
// load + concurrent dispatches Windows resume can stretch to 30–35s. The
// Section 18 V-4 lesson is that `session.kill()` isn't synchronous on Windows,
// so a too-tight timeout reports `resume-failed` after the resume has actually
// succeeded. 60s is wide enough that the kill-and-fail path never races a
// late success.
const DEFAULT_READY_TIMEOUT_MS = 60_000;

export interface PodDescriptor {
  /** Pod name passed to `--agent <name>`. Must match a materialized
   *  `.claude/agents/<name>.md` in the worktree. */
  name: string;
}

export interface LowLevelSpawnInput {
  /** Resolved pod descriptor. Caller is responsible for materializing the
   *  pod into the worktree before calling spawn (per §3.2 pre-invariant 3). */
  podDefinition: PodDescriptor;
  /** Absolute path to the bound worktree. Becomes the spawn cwd. */
  worktreePath: string;
  /** Process env. We scrub IDE-integration markers and inject FORCE_COLOR=0
   *  defensively even if the caller already scrubbed. */
  env: Record<string, string | undefined>;
  /** UUID. Caller mints up-front; we pass via --session-id (fresh) or
   *  --resume (resume). CC writes JSONL at the deterministic path. */
  ccProviderSessionId: string;
  mode: 'fresh' | 'resume';
  /** First user turn body — pasted via bracketed paste + echo-ack after the
   *  ready gate opens. Fresh only; never used on resume (resume continues
   *  the in-progress conversation). */
  initialInput?: string;
  /** Override path to the rewritten `.mcp.json`. Defaults to `.mcp.json`
   *  relative to the worktree. The MCP bundle handoff (Section 20.A) means
   *  this file's `command` field must point at the bundled
   *  `packages/mcp/dist/server.mjs`, not `npx -y tsx`. */
  mcpConfigPath?: string;
  /** Optional override of the claude.exe binary path. Defaults to
   *  `process.env.CLAUDE_EXE` or the hardcoded fallback. */
  claudeExe?: string;
  /** Optional handshake timeout. Default 60s. */
  handshakeTimeoutMs?: number;
  /** Optional ready timeout. Default 60s. */
  readyTimeoutMs?: number;
  /** Optional forensic transcript file. Raw bytes append. The wrapper
   *  decides where (agent-runs/<id>/transcript.log for dispatched,
   *  sessions/<id>/transcript.log for interactive). */
  transcriptPath?: string;
  /** PTY dimensions. Defaults match production (120x30). */
  cols?: number;
  rows?: number;
}

export type SpawnState = 'spawning' | 'ready' | 'running' | 'exited';

export interface SpawnEvents {
  /** Raw stdout chunks (ANSI-stripped with cursor-forward preserved as
   *  spaces — see ansi.ts). xterm-side render, debug logs. */
  chunk: (text: string) => void;
  /** Untouched raw bytes for the forensic transcript. */
  raw: (bytes: string) => void;
  /** State transitions only. NOT lifecycle state (wrapper's responsibility). */
  state: (s: SpawnState) => void;
  /** Parsed JSONL line from CC's on-disk session file. */
  'jsonl-event': (ev: JsonlEvent) => void;
  /** Fires once when all three signals are in. */
  ready: (ts: ReadyTimestamps) => void;
  /** PTY exit. */
  exit: (code: number | null, signal: number | null) => void;
}

/**
 * One PTY spawn = one claude.exe child = one LowLevelSpawn instance.
 *
 * Lifecycle:
 *   1. `new LowLevelSpawn(input)` — constructor stores config; does NOT spawn.
 *   2. Caller attaches listeners (`on('ready', ...)`, `on('jsonl-event', ...)`).
 *   3. `start()` — kicks off the actual pty.spawn + tailer attach. Required
 *      to begin the lifecycle. Returns void; listen on events.
 *   4. `awaitReady()` — Promise that resolves when the gate opens (all three
 *      signals fire) or rejects on timeout / exit.
 *   5. `send(body)` — bracketed-paste + echo-ack. Only callable after ready.
 *   6. `kill()` — graceful Ctrl-C then SIGKILL after a grace window.
 */
export class LowLevelSpawn extends EventEmitter {
  private child: pty.IPty | null = null;
  private state: SpawnState = 'spawning';
  private rawBuffer = '';
  private trustConfirmSent = false;
  private readonly input: LowLevelSpawnInput;
  private readonly gate: ReadyGate;
  private tailer: JsonlTailer | null = null;
  private jsonlPollTimer: NodeJS.Timeout | null = null;
  private transcriptStream: WriteStream | null = null;
  /** Resolved at start(). Stored so callers can introspect post-spawn. */
  private resolvedJsonlPath: string | null = null;
  private readyPromise: Promise<ReadyTimestamps>;
  private readyResolve: ((ts: ReadyTimestamps) => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(input: LowLevelSpawnInput) {
    super();
    this.input = input;
    this.gate = new ReadyGate();
    this.gate.on('ready', (ts) => this.handleGateOpen(ts));
    this.gate.on('aborted', (reason: string) => this.handleGateAbort(reason));

    this.readyPromise = new Promise<ReadyTimestamps>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  /** Begin the lifecycle. Spawns the pty child. Must be called exactly once. */
  start(): void {
    if (this.started) throw new Error('LowLevelSpawn: start() called twice');
    this.started = true;

    const claudeExe =
      this.input.claudeExe ?? process.env.CLAUDE_EXE ?? DEFAULT_CLAUDE_EXE;
    const mcpConfigPath = this.input.mcpConfigPath ?? '.mcp.json';

    this.resolvedJsonlPath = jsonlPathFor(
      this.input.worktreePath,
      this.input.ccProviderSessionId,
    );

    if (this.input.transcriptPath) {
      mkdirSync(dirname(this.input.transcriptPath), { recursive: true });
      this.transcriptStream = createWriteStream(this.input.transcriptPath, {
        flags: 'a',
      });
    }

    const args: string[] = [
      // Without this CC prompts before every tool call, blocking end_turn.
      // Lab scenario 08 surfaced this. Production sets it for every dispatched
      // agent and the orchestrator equivalent.
      '--dangerously-skip-permissions',
      // Pod's tool allowlist + prompt fully replace CC's coding-assistant
      // default (Section 16a). Always set, never omitted.
      '--agent',
      this.input.podDefinition.name,
      // Scope MCP to ONLY the supplied config. Caller is responsible for
      // ensuring this file points at the bundled MCP server (Section 20.A).
      '--mcp-config',
      mcpConfigPath,
      '--strict-mcp-config',
    ];

    if (this.input.mode === 'fresh') {
      args.push('--session-id', this.input.ccProviderSessionId);
    } else {
      args.push('--resume', this.input.ccProviderSessionId);
    }

    const env = scrubIdeEnv(this.input.env);

    this.child = pty.spawn(claudeExe, args, {
      cwd: this.input.worktreePath,
      env,
      cols: this.input.cols ?? 120,
      rows: this.input.rows ?? 30,
    });

    this.child.onData((data) => this.onChunk(data));
    this.child.onExit(({ exitCode, signal }) =>
      this.onExit(exitCode ?? null, signal ?? null),
    );

    this.readyTimer = setTimeout(() => {
      this.gate.abort('ready-timeout');
    }, this.input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);

    // Defer tailer attach so callers' listeners are wired before historical
    // events fire (Section 15 lesson — replicated for safety even though the
    // JSONL file rarely exists this early on a fresh dispatch).
    setImmediate(() => this.attachJsonlTailer());
  }

  /** Called by the HTTP route at /api/internal/mcp-handshake when the
   *  spawned agent's pc-rig MCP child completes its initialization. */
  notifyMcpHandshake(): void {
    this.gate.notifyHandshake();
  }

  /** Resolves with the three ready timestamps once the gate opens, or
   *  rejects with a timeout / exit error. Idempotent — same promise on
   *  every call. */
  awaitReady(): Promise<ReadyTimestamps> {
    return this.readyPromise;
  }

  /** Bracketed-paste + echo-ack send. Only callable after the gate has
   *  opened (caller should `await awaitReady()` first). Returns a status
   *  describing whether the echo landed before the timeout. */
  async send(body: string, echoTimeoutMs?: number): Promise<SendResult> {
    if (!this.child) throw new Error('LowLevelSpawn: send before start');
    if (this.state === 'exited') return 'exited';
    if (!this.gate.isOpen()) {
      throw new Error(
        'LowLevelSpawn: send before ready gate opened — await awaitReady() first',
      );
    }
    const result = await sendBracketedPaste(
      {
        write: (bytes) => this.child!.write(bytes),
        getRawBuffer: () => this.rawBuffer,
        isExited: () => this.state === 'exited',
      },
      body,
      echoTimeoutMs,
    );
    if (result === 'ok') this.setState('running');
    return result;
  }

  /** Graceful interrupt — Escape is CC's stop-streaming key in interactive
   *  mode (Ctrl-C only triggers "Press Ctrl-C again to exit"). */
  interrupt(): void {
    if (!this.child || this.state === 'exited') return;
    this.child.write('\x1b');
  }

  /** Kill the child. Sends Ctrl-C first, then SIGKILL after a grace window
   *  so CC's SessionEnd hook has time to fire its final JSONL write. */
  kill(graceMs = 500): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    if (this.jsonlPollTimer) {
      clearTimeout(this.jsonlPollTimer);
      this.jsonlPollTimer = null;
    }
    if (this.tailer) {
      this.tailer.stop();
      this.tailer = null;
    }
    if (this.transcriptStream) {
      this.transcriptStream.end();
      this.transcriptStream = null;
    }
    if (!this.child || this.state === 'exited') {
      this.gate.abort('killed');
      this.setState('exited');
      return;
    }
    try {
      this.child.write('\x03');
      setTimeout(() => {
        try {
          this.child?.kill();
        } catch {
          /* already dead */
        }
      }, graceMs);
    } catch {
      /* already dead */
    }
  }

  getState(): SpawnState {
    return this.state;
  }

  getJsonlPath(): string | null {
    return this.resolvedJsonlPath;
  }

  /** Test-only / wrapper-only — exposes the raw buffer for diagnostics.
   *  Production code should rely on `chunk` / `jsonl-event` instead. */
  getRawBuffer(): string {
    return this.rawBuffer;
  }

  // -- internals ------------------------------------------------------

  private onChunk(data: string): void {
    this.rawBuffer += data;
    if (this.transcriptStream) {
      try {
        this.transcriptStream.write(data);
      } catch {
        /* transcript best-effort */
      }
    }
    this.emit('raw', data);
    this.emit('chunk', stripAnsiPreserveSpacing(data));

    // Auto-confirm CC's "Quick safety check / Is this a project you trust?"
    // prompt that fires on first spawn into an untrusted worktree. Same
    // regex set as production pty-session.ts:288. Idempotent.
    if (!this.trustConfirmSent) {
      const cleanAll = collapseAnsiToWhitespace(this.rawBuffer);
      if (
        /Quick\s*safety\s*check/i.test(cleanAll) ||
        /Is\s*this\s*a\s*project\s*you\s*created/i.test(cleanAll) ||
        /Yes,\s*I\s*trust\s*this\s*folder/i.test(cleanAll)
      ) {
        this.trustConfirmSent = true;
        try {
          this.child?.write('\r');
        } catch {
          /* exited mid-press */
        }
      }
    }

    this.gate.feedChunk(data);
  }

  private onExit(code: number | null, signal: number | null): void {
    this.setState('exited');
    this.gate.abort('exited-before-ready');
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    if (this.tailer) {
      // Tailer may still have buffered lines worth emitting; let it drain
      // before we stop it.
      this.tailer.stop();
      this.tailer = null;
    }
    if (this.transcriptStream) {
      this.transcriptStream.end();
      this.transcriptStream = null;
    }
    this.emit('exit', code, signal);
  }

  private handleGateOpen(ts: ReadyTimestamps): void {
    if (this.state === 'exited') return;
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    this.setState('ready');
    this.emit('ready', ts);
    this.readyResolve?.(ts);
    this.readyResolve = null;
    this.readyReject = null;
  }

  private handleGateAbort(reason: string): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    if (this.readyReject) {
      this.readyReject(new Error(`LowLevelSpawn: ready gate aborted (${reason})`));
      this.readyResolve = null;
      this.readyReject = null;
    }
  }

  private setState(next: SpawnState): void {
    if (this.state === next) return;
    this.state = next;
    this.emit('state', next);
  }

  /** Poll the deterministic JSONL path for first-existence then attach the
   *  tailer. CC mints the file lazily — fresh dispatches typically see it
   *  appear ~1-2s after the first user turn.
   *
   *  Resume mode: skip past existing lines so the tailer only emits events
   *  from CC's new appends. Without this guard, the prior conversation's
   *  assistant turn-ends replay as fresh `kind: 'jsonl-turn-end'` events and
   *  race the wrapper's `running` listener into completing the run before
   *  the resumed agent's actual answer arrives. (Same root cause +
   *  same fix as Section 21's v1-side `e5b9b53`.) */
  private attachJsonlTailer(): void {
    if (this.state === 'exited') return;
    const path = this.resolvedJsonlPath;
    if (!path) return;

    const tryAttach = () => {
      if (this.tailer || this.state === 'exited') return;
      if (existsSync(path)) {
        let startLine = 0;
        if (this.input.mode === 'resume') {
          try {
            const existing = readFileSync(path, 'utf-8');
            startLine = existing.split('\n').filter(Boolean).length;
          } catch {
            // Best-effort. Falling back to 0 inherits the replay bug on this
            // run but doesn't hard-fail; surfaces as a premature complete()
            // that the user can re-dispatch around.
            startLine = 0;
          }
        }
        this.tailer = new JsonlTailer({ filePath: path, startLine });
        this.tailer.on('event', (ev: JsonlEvent) => this.emit('jsonl-event', ev));
        this.tailer.start();
        return;
      }
      this.jsonlPollTimer = setTimeout(tryAttach, 250);
    };
    tryAttach();
  }
}
