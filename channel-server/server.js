// Per-project webhook channel bridge. Spawned by each project's claude.exe
// via its .mcp.json (one process per CC). Connects WS-upstream to apps/server's
// /channel-register endpoint to receive routed events, then re-emits them as
// `notifications/claude/channel` MCP messages over stdio to its CC.
//
// HTTP receiver moved out of this process per multi-tenant design — apps/server
// now owns the single :8788 listener and routes by project slug. See
// docs/design/multi-tenancy.md §3.
//
// Required env (set by the per-project .mcp.json substitution):
//   PC_PROJECT_ID  — ULID, registered with the dispatcher
//   PC_PROJECT_SLUG — slug, registered with the dispatcher
//   PC_SERVER_PORT — apps/server HTTP port (default 4040)

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import WebSocket from 'ws';

const PROJECT_ID = process.env.PC_PROJECT_ID ?? '';
const PROJECT_SLUG = process.env.PC_PROJECT_SLUG ?? '';
const SERVER_PORT = Number(process.env.PC_SERVER_PORT ?? 4040);

const mcp = new Server(
  { name: 'webhook', version: '0.0.1' },
  {
    capabilities: { experimental: { 'claude/channel': {} } },
    instructions:
      'Events from the webhook channel arrive as <channel source="webhook" ...>. ' +
      'They are one-way: read them and act, no reply expected.',
  },
);

await mcp.connect(new StdioServerTransport());

const log = (...args) => process.stderr.write('[webhook] ' + args.join(' ') + '\n');

if (!PROJECT_ID || !PROJECT_SLUG) {
  log('PC_PROJECT_ID and PC_PROJECT_SLUG required — exiting');
  process.exit(1);
}

let ws = null;
let reconnectTimer = null;

function connect() {
  const url = `ws://127.0.0.1:${SERVER_PORT}/channel-register?projectId=${encodeURIComponent(PROJECT_ID)}&slug=${encodeURIComponent(PROJECT_SLUG)}`;
  log(`connecting to ${url}`);
  ws = new WebSocket(url);

  ws.on('open', () => log('registered with dispatcher'));
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type !== 'channel-event') return;
    try {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: msg.content ?? '',
          meta: { path: msg.path ?? '/', method: msg.method ?? 'POST', source: msg.source ?? 'webhook' },
        },
      });
      log(`FORWARD ${(msg.content ?? '').slice(0, 80)}`);
    } catch (err) {
      log(`forward failed: ${err.message}`);
    }
  });
  ws.on('close', () => {
    log('disconnected — retrying in 2s');
    scheduleReconnect();
  });
  ws.on('error', (err) => {
    log(`ws error: ${err.message}`);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
  reconnectTimer.unref?.();
}

connect();
