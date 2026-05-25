// Section 10 Phase 0 — preflight.
//
// A structured report of whether PC's runtime dependencies are present and
// usable on THIS machine. Surfaced at GET /api/preflight. The Phase-2
// onboarding wizard reads it to decide what to install/drive; today's app can
// show it in a diagnostics view. Every failure is a typed state, never a raw
// spawn error.
//
// PC is a launcher for Claude Code, so the hard dependencies are:
//   - claude  (the binary PC spawns for every chat/agent/workflow turn)
//   - git     (project creation + agent-worktree isolation)
// Soft dependencies (only workflow code-nodes need them):
//   - node / bash / python

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveClaudeBinary, type ClaudeBinarySource } from '@pc/runtime';

const execFileAsync = promisify(execFile);

/** Minimum Claude Code version PC supports. v2 introduced the banner + flag
 *  behaviors PC's spawn machinery depends on (cursor-right banner rendering,
 *  folder-trust prompt, `--agent` replace semantics, dev-channel flag).
 *  Anything below 2.0.0 breaks those assumptions. Dev binary: 2.1.150. */
export const MIN_CLAUDE_VERSION = '2.0.0';

const PROBE_TIMEOUT_MS = 10_000;

export interface ClaudePreflight {
  /** ok = found + version ≥ gate. unverified = found but `--version` couldn't
   *  be read/parsed. */
  status: 'ok' | 'not-found' | 'version-too-old' | 'unverified';
  path: string | null;
  source: ClaudeBinarySource | 'not-found';
  version: string | null;
  minVersion: string;
}

export interface AuthPreflight {
  /** Phase 0 does NOT probe auth. Verifying it needs either a heavy
   *  interactive spawn or a credentials-file path we won't invent (buildout
   *  caution). The Phase-2 wizard drives + verifies login via banner
   *  detection. Reported as 'unknown' so the contract field exists day one. */
  status: 'unknown';
  note: string;
}

export interface DependencyProbe {
  name: string;
  present: boolean;
  version: string | null;
  /** hard = PC can't function without it; soft = only some features need it. */
  severity: 'hard' | 'soft';
  note?: string;
}

export interface PreflightReport {
  claude: ClaudePreflight;
  auth: AuthPreflight;
  /** git is a HARD dep — project create + agent worktrees shell out to it. */
  git: DependencyProbe;
  /** node / bash / python — SOFT deps (workflow code-nodes only). */
  soft: DependencyProbe[];
  /** All hard deps satisfied and claude version acceptable. */
  ok: boolean;
}

/** Extract the first dotted numeric version token from a `--version` blob.
 *  "2.1.150 (Claude Code)" → "2.1.150"; "git version 2.51.0.windows.2" →
 *  "2.51.0.windows.2" trimmed to its numeric prefix → "2.51.0". */
function parseVersion(out: string): string | null {
  const m = out.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

/** Numeric semver-ish compare on the first three dotted segments.
 *  Returns -1 / 0 / 1 for a < / == / > b. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10));
  const pb = b.split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Run `<bin> --version` (or a custom args list). Returns the raw stdout+stderr
 *  on success, or null if the binary isn't runnable. CC/git/node print to
 *  stdout; we fold in stderr defensively. */
async function runVersion(bin: string, args: string[] = ['--version']): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const out = `${stdout ?? ''}${stderr ?? ''}`.trim();
    return out || null;
  } catch {
    return null;
  }
}

async function checkClaude(): Promise<ClaudePreflight> {
  const res = resolveClaudeBinary();
  if (!res.path) {
    return {
      status: 'not-found',
      path: null,
      source: 'not-found',
      version: null,
      minVersion: MIN_CLAUDE_VERSION,
    };
  }
  const raw = await runVersion(res.path);
  const version = raw ? parseVersion(raw) : null;
  let status: ClaudePreflight['status'];
  if (!version) {
    // Resolver found a path but `--version` failed or was unparseable — the
    // file exists but may be broken / not actually Claude.
    status = 'unverified';
  } else if (compareVersions(version, MIN_CLAUDE_VERSION) < 0) {
    status = 'version-too-old';
  } else {
    status = 'ok';
  }
  return {
    status,
    path: res.path,
    source: res.source,
    version,
    minVersion: MIN_CLAUDE_VERSION,
  };
}

async function probeBinary(
  name: string,
  severity: 'hard' | 'soft',
  candidates: string[] = [name],
  note?: string,
): Promise<DependencyProbe> {
  for (const bin of candidates) {
    const raw = await runVersion(bin);
    if (raw !== null) {
      return { name, present: true, version: parseVersion(raw), severity, note };
    }
  }
  return { name, present: false, version: null, severity, note };
}

export async function runPreflight(): Promise<PreflightReport> {
  const [claude, git, node, bash, python] = await Promise.all([
    checkClaude(),
    probeBinary('git', 'hard', ['git'], 'Required for project creation + agent worktrees.'),
    probeBinary('node', 'soft', ['node'], 'Workflow code-nodes only.'),
    probeBinary('bash', 'soft', ['bash'], 'Workflow code-nodes only.'),
    probeBinary('python', 'soft', ['python', 'python3'], 'Workflow code-nodes only.'),
  ]);

  const auth: AuthPreflight = {
    status: 'unknown',
    note: 'Auth is verified at first spawn; the onboarding wizard (Phase 2) drives login.',
  };

  const ok = claude.status === 'ok' && git.present;

  return { claude, auth, git, soft: [node, bash, python], ok };
}
