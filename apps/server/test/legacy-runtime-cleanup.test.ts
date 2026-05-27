import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { cleanupLegacyProjectRuntimeFiles } from '../src/services/legacy-runtime-cleanup.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'pc-legacy-runtime-cleanup-'));

function fixture(name: string): { dataDir: string; folderPath: string; projectId: string } {
  const root = resolve(tmpRoot, name);
  const dataDir = resolve(root, 'data');
  const folderPath = resolve(root, 'project');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(folderPath, { recursive: true });
  return { dataDir, folderPath, projectId: `proj-${name}` };
}

function runCleanup(f: { dataDir: string; folderPath: string; projectId: string }) {
  return cleanupLegacyProjectRuntimeFiles(
    [{ id: f.projectId, slug: 'example', folderPath: f.folderPath }],
    { dataDir: f.dataDir, now: () => new Date('2026-05-26T12:00:00.000Z') },
  );
}

test('removes PC-only .mcp.json and backs it up outside the project root', () => {
  const f = fixture('pc-only-mcp');
  writeFileSync(
    resolve(f.folderPath, '.mcp.json'),
    JSON.stringify(
      {
        mcpServers: {
          'pc-rig': {
            command: 'node',
            args: ['E:/PC/packages/mcp/dist/server.mjs'],
            env: { PC_PROJECT_ID: f.projectId, PC_PROJECT_SLUG: 'example' },
          },
          webhook: {
            command: 'node',
            args: ['E:/PC/channel-server/server.js'],
            env: { PC_PROJECT_ID: f.projectId, CHANNEL_PORT: '8788' },
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  const result = runCleanup(f);

  assert.equal(existsSync(resolve(f.folderPath, '.mcp.json')), false);
  assert.equal(result.removed.length, 1);
  assert.match(result.removed[0]!.backupPath, /legacy-claude-runtime/);
  assert.equal(existsSync(result.removed[0]!.backupPath), true);
});

test('rewrites mixed .mcp.json by removing only PC-owned servers', () => {
  const f = fixture('mixed-mcp');
  writeFileSync(
    resolve(f.folderPath, '.mcp.json'),
    JSON.stringify(
      {
        mcpServers: {
          'pc-rig': {
            command: 'node',
            args: ['E:/PC/packages/mcp/src/server.ts'],
            env: { PC_PROJECT_ID: f.projectId },
          },
          snowflake: {
            command: 'snowflake-mcp',
            args: ['--stdio'],
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  const result = runCleanup(f);
  const next = JSON.parse(readFileSync(resolve(f.folderPath, '.mcp.json'), 'utf8'));

  assert.equal(result.rewritten.length, 1);
  assert.deepEqual(Object.keys(next.mcpServers), ['snowflake']);
  assert.equal(next.mcpServers.snowflake.command, 'snowflake-mcp');
});

test('removes PC settings, hooks, and PC agent files while keeping user .claude content', () => {
  const f = fixture('claude-config');
  const claudeDir = resolve(f.folderPath, '.claude');
  mkdirSync(resolve(claudeDir, 'hooks'), { recursive: true });
  mkdirSync(resolve(claudeDir, 'agents'), { recursive: true });
  mkdirSync(resolve(claudeDir, 'skills'), { recursive: true });
  writeFileSync(resolve(claudeDir, 'skills', 'user.md'), '# user skill\n', 'utf8');
  writeFileSync(
    resolve(claudeDir, 'settings.json'),
    JSON.stringify(
      {
        permissions: {
          allow: ['Read', 'Glob', 'Grep', 'Bash(echo:*)', 'Bash(node:*)'],
          deny: ['Bash(rm:*)', 'Bash(del:*)', 'Bash(format:*)'],
        },
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node "E:/project/.claude/hooks/path-guard.cjs" enforce',
                },
              ],
            },
          ],
        },
        statusLine: {
          type: 'command',
          command: 'node "E:/project/.claude/hooks/pc-statusline.cjs"',
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(
    resolve(claudeDir, 'hooks', 'path-guard.cjs'),
    'const PROJECT_DATA_DIR = "x";\n',
    'utf8',
  );
  writeFileSync(
    resolve(claudeDir, 'agents', 'orchestrator.md'),
    'tools: mcp__pc-rig__pc_invoke_agent\n',
    'utf8',
  );

  const result = runCleanup(f);

  assert.equal(existsSync(resolve(claudeDir, 'settings.json')), false);
  assert.equal(existsSync(resolve(claudeDir, 'hooks', 'path-guard.cjs')), false);
  assert.equal(existsSync(resolve(claudeDir, 'agents', 'orchestrator.md')), false);
  assert.equal(existsSync(resolve(claudeDir, 'skills', 'user.md')), true);
  assert.equal(result.removed.some((c) => c.path === '.claude/settings.json'), true);
  assert.equal(result.removed.some((c) => c.path === '.claude/hooks/path-guard.cjs'), true);
  assert.equal(result.removed.some((c) => c.path === '.claude/agents/orchestrator.md'), true);
});

test('leaves user-owned Claude and MCP config alone', () => {
  const f = fixture('user-owned');
  mkdirSync(resolve(f.folderPath, '.claude'), { recursive: true });
  writeFileSync(
    resolve(f.folderPath, '.mcp.json'),
    JSON.stringify({ mcpServers: { custom: { command: 'custom-mcp' } } }, null, 2),
    'utf8',
  );
  writeFileSync(
    resolve(f.folderPath, '.claude', 'settings.json'),
    JSON.stringify({ model: 'sonnet', permissions: { allow: ['Bash(git status)'] } }, null, 2),
    'utf8',
  );

  const result = runCleanup(f);

  assert.equal(result.removed.length, 0);
  assert.equal(result.rewritten.length, 0);
  assert.equal(existsSync(resolve(f.folderPath, '.mcp.json')), true);
  assert.equal(existsSync(resolve(f.folderPath, '.claude', 'settings.json')), true);
});

process.on('beforeExit', () => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
