// One-command dev launcher for the Caisson Dev desktop app.
//
//   pnpm dev:app
//
// Boots the three dev processes in the right order and tears them all down
// together on Ctrl+C, so dogfooding the live app is a single command:
//
//   1. backend + MCP   — `pnpm dev` (server runs under the manual-restart
//                         supervisor; MCP builds/watches)
//   2. web UI          — `pnpm --filter @pc/web dev` (Vite, HMR on :5173)
//   3. desktop shell   — `pnpm desktop:dev` (Electron "Caisson Dev" window),
//                         launched only AFTER Vite answers on :5173 so the
//                         window never opens to a blank/failed load.
//
// Zero extra dependencies — just Node's child_process + fetch. Cross-platform
// via shell:true (resolves pnpm / pnpm.cmd on Windows).

import { spawn } from 'node:child_process';

const VITE_URL = 'http://127.0.0.1:5173';
const VITE_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

const children = [];
let shuttingDown = false;

/** Spawn a labelled child, inheriting stdio so logs interleave in this terminal. */
function run(label, command) {
  const child = spawn(command, {
    shell: true,
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    // If any pillar process dies on its own, bring the whole stack down so the
    // dev isn't left with a half-running app.
    console.error(`\n[dev:app] "${label}" exited (code=${code} signal=${signal}) — shutting down.`);
    shutdown(code ?? 1);
  });
  children.push({ label, child });
  return child;
}

/** Poll Vite until it answers (or time out). */
async function waitForVite() {
  const deadline = Date.now() + VITE_TIMEOUT_MS;
  process.stdout.write('[dev:app] waiting for Vite on :5173 ');
  while (Date.now() < deadline) {
    try {
      const res = await fetch(VITE_URL, { method: 'HEAD' });
      if (res.ok || res.status === 404) {
        process.stdout.write(' up.\n');
        return true;
      }
    } catch {
      // not up yet
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  process.stdout.write('\n');
  return false;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error('[dev:app] stopping all dev processes…');
  for (const { child } of children) {
    if (child.exitCode === null && !child.killed) {
      // SIGINT lets the server supervisor + Electron tear down cleanly.
      child.kill('SIGINT');
    }
  }
  // Give children a moment to exit gracefully, then hard-exit.
  setTimeout(() => process.exit(code), 1_500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main() {
  console.error('[dev:app] starting backend + MCP and web UI…');
  run('backend+mcp', 'pnpm dev');
  run('web', 'pnpm --filter @pc/web dev');

  const ready = await waitForVite();
  if (shuttingDown) return;
  if (!ready) {
    console.error('[dev:app] Vite did not come up within 60s — opening the window anyway (it will retry on reload).');
  }

  console.error('[dev:app] launching Caisson Dev window…');
  run('desktop', 'pnpm desktop:dev');
}

main().catch((err) => {
  console.error('[dev:app] launcher error:', err);
  shutdown(1);
});
