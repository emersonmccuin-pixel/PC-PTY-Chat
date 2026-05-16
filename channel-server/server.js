// Vendored from PC-Validation/shared/channel-server/server.js (no changes).
// Itself a Node port of the canonical webhook channel server example at
// https://code.claude.com/docs/en/channels-reference#example-build-a-webhook-receiver
// Listens on 127.0.0.1:8788 for POSTs; forwards each to Claude Code as a
// `notifications/claude/channel` event over stdio (MCP transport).
//
// Gating: `X-Sender` header must be in the `allowed` set. Default allowlist
// is just "test" — the rig's /api/channel-send proxy sets this for us.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from 'node:http';

const PORT = Number(process.env.CHANNEL_PORT ?? 8788);
const allowed = new Set((process.env.CHANNEL_ALLOWED_SENDERS ?? 'test').split(','));

const mcp = new Server(
  { name: 'webhook', version: '0.0.1' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
    },
    instructions:
      'Events from the webhook channel arrive as <channel source="webhook" ...>. ' +
      'They are one-way: read them and act, no reply expected.',
  },
);

await mcp.connect(new StdioServerTransport());

// stderr is the only safe place to log — stdout is the MCP transport.
const log = (...args) => process.stderr.write('[webhook] ' + args.join(' ') + '\n');

const httpServer = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf-8');

  const sender = req.headers['x-sender'];
  if (typeof sender !== 'string' || !allowed.has(sender)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    log(`REJECT sender=${sender ?? '<missing>'}`);
    return;
  }

  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: body,
      meta: { path: req.url ?? '/', method: req.method ?? 'POST' },
    },
  });

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
  log(`FORWARD ${body.slice(0, 80)}`);
});

httpServer.listen(PORT, '127.0.0.1', () => {
  log(`listening on 127.0.0.1:${PORT}`);
});
