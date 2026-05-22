// Section 20.A.2 — Boot-time .mcp.json rewriter tests.
//
// Covers: stale-npx rewrite, already-on-bundle no-op, missing file skip,
// malformed JSON skip, foreign pc-rig shape skip, trunk path preservation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rewriteStaleMcpConfigs } from '../src/services/mcp-config-rewrite.ts';

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pc-mcp-rewrite-'));
  return dir;
}

function writeMcp(folder: string, body: unknown): string {
  mkdirSync(folder, { recursive: true });
  const path = join(folder, '.mcp.json');
  writeFileSync(path, JSON.stringify(body, null, 2), 'utf-8');
  return path;
}

test('rewrites stale npx -y tsx to node bundle, preserving trunk path + env', () => {
  const folder = fixture();
  const path = writeMcp(folder, {
    mcpServers: {
      'pc-rig': {
        command: 'npx',
        args: ['-y', 'tsx', 'E:/Projects/Caisson/packages/mcp/src/server.ts'],
        env: { PC_PROJECT_ID: '01ABC', PC_PROJECT_SLUG: 'demo', PC_SERVER_PORT: '4040' },
      },
      webhook: { command: 'node', args: ['somewhere/server.js'] },
    },
  });

  const result = rewriteStaleMcpConfigs([folder]);
  assert.equal(result.rewritten.length, 1);
  assert.equal(result.rewritten[0], folder);

  const after = JSON.parse(readFileSync(path, 'utf-8')) as {
    mcpServers: { 'pc-rig': { command: string; args: string[]; env: Record<string, string> } };
  };
  assert.equal(after.mcpServers['pc-rig'].command, 'node');
  assert.deepEqual(after.mcpServers['pc-rig'].args, [
    'E:/Projects/Caisson/packages/mcp/dist/server.mjs',
  ]);
  assert.equal(after.mcpServers['pc-rig'].env.PC_PROJECT_ID, '01ABC');
  rmSync(folder, { recursive: true, force: true });
});

test('no-op when pc-rig already on bundle path', () => {
  const folder = fixture();
  const path = writeMcp(folder, {
    mcpServers: {
      'pc-rig': {
        command: 'node',
        args: ['E:/some/trunk/packages/mcp/dist/server.mjs'],
        env: {},
      },
    },
  });
  const before = readFileSync(path, 'utf-8');

  const result = rewriteStaleMcpConfigs([folder]);
  assert.equal(result.rewritten.length, 0);
  assert.equal(readFileSync(path, 'utf-8'), before);
  rmSync(folder, { recursive: true, force: true });
});

test('skips when .mcp.json missing', () => {
  const folder = fixture();
  const result = rewriteStaleMcpConfigs([folder]);
  assert.equal(result.rewritten.length, 0);
  assert.equal(result.skipped[0]?.reason, 'no .mcp.json');
  rmSync(folder, { recursive: true, force: true });
});

test('skips malformed JSON without throwing', () => {
  const folder = fixture();
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, '.mcp.json'), '{ this is not json', 'utf-8');
  const result = rewriteStaleMcpConfigs([folder]);
  assert.equal(result.rewritten.length, 0);
  assert.equal(result.skipped[0]?.reason, 'malformed JSON');
  rmSync(folder, { recursive: true, force: true });
});

test('skips when pc-rig entry missing', () => {
  const folder = fixture();
  writeMcp(folder, { mcpServers: { webhook: { command: 'node', args: [] } } });
  const result = rewriteStaleMcpConfigs([folder]);
  assert.equal(result.rewritten.length, 0);
  assert.equal(result.skipped[0]?.reason, 'no pc-rig entry');
  rmSync(folder, { recursive: true, force: true });
});

test('idempotent on second call', () => {
  const folder = fixture();
  const path = writeMcp(folder, {
    mcpServers: {
      'pc-rig': {
        command: 'npx',
        args: ['-y', 'tsx', '/x/y/packages/mcp/src/server.ts'],
        env: {},
      },
    },
  });
  const first = rewriteStaleMcpConfigs([folder]);
  assert.equal(first.rewritten.length, 1);
  const afterFirst = readFileSync(path, 'utf-8');
  const second = rewriteStaleMcpConfigs([folder]);
  assert.equal(second.rewritten.length, 0);
  assert.equal(readFileSync(path, 'utf-8'), afterFirst);
  rmSync(folder, { recursive: true, force: true });
});
