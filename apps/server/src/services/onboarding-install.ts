// Section 10 Phase 2 — onboarding install actions.
//
// Drives the OFFICIAL installers for PC's hard dependencies, hands-off, on an
// explicit user click in the first-run wizard. Never auto-runs. Each action
// re-runs preflight afterward so the wizard can advance.
//
//   - Claude Code: the official `irm https://claude.ai/install.ps1 | iex`
//     (Windows) / `curl -fsSL https://claude.ai/install.sh | bash` one-liners.
//     Installs to ~/.local/bin — which the resolver's homedir candidate finds.
//   - git: winget-first (`Git.Git`), falling back to the official
//     Git-for-Windows installer run silently. Windows-only for now.

import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { clearClaudeProbeCache } from '@pc/runtime';

import { runPreflight, type PreflightReport } from './preflight.ts';

const execFileAsync = promisify(execFile);

/** Installers can take a few minutes (download + compile/extract). */
const INSTALL_TIMEOUT_MS = 6 * 60 * 1000;

export interface InstallResult {
  preflight: PreflightReport;
  log: string;
}

/** Run a command, folding stdout+stderr into one log blob. On failure, throw
 *  with the captured output (installers put the useful message there). */
async function run(cmd: string, args: string[], timeoutMs = INSTALL_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return `${stdout ?? ''}${stderr ?? ''}`.trim();
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    throw new Error(out || err.message || `${cmd} failed`);
  }
}

export async function installClaude(platform: NodeJS.Platform = process.platform): Promise<InstallResult> {
  let log: string;
  if (platform === 'win32') {
    log = await run('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'irm https://claude.ai/install.ps1 | iex',
    ]);
  } else {
    log = await run('bash', ['-c', 'curl -fsSL https://claude.ai/install.sh | bash']);
  }
  // The installer may have added claude to PATH; drop the memoized probe so the
  // post-install preflight re-resolves (the homedir candidate already re-checks
  // ~/.local/bin every call, but a PATH install needs the cache cleared).
  clearClaudeProbeCache();
  const preflight = await runPreflight();
  return { preflight, log: log || 'Installer finished.' };
}

export async function installGit(platform: NodeJS.Platform = process.platform): Promise<InstallResult> {
  if (platform !== 'win32') {
    throw new Error(
      'Automatic git install is Windows-only for now. Install git via your package manager (e.g. `brew install git`).',
    );
  }
  let log: string;
  try {
    log = await run('winget', [
      'install',
      '--id',
      'Git.Git',
      '-e',
      '--silent',
      '--accept-source-agreements',
      '--accept-package-agreements',
    ]);
  } catch (e) {
    log = `winget unavailable or failed (${(e as Error).message}).\nFalling back to the official Git-for-Windows installer.\n`;
    log += await installGitViaOfficialInstaller();
  }
  const preflight = await runPreflight();
  return { preflight, log: log || 'git install finished.' };
}

/** Fallback when winget is absent: fetch the latest 64-bit Git-for-Windows
 *  installer from GitHub releases and run it silently. */
async function installGitViaOfficialInstaller(): Promise<string> {
  const headers = { 'User-Agent': 'caisson-onboarding', Accept: 'application/vnd.github+json' };
  const rel = await fetch('https://api.github.com/repos/git-for-windows/git/releases/latest', {
    headers,
  });
  if (!rel.ok) throw new Error(`GitHub release lookup failed: ${rel.status}`);
  const data = (await rel.json()) as {
    assets?: { name: string; browser_download_url: string }[];
  };
  const asset = data.assets?.find((a) => /Git-.*-64-bit\.exe$/.test(a.name));
  if (!asset) throw new Error('No 64-bit Git-for-Windows installer found in the latest release.');

  const dl = await fetch(asset.browser_download_url, {
    headers: { 'User-Agent': 'caisson-onboarding' },
  });
  if (!dl.ok) throw new Error(`Installer download failed: ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  const tmp = join(tmpdir(), asset.name);
  await writeFile(tmp, buf);

  const out = await run(tmp, ['/VERYSILENT', '/NORESTART', '/SP-', '/SUPPRESSMSGBOXES']);
  return `Downloaded ${asset.name}; ran silent install.\n${out}`;
}
