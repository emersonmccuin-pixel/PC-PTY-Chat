// Resolves the claude.exe binary path. Replaces the hardcoded
// `C:\Users\example\.local\bin\claude.exe` constants that lived in
// low-level-spawn.ts + pty-session.ts.
//
// This is the foundation of Section 10 (onboarding/distribution): PC is a
// launcher for Claude Code, so step one of making the dependency real is
// knowing where Claude actually is on *this* machine, not the dev's.
//
// Resolution order (highest priority first):
//   1. per-call override   — explicit caller arg (per-spawn override / tests)
//   2. configured override — GlobalSettings.claudeExe, pushed in by the server
//   3. env CLAUDE_EXE
//   4. PATH lookup         — `where claude` (win) / `which claude` (posix)
//   5. ~/.local/bin/claude(.exe)  — the native installer's default location
//   6. not-found
//
// Candidates 1–3 are explicit user intent, so they're trusted on sight — their
// *existence* is the preflight's job, not this module's. Candidates 4–5 are
// only chosen if they resolve to a real file. Separation of concerns: this
// module answers "which path", preflight answers "is it a working, authed CC".

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ClaudeBinarySource = 'override' | 'config' | 'env' | 'path' | 'homedir';

export type ClaudeResolution =
  | { path: string; source: ClaudeBinarySource }
  | { path: null; source: 'not-found' };

let configuredOverride: string | null = null;
// Memoize only the expensive PATH probe (a child_process spawn). The cheap
// existsSync checks re-run every call so a freshly-installed binary is picked
// up without a process restart.
let pathProbeCache: { value: string | null } | null = null;

/** Push the GlobalSettings.claudeExe value in from the server layer. The
 *  runtime package can't read the settings store directly (it would invert the
 *  dependency), so the server calls this at boot and after any settings PATCH
 *  that changes claudeExe. Null / empty clears the override. */
export function setConfiguredClaudeExe(path: string | null): void {
  configuredOverride = path && path.trim() ? path.trim() : null;
}

/** Test/diagnostic seam — drop the memoized PATH-probe result. */
export function clearClaudeProbeCache(): void {
  pathProbeCache = null;
}

function claudeBinaryName(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

function probePath(): string | null {
  if (pathProbeCache) return pathProbeCache.value;
  let value: string | null = null;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, ['claude'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // `where` can return multiple lines; take the first that resolves.
    const first = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    if (first && existsSync(first)) value = first;
  } catch {
    value = null; // not on PATH
  }
  pathProbeCache = { value };
  return value;
}

function homedirCandidate(): string | null {
  const candidate = join(homedir(), '.local', 'bin', claudeBinaryName());
  return existsSync(candidate) ? candidate : null;
}

export interface ResolveOptions {
  /** Per-call override — wins over everything. Empty/undefined is ignored. */
  override?: string | null;
  /** Test seam — override the PATH probe. Production passes nothing. */
  probePath?: () => string | null;
  /** Test seam — override the ~/.local/bin existence check. */
  probeHomedir?: () => string | null;
}

export function resolveClaudeBinary(opts: ResolveOptions = {}): ClaudeResolution {
  const override = opts.override && opts.override.trim() ? opts.override.trim() : null;
  if (override) return { path: override, source: 'override' };
  if (configuredOverride) return { path: configuredOverride, source: 'config' };
  const env = process.env.CLAUDE_EXE;
  if (env && env.trim()) return { path: env.trim(), source: 'env' };
  const onPath = (opts.probePath ?? probePath)();
  if (onPath) return { path: onPath, source: 'path' };
  const home = (opts.probeHomedir ?? homedirCandidate)();
  if (home) return { path: home, source: 'homedir' };
  return { path: null, source: 'not-found' };
}

/** Spawn-site convenience — returns the resolved path or throws a clear,
 *  actionable error. Replaces the silent garbage-path spawn that node-pty
 *  would otherwise ENOENT on with an unhelpful message. */
export function requireClaudeBinary(override?: string | null): string {
  const r = resolveClaudeBinary({ override });
  if (!r.path) {
    throw new Error(
      'Claude Code binary not found. Checked: configured path, CLAUDE_EXE env, ' +
        'PATH, and ~/.local/bin. Install it from https://claude.ai/install or set ' +
        'the path in settings.',
    );
  }
  return r.path;
}
