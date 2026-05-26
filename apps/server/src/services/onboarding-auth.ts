// Section 10 Phase 2 — onboarding sign-in drive.
//
// Runs Claude Code's OWN `claude auth login` command on the user's behalf. CC
// runs its own OAuth flow, opens the system browser, and writes its own
// credential file (~/.claude/.credentials.json). Caisson never sees, mints, or
// stores a token — this is byte-for-byte the same sign-in a user does from a
// terminal, just spawned by the wizard instead of typed. No API, no `-p`.
//
// The login command is long-running (it waits for the browser OAuth callback),
// so we spawn it detached from the HTTP request and let the wizard poll
// `claude auth status` (via probeAuth) for success. We also scrape the printed
// "visit: <url>" line as a fallback button if the browser doesn't auto-open.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { requireClaudeBinary } from '@pc/runtime';

interface LoginState {
  /** A login process is currently running. */
  running: boolean;
  /** The OAuth URL CC printed (fallback if the browser didn't auto-open). */
  url: string | null;
  /** The login process exited. */
  exited: boolean;
  /** Exit code (0 = "Login successful"). */
  exitCode: number | null;
  /** Last slice of captured output for diagnostics. */
  tail: string;
}

let proc: ChildProcessWithoutNullStreams | null = null;
let captured = '';
let url: string | null = null;
let exitCode: number | null = null;

// CC prints "If the browser didn't open, visit: <url>"; also catch a bare
// oauth/authorize URL defensively.
const VISIT_RE = /visit:\s*(https?:\/\/\S+)/i;
const OAUTH_RE = /(https?:\/\/\S*(?:oauth|authorize)\S*)/i;

function ingest(chunk: string): void {
  captured += chunk;
  if (captured.length > 16_000) captured = captured.slice(-16_000);
  if (!url) {
    const m = VISIT_RE.exec(captured) ?? OAUTH_RE.exec(captured);
    if (m) url = m[1]!.trim();
  }
}

/** Start (or no-op if already running) `claude auth login`. */
export function startLogin(): LoginState {
  if (proc) return getLoginState();
  captured = '';
  url = null;
  exitCode = null;
  const bin = requireClaudeBinary();
  // `--claudeai` = Claude subscription (the default; explicit for clarity).
  const child = spawn(bin, ['auth', 'login', '--claudeai'], {
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
  proc = child;
  child.stdout.on('data', (b: Buffer) => ingest(b.toString()));
  child.stderr.on('data', (b: Buffer) => ingest(b.toString()));
  child.on('exit', (code) => {
    exitCode = code;
    proc = null;
  });
  child.on('error', () => {
    exitCode = -1;
    proc = null;
  });
  return getLoginState();
}

export function getLoginState(): LoginState {
  return {
    running: proc !== null,
    url,
    exited: proc === null && exitCode !== null,
    exitCode,
    tail: captured.slice(-500),
  };
}

/** Kill an in-flight login (e.g. the user closed the wizard / cancelled). */
export function cancelLogin(): void {
  if (proc) {
    proc.kill();
    proc = null;
  }
}
