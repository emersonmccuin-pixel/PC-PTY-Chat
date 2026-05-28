#!/usr/bin/env node
// DEV-ONLY supervisor for apps/server.
//
// Spawns `tsx src/index.ts` and respawns the child when it exits with sentinel
// code 75 (intentional restart requested via POST /api/dev/restart).
// Unexpected exits (non-75) are logged and the supervisor exits — no
// crash-loop respawn.
//
// Backoff: rapid sentinel-restarts (server dies in < 5s) accumulate a
// capped delay so a boot-time crash doesn't spin tightly.
//
// Signal forwarding: SIGINT/SIGTERM are forwarded to the child; once the
// child exits the supervisor exits cleanly (no respawn).

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SENTINEL = 75;
const MIN_UPTIME_RESET_MS = 5_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8_000;

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

let child = null;
let signalled = false;
let backoffAttempt = 0;
let startedAt = 0;

function nextDelay() {
  return Math.min(BACKOFF_BASE_MS * 2 ** backoffAttempt, BACKOFF_MAX_MS);
}

function spawnChild() {
  if (signalled) return;
  startedAt = Date.now();

  child = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
    cwd: serverDir,
    stdio: 'inherit',
    env: process.env,
    shell: false,
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
      console.log(
        `[supervisor] intentional restart (exit 75) — respawning in ${delay}ms`,
      );
      setTimeout(spawnChild, delay);
    } else {
      console.error(
        `[supervisor] child exited unexpectedly: code=${code ?? 'null'} signal=${signal ?? 'none'} — not respawning`,
      );
      process.exit(typeof code === 'number' ? code : 1);
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
