// Agent host — standalone process entry.
//
// Long-lived process that owns every node-pty / claude.exe child. Runs apart
// from the API server so a server crash/restart leaves agents alive, and a
// native node-pty crash (0xC0000374) isolates here instead of taking down the
// API/UI. See docs/out-of-process-agent-host-design.md.
//
// Phase 1: one AgentHost per connected client. Reattach across reconnect
// (phase 2) and detached ownership + idle-reap (phase 3) build on this.
//
// Launched detached by the API server's host-launcher (or manually in dev:
//   PC_AGENT_HOST_PORT=8790 node <tsx cli> apps/server/src/agent-host/host-main.ts
// ). PC_DIAG_DIR is honored by LowLevelSpawn's pty-lifecycle log if set.

import { WebSocketServer } from 'ws';

import { AgentHost } from '@pc/runtime';

import { agentHostPort } from './constants.ts';
import { hostSideChannel } from './ws-channel.ts';

const PORT = agentHostPort();

const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });

wss.on('listening', () => {
  console.log(`[agent-host] listening on 127.0.0.1:${PORT} (pid ${process.pid})`);
});

wss.on('connection', (ws) => {
  console.log('[agent-host] client connected');
  const channel = hostSideChannel(ws);
  const host = new AgentHost({ send: (msg) => channel.send(msg) });
  const unsubscribe = channel.subscribe((msg) => host.handle(msg));
  ws.on('close', () => {
    unsubscribe();
    console.log(`[agent-host] client disconnected (${host.size()} spawn(s) still live)`);
  });
  ws.on('error', (err) => {
    console.error(`[agent-host] socket error: ${err instanceof Error ? err.message : String(err)}`);
  });
});

wss.on('error', (err) => {
  console.error(`[agent-host] server error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

// Keep the process alive on its own; the launcher manages lifetime. Idle-reap
// (no live PTYs + no client for N minutes → exit) lands in phase 3.
process.on('SIGTERM', () => {
  console.log('[agent-host] SIGTERM — shutting down');
  wss.close(() => process.exit(0));
});
