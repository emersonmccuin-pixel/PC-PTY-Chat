// Agent host — server-side connect + spawn-if-not-running.
//
// Phase 1: connect to the host on the control port; if nothing is listening,
// best-effort spawn host-main detached, then retry. Returns a process-wide
// HostClient singleton the dispatch factory reads via getAgentHostClient().
//
// Detachment hardening (Windows job-object exclusion so the host outlives an
// Electron-main crash) + idle-reap + packaged-bundle launch are phase 3 — the
// dev launch here runs host-main.ts through tsx, mirroring dev-supervisor.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

import { HostClient } from '@pc/runtime';

import { agentHostPort } from './constants.ts';
import { clientSideChannel } from './ws-channel.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

let singleton: HostClient | null = null;

/** Current host client, or null when the host is disabled / not yet connected. */
export function getAgentHostClient(): HostClient | null {
  return singleton;
}

export interface InitAgentHostOptions {
  /** Spawn the host if nothing is already listening. Default true. */
  autoSpawn?: boolean;
  /** Total connect-retry budget after a spawn. Default ~12s. */
  connectAttempts?: number;
  connectDelayMs?: number;
}

export async function initAgentHostClient(
  opts: InitAgentHostOptions = {},
): Promise<HostClient> {
  if (singleton) return singleton;
  const port = agentHostPort();

  let ws = await tryConnect(port);
  if (!ws && (opts.autoSpawn ?? true)) {
    spawnHostDetached(port);
    ws = await connectWithRetry(port, opts.connectAttempts ?? 48, opts.connectDelayMs ?? 250);
  }
  if (!ws) {
    throw new Error(`agent-host: could not connect on 127.0.0.1:${port}`);
  }

  const client = new HostClient(clientSideChannel(ws));
  ws.on('close', () => {
    client.shutdown();
    if (singleton === client) singleton = null;
  });
  singleton = client;
  console.log(`[agent-host] connected on 127.0.0.1:${port}`);
  return client;
}

/** Resolve once with an open socket, or null on error/timeout. */
function tryConnect(port: number, timeoutMs = 1000): Promise<WebSocket | null> {
  return new Promise((resolveP) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const done = (val: WebSocket | null): void => {
      clearTimeout(timer);
      ws.off('open', onOpen);
      ws.off('error', onError);
      if (!val) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      resolveP(val);
    };
    const onOpen = (): void => done(ws);
    const onError = (): void => done(null);
    const timer = setTimeout(() => done(null), timeoutMs);
    ws.on('open', onOpen);
    ws.on('error', onError);
  });
}

async function connectWithRetry(
  port: number,
  attempts: number,
  delayMs: number,
): Promise<WebSocket | null> {
  for (let i = 0; i < attempts; i++) {
    const ws = await tryConnect(port);
    if (ws) return ws;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

/** Best-effort detached spawn of host-main. Dev path: run the .ts through tsx
 *  the same way dev-supervisor runs the server. */
function spawnHostDetached(port: number): void {
  const require = createRequire(`${__dirname}/`);
  let tsxCli: string;
  try {
    tsxCli = require.resolve('tsx/cli');
  } catch (err) {
    console.error(
      `[agent-host] cannot resolve tsx to launch host: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  const hostEntry = resolve(__dirname, 'host-main.ts');
  const child = spawn(process.execPath, [tsxCli, hostEntry], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      PC_AGENT_HOST_PORT: String(port),
    },
  });
  child.unref();
  console.log(`[agent-host] launched host (pid ${child.pid}) on port ${port}`);
}
