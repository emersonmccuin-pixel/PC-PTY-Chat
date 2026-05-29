import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePodMcpServerConfig } from '../src/services/pod-mcp-config.ts';

test('parsePodMcpServerConfig accepts stdio and URL config fields', () => {
  assert.deepEqual(
    parsePodMcpServerConfig({
      command: 'node',
      args: ['server.mjs'],
      env: { TOKEN: 'abc' },
      url: 'http://localhost:3000/mcp',
      ignored: true,
    }),
    {
      command: 'node',
      args: ['server.mjs'],
      env: { TOKEN: 'abc' },
      url: 'http://localhost:3000/mcp',
    },
  );
});

test('parsePodMcpServerConfig rejects non-object config', () => {
  assert.throws(
    () => parsePodMcpServerConfig(null),
    /mcp server config must be an object/,
  );
});

test('parsePodMcpServerConfig rejects invalid field shapes', () => {
  assert.throws(
    () => parsePodMcpServerConfig({ command: 123 }),
    /mcp\.command must be a string/,
  );
  assert.throws(
    () => parsePodMcpServerConfig({ args: ['ok', 123] }),
    /mcp\.args must be string\[\]/,
  );
  assert.throws(
    () => parsePodMcpServerConfig({ env: [] }),
    /mcp\.env must be an object of string=string/,
  );
  assert.throws(
    () => parsePodMcpServerConfig({ env: { TOKEN: 123 } }),
    /mcp\.env\.TOKEN must be a string/,
  );
  assert.throws(
    () => parsePodMcpServerConfig({ url: 123 }),
    /mcp\.url must be a string/,
  );
});
