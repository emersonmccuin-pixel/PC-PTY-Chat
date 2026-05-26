// Section 20.A.2 — Boot-time .mcp.json rewriter tests.
//
// Covers: stale-npx rewrite, already-on-bundle no-op, missing file skip,
// malformed JSON skip, foreign pc-rig shape skip, trunk path preservation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyNodeLauncher,
  applyNodeLauncherToProjects,
  rewriteStaleMcpConfigs,
} from '../src/services/mcp-config-rewrite.ts';
import type { NodeLauncher } from '@pc/runtime';

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

// ── Section 10 Phase 1.4 — node-launcher application ───────────────────────

const DEV: NodeLauncher = { command: 'node', env: {} };
const PACKAGED: NodeLauncher = {
  command: 'C:/Apps/PC/ProjectCompanion.exe',
  env: { ELECTRON_RUN_AS_NODE: '1' },
};

interface McpFixture {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
}

/** A freshly-scaffolded `.mcp.json` shape: pc-rig + webhook on `node`. */
function scaffoldShape(): McpFixture {
  return {
    mcpServers: {
      'pc-rig': {
        command: 'node',
        args: ['E:/trunk/packages/mcp/dist/server.mjs'],
        env: { PC_PROJECT_ID: '01ABC' },
      },
      webhook: {
        command: 'node',
        args: ['E:/trunk/channel-server/server.js'],
        env: { CHANNEL_PORT: '8788' },
      },
    },
  };
}

test('applyNodeLauncher: dev launcher is a no-op on a fresh scaffold', () => {
  const config = scaffoldShape();
  assert.equal(applyNodeLauncher(config, DEV), false);
  assert.equal(config.mcpServers['pc-rig'].command, 'node');
  assert.equal(config.mcpServers.webhook.command, 'node');
});

test('applyNodeLauncher: packaged launcher rewrites both PC node servers + merges env', () => {
  const config = scaffoldShape();
  assert.equal(applyNodeLauncher(config, PACKAGED), true);
  for (const key of ['pc-rig', 'webhook'] as const) {
    assert.equal(config.mcpServers[key].command, 'C:/Apps/PC/ProjectCompanion.exe');
    assert.equal(config.mcpServers[key].env.ELECTRON_RUN_AS_NODE, '1');
  }
  // existing env preserved
  assert.equal(config.mcpServers['pc-rig'].env.PC_PROJECT_ID, '01ABC');
});

test('applyNodeLauncher: foreign (non-PC) servers are never touched', () => {
  const config = {
    mcpServers: {
      'pc-rig': { command: 'node', args: ['E:/trunk/packages/mcp/dist/server.mjs'], env: {} },
      python: { command: 'python', args: ['-m', 'my_mcp'], env: { FOO: 'bar' } },
    },
  };
  applyNodeLauncher(config, PACKAGED);
  assert.equal(config.mcpServers.python.command, 'python');
  assert.equal(config.mcpServers.python.env.FOO, 'bar');
  assert.ok(!('ELECTRON_RUN_AS_NODE' in config.mcpServers.python.env));
});

test('applyNodeLauncher: packaged→dev strips stale ELECTRON_RUN_AS_NODE + restores node', () => {
  const config: McpFixture = {
    mcpServers: {
      'pc-rig': {
        command: 'C:/old/ProjectCompanion.exe',
        args: ['C:/res/packages/mcp/dist/server.mjs'],
        env: { ELECTRON_RUN_AS_NODE: '1', PC_PROJECT_ID: '01ABC' },
      },
    },
  };
  assert.equal(applyNodeLauncher(config, DEV), true);
  assert.equal(config.mcpServers['pc-rig'].command, 'node');
  assert.ok(!('ELECTRON_RUN_AS_NODE' in config.mcpServers['pc-rig'].env));
  assert.equal(config.mcpServers['pc-rig'].env.PC_PROJECT_ID, '01ABC');
});

test('applyNodeLauncher: idempotent under packaged launcher', () => {
  const config = scaffoldShape();
  assert.equal(applyNodeLauncher(config, PACKAGED), true);
  assert.equal(applyNodeLauncher(config, PACKAGED), false);
});

test('applyNodeLauncherToProjects: writes only changed files, skips missing', () => {
  const a = fixture();
  writeMcp(a, scaffoldShape());
  const b = fixture(); // no .mcp.json

  const result = applyNodeLauncherToProjects([a, b], PACKAGED);
  assert.equal(result.rewritten.length, 1);
  assert.equal(result.rewritten[0], a);
  assert.equal(result.skipped.find((s) => s.folderPath === b)?.reason, 'no .mcp.json');

  const after = JSON.parse(readFileSync(join(a, '.mcp.json'), 'utf-8')) as ReturnType<
    typeof scaffoldShape
  >;
  assert.equal(after.mcpServers['pc-rig'].command, 'C:/Apps/PC/ProjectCompanion.exe');

  // second pass = no writes
  assert.equal(applyNodeLauncherToProjects([a], PACKAGED).rewritten.length, 0);
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
});
