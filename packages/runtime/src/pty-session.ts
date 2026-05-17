// Wraps a node-pty spawn of claude.exe.
// Patterns copied from PC-Validation/shared/scripts/drive-t11.js + drive-t15.js
// (proven on Windows ConPTY against CC v2.1.140).

import pty from 'node-pty';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  watchFile,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { JsonlTailer, type JsonlEvent } from './jsonl-tailer.ts';

const DEFAULT_CLAUDE = 'C:\\Users\\example\\.local\\bin\\claude.exe';

/** CC encodes the absolute cwd as the dir name under `~/.claude/projects/`.
 *  Replace any non-[A-Za-z0-9._-] character with '-'. Empirically verified
 *  against `C:\\Users\\example\\AppData\\Local\\Temp\\cc-stream-test` →
 *  `C--Users-emers-AppData-Local-Temp-cc-stream-test` and
 *  `E:\\Projects\\Caisson\\workspace` →
 *  `E--Claude-Code-Projects-Personal-PC-PTY-Chat-workspace`. */
export function encodeCwdForClaude(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9._-]/g, '-');
}

export interface PtySessionOptions {
  workspaceDir: string;
  claudeExe?: string;
  stopMarkerPath: string;
  eventsPath: string;
  transcriptPath: string;
  cols?: number;
  rows?: number;
  /** Claude session UUID — caller mints it (or fetches from prior row).
   *  When set, we either mint (resume=false) or resume (resume=true) the
   *  named session so chat history in the UI matches Claude's actual context. */
  claudeSessionId?: string;
  /** When true, pass `--resume <uuid>`. When false, pass `--session-id <uuid>`
   *  (mint). Ignored if `claudeSessionId` is unset. */
  resume?: boolean;
  /** Extra env vars merged into the claude.exe spawn env. Used to thread
   *  PC_SESSION_ID through so hooks can route their writes into the
   *  per-session data dir. */
  extraEnv?: Record<string, string>;
  /** Root of CC's per-project session dirs. Defaults to
   *  `<homedir>/.claude/projects`. Override only for tests. */
  claudeProjectsDir?: string;
  /** Pre-resolved CC JSONL path. When set, the JSONL tailer attaches to this
   *  file immediately and skips the discovery scan. Used for `--resume` so we
   *  re-attach to the same file the prior session was writing into. */
  jsonlPath?: string;
  /** Cursor (line count) to resume the tailer from. Only used when
   *  `jsonlPath` is set. Defaults to 0. */
  jsonlStartLine?: number;
}

export type SessionState = 'spawning' | 'ready' | 'thinking' | 'exited';

/**
 * One PTY session = one claude.exe child.
 * Emits:
 *   'chunk'                (raw bytes, ANSI-stripped) — stream to UI
 *   'raw'                  (raw bytes, untouched)     — for transcript / debug
 *   'state'                (SessionState)             — UI status indicator
 *   'exit'                 (code, signal)
 *   'turn-end'             — legacy hook-derived turn marker (vestigial; will go in 0f)
 *   'event'                — legacy hook-derived structured event from events.jsonl
 *   'jsonl-event'          (JsonlEvent)               — canonical event from CC's session JSONL
 *   'jsonl-path-resolved'  (path: string)             — emitted once after discovery succeeds
 *   'jsonl-cursor-tick'    (path: string, cursor: number) — debounced cursor tick for persistence
 */
export class PtySession extends EventEmitter {
  private child: pty.IPty;
  private state: SessionState = 'spawning';
  private rawBuffer = '';
  private bannerSeen = false;
  private channelConfirmSent = false;
  private stopMarkerPath: string;
  private eventsPath: string;
  private lastMarkerCount = 0;
  private lastEventCount = 0;
  private workspaceDir: string;
  private claudeProjectsDir: string;
  private spawnedAt = 0;
  private tailer: JsonlTailer | null = null;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private cursorPersistTimer: NodeJS.Timeout | null = null;

  constructor(opts: PtySessionOptions) {
    super();
    const claudeExe = opts.claudeExe ?? process.env.CLAUDE_EXE ?? DEFAULT_CLAUDE;
    this.stopMarkerPath = resolve(opts.stopMarkerPath);
    this.eventsPath = resolve(opts.eventsPath);
    this.workspaceDir = opts.workspaceDir;
    this.claudeProjectsDir =
      opts.claudeProjectsDir ?? join(homedir(), '.claude', 'projects');

    mkdirSync(dirname(opts.transcriptPath), { recursive: true });
    writeFileSync(opts.transcriptPath, '');
    // Reset marker + events files so we count from zero per server start.
    mkdirSync(dirname(this.stopMarkerPath), { recursive: true });
    if (existsSync(this.stopMarkerPath)) rmSync(this.stopMarkerPath);
    writeFileSync(this.stopMarkerPath, '');
    mkdirSync(dirname(this.eventsPath), { recursive: true });
    // Don't wipe events.jsonl on respawn — chat history should survive
    // tsx watch restarts. Seed the line counter at the existing count so we
    // only emit NEW lines.
    if (!existsSync(this.eventsPath)) writeFileSync(this.eventsPath, '');
    try {
      this.lastEventCount = readFileSync(this.eventsPath, 'utf-8')
        .split('\n')
        .filter(Boolean).length;
    } catch {
      this.lastEventCount = 0;
    }
    // Reset per-session task state — task IDs restart at 1 in each CC session.
    const tasksFile = resolve(dirname(this.eventsPath), 'tasks.json');
    try { writeFileSync(tasksFile, '{}'); } catch { /* best effort */ }

    // Session-continuity args (--session-id / --resume) are currently DISABLED.
    // The plumbing on the project side still mints UUIDs + writes rows, but
    // we don't pass them to claude.exe yet — interactive PTY spawns with
    // --session-id are dying for reasons not yet isolated. Gating on the env
    // var so the codepath can be re-enabled for testing without a code change.
    // TODO(phase-2): finish diagnosing + remove the gate.
    const enableSessionFlags = process.env.PC_ENABLE_SESSION_FLAGS === '1';
    const args: string[] = [
      '--dangerously-skip-permissions',
      // Orchestrator is locked to opus per chat.md locked decision.
      // Subagents pick their own model via YAML.
      '--model',
      'opus',
      // Scope MCP to ONLY workspace/.mcp.json (pc-rig + webhook). Without
      // --strict-mcp-config the orchestrator merges global user-level MCPs
      // (e.g. WCP, archon) and tries to use them — confusing and leaks
      // unrelated capabilities into the rig.
      '--mcp-config',
      '.mcp.json',
      '--strict-mcp-config',
    ];
    if (enableSessionFlags && opts.claudeSessionId) {
      if (opts.resume) {
        args.push('--resume', opts.claudeSessionId);
      } else {
        args.push('--session-id', opts.claudeSessionId);
      }
    }
    // Load the webhook channel registered in workspace/.mcp.json. CC will
    // prompt once on boot to confirm dev-channel usage; we auto-press
    // Enter below. Variadic — keep at the end of the arg list so any future
    // flags don't get gobbled.
    args.push('--dangerously-load-development-channels', 'server:webhook');
    this.child = pty.spawn(claudeExe, args, {
      cwd: opts.workspaceDir,
      env: { ...process.env, FORCE_COLOR: '0', ...(opts.extraEnv ?? {}) },
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 30,
    });

    this.child.onData((data) => {
      this.rawBuffer += data;
      try {
        writeFileSync(opts.transcriptPath, this.rawBuffer);
      } catch {
        /* transcript best-effort */
      }
      this.emit('raw', data);
      const stripped = stripAnsi(data);
      this.emit('chunk', stripped);

      // Dev-channels confirmation prompt fires once at boot. Auto-press Enter
      // to accept the preselected "I am using this for local development".
      // Pattern lifted from drive-t11.js.
      if (!this.channelConfirmSent) {
        const cleanAll = stripAnsi(this.rawBuffer);
        if (
          /local development/i.test(cleanAll) ||
          /Loading development channels/i.test(cleanAll) ||
          /Enter to confirm/i.test(cleanAll) ||
          /I am using this/i.test(cleanAll)
        ) {
          this.channelConfirmSent = true;
          this.child.write('\r');
        }
      }

      // First time we see the welcome banner, mark ready.
      if (!this.bannerSeen) {
        const cleanAll = stripAnsi(this.rawBuffer);
        if (
          /Welcome back/i.test(cleanAll) ||
          /Tips for getting started/i.test(cleanAll) ||
          /What's new/i.test(cleanAll) ||
          /Try "/i.test(cleanAll)
        ) {
          this.bannerSeen = true;
          this.setState('ready');
        }
      }
    });

    this.child.onExit(({ exitCode, signal }) => {
      this.setState('exited');
      this.emit('exit', exitCode, signal);
    });

    // Watch the Stop-marker file. Each new line = one turn ended.
    watchFile(this.stopMarkerPath, { interval: 250 }, () => {
      try {
        const lines = readFileSync(this.stopMarkerPath, 'utf-8')
          .split('\n')
          .filter(Boolean);
        if (lines.length > this.lastMarkerCount) {
          this.lastMarkerCount = lines.length;
          if (this.state === 'thinking') this.setState('ready');
          this.emit('turn-end');
        }
      } catch {
        /* file may not exist yet on first tick */
      }
    });

    // Watch the events file. Each new line is a structured chat event
    // (user prompt / assistant reply / tool start / tool end).
    watchFile(this.eventsPath, { interval: 200 }, () => {
      try {
        const lines = readFileSync(this.eventsPath, 'utf-8')
          .split('\n')
          .filter(Boolean);
        if (lines.length > this.lastEventCount) {
          for (let i = this.lastEventCount; i < lines.length; i++) {
            let obj;
            try { obj = JSON.parse(lines[i]); } catch { continue; }
            this.emit('event', obj);
          }
          this.lastEventCount = lines.length;
        }
      } catch {
        /* file may not exist yet */
      }
    });

    // JSONL tailer — CC's per-session transcript is the canonical source for
    // turn lifecycle + tool calls (see docs/design/chat-reliability.md).
    // Resume case: caller passed jsonlPath → attach immediately at the
    // persisted cursor. Fresh case: poll the project dir until CC writes a
    // .jsonl file with mtime past spawn time, then attach.
    this.spawnedAt = Date.now();
    if (opts.jsonlPath && existsSync(opts.jsonlPath)) {
      this.attachTailer(opts.jsonlPath, opts.jsonlStartLine ?? 0);
    } else {
      this.startJsonlDiscovery();
    }
  }

  /** Poll `~/.claude/projects/<encoded-cwd>/` every 250ms for a .jsonl file
   *  whose mtime is at/after our spawn time. First match wins. */
  private startJsonlDiscovery(): void {
    const projectDir = join(
      this.claudeProjectsDir,
      encodeCwdForClaude(this.workspaceDir),
    );
    // Allow a small grace window for clock skew between Date.now() and
    // filesystem mtime — we'd rather latch onto a freshly-created file than
    // poll forever.
    const cutoff = this.spawnedAt - 1000;
    const tryFind = () => {
      if (this.tailer || this.state === 'exited') return;
      try {
        if (!existsSync(projectDir)) {
          this.discoveryTimer = setTimeout(tryFind, 250);
          return;
        }
        let best: { path: string; mtime: number } | null = null;
        for (const name of readdirSync(projectDir)) {
          if (!name.endsWith('.jsonl')) continue;
          const p = join(projectDir, name);
          try {
            const st = statSync(p);
            const mt = st.mtimeMs;
            if (mt >= cutoff && (!best || mt > best.mtime)) {
              best = { path: p, mtime: mt };
            }
          } catch {
            /* file vanished mid-scan */
          }
        }
        if (best) {
          this.attachTailer(best.path, 0);
          this.emit('jsonl-path-resolved', best.path);
          return;
        }
      } catch {
        /* dir disappeared / perms — keep polling */
      }
      this.discoveryTimer = setTimeout(tryFind, 250);
    };
    this.discoveryTimer = setTimeout(tryFind, 250);
  }

  private attachTailer(filePath: string, startLine: number): void {
    this.tailer = new JsonlTailer({ filePath, startLine });
    this.tailer.on('event', (ev: JsonlEvent) => {
      this.emit('jsonl-event', ev);
      this.scheduleCursorPersist(filePath);
    });
    this.tailer.on('error', (err: Error) => {
      this.emit('jsonl-error', err);
    });
    this.tailer.start();
  }

  /** Debounced — coalesce cursor persistence to ~1Hz to avoid hammering the
   *  DB during a flurry of tool calls. The trailing tick fires after activity
   *  stops; if the process dies mid-flurry we lose <=1s of cursor advance,
   *  which means at most 1s of duplicate broadcasts on resume. Acceptable. */
  private scheduleCursorPersist(filePath: string): void {
    if (this.cursorPersistTimer) return;
    this.cursorPersistTimer = setTimeout(() => {
      this.cursorPersistTimer = null;
      if (this.tailer) {
        this.emit('jsonl-cursor-tick', filePath, this.tailer.getCursor());
      }
    }, 1000);
  }

  /** Send a user message. Adds carriage return to submit. */
  send(text: string) {
    if (this.state === 'exited') throw new Error('session exited');
    this.child.write(text);
    // Small delay before submit lets node-pty flush the text into the input box
    // before we send Enter — taken from drive-t11.js (~300ms there; 50ms is enough here).
    setTimeout(() => {
      this.child.write('\r');
      this.setState('thinking');
    }, 50);
  }

  /** Stop the current turn. In claude.exe interactive mode, Escape (\x1b) is
   *  the stop-streaming key. Ctrl+C (\x03) only triggers the "Press Ctrl-C
   *  again to exit" prompt — it does NOT abort the in-flight response. */
  interrupt() {
    if (this.state === 'exited') return;
    this.child.write('\x1b');
  }

  resize(cols: number, rows: number) {
    if (this.state === 'exited') return;
    this.child.resize(cols, rows);
  }

  kill() {
    if (this.discoveryTimer) {
      clearTimeout(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    if (this.cursorPersistTimer) {
      clearTimeout(this.cursorPersistTimer);
      this.cursorPersistTimer = null;
    }
    if (this.tailer) {
      this.tailer.stop();
      this.tailer = null;
    }
    try {
      this.child.write('\x03');
      setTimeout(() => this.child.kill(), 500);
    } catch {
      /* already dead */
    }
  }

  getState(): SessionState {
    return this.state;
  }

  private setState(next: SessionState) {
    if (this.state === next) return;
    this.state = next;
    this.emit('state', next);
  }
}

/**
 * Strip ANSI / CSI sequences. Preserves visual spacing: cursor-forward
 * (CSI N C) becomes N spaces so "Loading\x1b[1Cdevelopment" stays readable.
 * Lifted verbatim from drive-t11.js.
 */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(parseInt(n || '1', 10)))
    .replace(/\x1b\[[\d;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[>=()]/g, '');
}

// Silence unused-import warning for `statSync` in some toolchains.
void statSync;
