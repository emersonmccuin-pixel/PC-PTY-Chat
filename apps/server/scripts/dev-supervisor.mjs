#!/usr/bin/env node
// DEV-ONLY supervisor for apps/server.
//
// Spawns `tsx src/index.ts` and respawns the child when it exits with sentinel
// code 75 (intentional restart requested via POST /api/dev/restart).
// Unexpected exits (non-75) are crashes: auto-recover when the server had been
// running healthy (uptime >= CRASH_HEALTHY_UPTIME_MS), but do NOT crash-loop on
// a boot failure — rapid crashes accumulate toward MAX_CRASH_RESTARTS, after
// which the supervisor gives up and exits.
//
// Backoff: rapid sentinel-restarts (server dies in < 5s) accumulate a
// capped delay so a boot-time crash doesn't spin tightly.
//
// Signal forwarding: SIGINT/SIGTERM are forwarded to the child; once the
// child exits the supervisor exits cleanly (no respawn).

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SENTINEL = 75;
const MIN_UPTIME_RESET_MS = 5_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8_000;
// Crash auto-recovery: a non-75 exit after the server ran healthy this long is
// treated as a transient crash worth respawning. Rapid crashes (before this
// threshold) accumulate toward the cap so a boot failure can't spin forever.
const CRASH_HEALTHY_UPTIME_MS = 30_000;
const MAX_CRASH_RESTARTS = 3;

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(__dirname, '..');

// Resolve tsx's actual JS entry and run it through `node` directly. We do NOT
// spawn the node_modules/.bin/tsx shim: on Windows that's a `.cmd`, and Node's
// child_process refuses to spawn `.cmd`/`.bat` with shell:false (throws
// EINVAL). Wrapping in shell:true would fix the spawn but orphan the real node
// process on kill (the shell dies, the child lives). Spawning `node <cli.mjs>`
// sidesteps both: cross-platform, and child.kill() hits the real process so
// graceful shutdown + sentinel restart work.
const require = createRequire(`${serverDir}/`);
const tsxCli = require.resolve('tsx/cli');

// Persist the child's stdout/stderr (and our own crash line) to a dated file so
// a future crash's reason survives — `stdio: 'inherit'` alone left it only in
// the terminal scrollback, which is how the 0xC0000374 native crash got lost.
const logDir = resolve(serverDir, '.dev-logs');
try {
  mkdirSync(logDir, { recursive: true });
} catch {
  /* best-effort */
}
const logPath = resolve(logDir, `server-${new Date().toISOString().slice(0, 10)}.log`);
const logStream = createWriteStream(logPath, { flags: 'a' });
function logLine(msg) {
  const line = `[${new Date().toISOString()}] [supervisor] ${msg}\n`;
  process.stderr.write(line);
  try {
    logStream.write(line);
  } catch {
    /* best-effort */
  }
}

// Dev-stack ports the server binds (locked: API 4040, channel 8788). The
// channel server has no EADDRINUSE retry, so a respawn that races the dying
// process's port release (or a lingering orphan that inherited the listening
// socket) crashes the fresh child with EADDRINUSE. Wait for both to free up
// before (re)spawning instead.
const BOUND_PORTS = [4040, 8788];
const PORT_FREE_TIMEOUT_MS = 12_000;
const PORT_PROBE_INTERVAL_MS = 300;

let child = null;
let signalled = false;
let backoffAttempt = 0;
let crashRestartCount = 0;
let startedAt = 0;

function nextDelay() {
  return Math.min(BACKOFF_BASE_MS * 2 ** backoffAttempt, BACKOFF_MAX_MS);
}

function portInUse(port) {
  return new Promise((resolve_) => {
    const sock = createConnection({ port, host: '127.0.0.1' });
    const finish = (inUse) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve_(inUse);
    };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false)); // refused = free
    setTimeout(() => finish(false), 250);
  });
}

async function waitForPortsFree() {
  const deadline = Date.now() + PORT_FREE_TIMEOUT_MS;
  while (Date.now() < deadline && !signalled) {
    const busy = (await Promise.all(BOUND_PORTS.map(portInUse))).some(Boolean);
    if (!busy) return true;
    await new Promise((r) => setTimeout(r, PORT_PROBE_INTERVAL_MS));
  }
  return false; // timed out — spawn anyway; the child's own EADDRINUSE handling decides
}

async function spawnChild() {
  if (signalled) return;
  // Don't bind until the previous process has released 4040/8788.
  if (!(await waitForPortsFree())) {
    logLine(`ports ${BOUND_PORTS.join('/')} still busy after ${PORT_FREE_TIMEOUT_MS}ms — spawning anyway`);
  }
  if (signalled) return;
  startedAt = Date.now();

  // `--report-on-fatalerror` covers the pre-boot window before src/diagnostics.ts
  // arms in-process report config. stdout/stderr are piped (not inherited) so we
  // can tee them to the log file while still showing them in the terminal.
  child = spawn(process.execPath, ['--report-on-fatalerror', tsxCli, 'src/index.ts'], {
    cwd: serverDir,
    stdio: ['inherit', 'pipe', 'pipe'],
    env: process.env,
    shell: false,
  });
  child.stdout.on('data', (b) => {
    process.stdout.write(b);
    try { logStream.write(b); } catch { /* best-effort */ }
  });
  child.stderr.on('data', (b) => {
    process.stderr.write(b);
    try { logStream.write(b); } catch { /* best-effort */ }
  });

  child.on('exit', (code, signal) => {
    child = null;

    if (signalled) {
      // We forwarded SIGINT/SIGTERM; exit cleanly.
      process.exit(0);
      return;
    }

    if (code === SENTINEL) {
      const uptime = Date.now() - startedAt;
      if (uptime >= MIN_UPTIME_RESET_MS) {
        backoffAttempt = 0;
      }
      const delay = nextDelay();
      backoffAttempt++;
      logLine(`intentional restart (exit 75) — respawning in ${delay}ms`);
      setTimeout(spawnChild, delay);
    } else {
      // Unexpected (non-75) exit = a crash. A healthy run resets the rapid-crash
      // budget; a crash before the healthy threshold counts toward the cap so a
      // boot failure can't crash-loop.
      const uptime = Date.now() - startedAt;
      if (uptime >= CRASH_HEALTHY_UPTIME_MS) crashRestartCount = 0;
      crashRestartCount++;
      if (crashRestartCount > MAX_CRASH_RESTARTS) {
        logLine(
          `child crashed: code=${code ?? 'null'} signal=${signal ?? 'none'} after ${uptime}ms — ${MAX_CRASH_RESTARTS} rapid crashes, giving up (log: ${logPath})`,
        );
        logStream.end();
        process.exit(typeof code === 'number' ? code : 1);
      }
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** (crashRestartCount - 1), BACKOFF_MAX_MS);
      logLine(
        `child crashed: code=${code ?? 'null'} signal=${signal ?? 'none'} after ${uptime}ms — auto-respawning in ${delay}ms (recovery ${crashRestartCount}/${MAX_CRASH_RESTARTS})`,
      );
      setTimeout(spawnChild, delay);
    }
  });
}

function forwardSignal(sig) {
  if (signalled) return;
  signalled = true;
  console.log(`[supervisor] ${sig} — forwarding to child`);
  if (child) {
    child.kill(sig);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

spawnChild();
