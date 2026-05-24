// Section 17a.5 unit tests — pod-spawn helper.
//
// Verifies preparePodSpawn's contract: returns null when no pod row exists
// for the agent name; materialises into worktreeDir + scratchDir when one
// does; merges the project's existing .mcp.json as the baseline; threads
// secrets through `extraEnv`; cleanup() removes the temp files.
//
// Run via:  pnpm --filter @pc/server test

import { test, before, after } from 'node:test';
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

const tmpDataDir = mkdtempSync(join(tmpdir(), 'pc-pod-spawn-db-'));
process.env.PC_DATA_DIR = tmpDataDir;

const {
  closeDb,
  runMigrations,
  createAgent,
  createKnowledge,
  createSecret,
  createMcpServer,
} = await import('@pc/db');
import type { AuditInput } from '@pc/db';
import { mergeRequiredAgentTools } from '@pc/domain';
import { preparePodSpawn } from '../src/services/pod-spawn.ts';

const U: AuditInput = { actor: 'user' };

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

function freshDirs(): {
  worktree: string;
  scratch: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'pc-pod-spawn-fs-'));
  const worktree = join(root, 'worktree');
  const scratch = join(root, 'scratch');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  return {
    worktree,
    scratch,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    },
  };
}

function writeProjectMcpJson(worktreeDir: string): void {
  writeFileSync(
    resolve(worktreeDir, '.mcp.json'),
    JSON.stringify(
      {
        mcpServers: {
          'pc-rig': {
            command: 'node',
            args: ['/path/to/pc-rig.mjs'],
            env: { PC_PROJECT_ID: 'p1' },
          },
          webhook: { command: 'node', args: ['/path/to/webhook.mjs'] },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

// --- null return ------------------------------------------------------------

test('preparePodSpawn returns null when no pod row matches the agent name', () => {
  const dirs = freshDirs();
  try {
    const prep = preparePodSpawn({
      agentName: 'definitely-no-pod-for-this-name',
      worktreeDir: dirs.worktree,
      scratchDir: dirs.scratch,
    });
    assert.equal(prep, null);
    // No materialisation side-effect.
    assert.ok(!existsSync(resolve(dirs.worktree, '.claude', 'agents')));
    assert.ok(!existsSync(resolve(dirs.scratch, 'mcp.json')));
  } finally {
    dirs.cleanup();
  }
});

// --- materialisation with baseline merge -----------------------------------

test('preparePodSpawn materialises the pod + merges baseline .mcp.json', () => {
  const dirs = freshDirs();
  try {
    writeProjectMcpJson(dirs.worktree);
    const agent = createAgent(
      {
        name: 'pod-spawn-baseline',
        scope: 'global',
        prompt: 'do stuff',
        tools: ['Read', 'Grep'],
        model: 'sonnet',
      },
      U,
    );
    createMcpServer(
      {
        agentId: agent.id,
        scope: 'global',
        name: 'jira',
        config: { command: 'jira-mcp', env: { JIRA_HOST: 'example.com' } },
      },
      U,
    );

    const prep = preparePodSpawn({
      agentName: 'pod-spawn-baseline',
      worktreeDir: dirs.worktree,
      scratchDir: dirs.scratch,
    });
    assert.ok(prep);

    // Agent .md lands in the worktree's .claude/agents/.
    const mdPath = resolve(dirs.worktree, '.claude', 'agents', 'pod-spawn-baseline.md');
    assert.ok(existsSync(mdPath));
    const md = readFileSync(mdPath, 'utf8');
    assert.match(md, /\nname: pod-spawn-baseline\n/);
    // Section 26: the materializer merges in the required work-item tools.
    const expectedTools = mergeRequiredAgentTools(['Read', 'Grep']).join(', ');
    assert.match(md, new RegExp(`\\ntools: ${expectedTools}\\n`));
    assert.match(md, /\nmodel: sonnet\n/);
    assert.match(md, /\n\ndo stuff/);

    // mcp.json lands in scratchDir + merges baseline + pod servers.
    assert.equal(prep.mcpConfigPath, resolve(dirs.scratch, 'mcp.json'));
    const mcp = JSON.parse(readFileSync(prep.mcpConfigPath, 'utf8'));
    // Baseline survives:
    assert.equal(mcp.mcpServers['pc-rig'].command, 'node');
    assert.equal(mcp.mcpServers['pc-rig'].env.PC_PROJECT_ID, 'p1');
    assert.equal(mcp.mcpServers.webhook.command, 'node');
    // Pod row added:
    assert.equal(mcp.mcpServers.jira.command, 'jira-mcp');
  } finally {
    dirs.cleanup();
  }
});

test('preparePodSpawn lets pod MCP rows override baseline by name', () => {
  const dirs = freshDirs();
  try {
    writeProjectMcpJson(dirs.worktree);
    const agent = createAgent(
      { name: 'pod-mcp-override', scope: 'global' },
      U,
    );
    // Pod declares its own pc-rig — wins over baseline.
    createMcpServer(
      {
        agentId: agent.id,
        scope: 'global',
        name: 'pc-rig',
        config: { command: 'pod-override', args: ['x'] },
      },
      U,
    );

    const prep = preparePodSpawn({
      agentName: 'pod-mcp-override',
      worktreeDir: dirs.worktree,
      scratchDir: dirs.scratch,
    });
    assert.ok(prep);
    const mcp = JSON.parse(readFileSync(prep.mcpConfigPath, 'utf8'));
    assert.equal(mcp.mcpServers['pc-rig'].command, 'pod-override');
    // webhook from baseline still there.
    assert.equal(mcp.mcpServers.webhook.command, 'node');
  } finally {
    dirs.cleanup();
  }
});

test('preparePodSpawn works with no baseline .mcp.json on disk', () => {
  const dirs = freshDirs();
  try {
    // No writeProjectMcpJson — worktree has no .mcp.json.
    const agent = createAgent(
      { name: 'pod-no-baseline', scope: 'global' },
      U,
    );
    createMcpServer(
      {
        agentId: agent.id,
        scope: 'global',
        name: 'jira',
        config: { command: 'jira-mcp' },
      },
      U,
    );

    const prep = preparePodSpawn({
      agentName: 'pod-no-baseline',
      worktreeDir: dirs.worktree,
      scratchDir: dirs.scratch,
    });
    assert.ok(prep);
    const mcp = JSON.parse(readFileSync(prep.mcpConfigPath, 'utf8'));
    assert.deepEqual(Object.keys(mcp.mcpServers), ['jira']);
  } finally {
    dirs.cleanup();
  }
});

// --- secrets ----------------------------------------------------------------

test('preparePodSpawn returns secret env-var map in extraEnv', () => {
  const dirs = freshDirs();
  try {
    const agent = createAgent({ name: 'pod-secrets', scope: 'global' }, U);
    createSecret(
      {
        agentId: agent.id,
        scope: 'global',
        envVarName: 'JIRA_TOKEN',
        valuePlaintext: 'jt-secret',
      },
      U,
    );
    createSecret(
      {
        agentId: agent.id,
        scope: 'global',
        envVarName: 'OPENAI_KEY',
        valuePlaintext: 'sk-secret',
      },
      U,
    );
    const prep = preparePodSpawn({
      agentName: 'pod-secrets',
      worktreeDir: dirs.worktree,
      scratchDir: dirs.scratch,
    });
    assert.ok(prep);
    assert.deepEqual(prep.extraEnv, {
      JIRA_TOKEN: 'jt-secret',
      OPENAI_KEY: 'sk-secret',
    });
  } finally {
    dirs.cleanup();
  }
});

// --- wildcard expansion (pc-rig catalog) -----------------------------------

test('preparePodSpawn expands mcp__pc-rig__* via the static catalog', () => {
  const dirs = freshDirs();
  try {
    createAgent(
      {
        name: 'pod-wildcard',
        scope: 'global',
        tools: ['Read', 'mcp__pc-rig__*'],
      },
      U,
    );
    const prep = preparePodSpawn({
      agentName: 'pod-wildcard',
      worktreeDir: dirs.worktree,
      scratchDir: dirs.scratch,
    });
    assert.ok(prep);
    const md = readFileSync(
      resolve(dirs.worktree, '.claude', 'agents', 'pod-wildcard.md'),
      'utf8',
    );
    // Read survives; wildcard expanded into a comma-separated list of pc-rig
    // tool names. We don't pin every tool name (catalog drifts) but the
    // expanded list must contain pc_log (load-bearing fixture entry).
    assert.match(md, /\ntools: Read, mcp__pc-rig__pc_log/);
    // No raw wildcard escapes into the .md.
    assert.ok(!md.includes('mcp__pc-rig__*'));
  } finally {
    dirs.cleanup();
  }
});

// --- knowledge footer surfaced on spawn (17b.9) -----------------------------

test('preparePodSpawn emits the knowledge footer when knowledge rows exist AND pc_knowledge_read is in tools (17b.9)', () => {
  const dirs = freshDirs();
  try {
    const agent = createAgent(
      {
        name: 'pod-knows',
        scope: 'global',
        // Defensive footer-suppression check in the materialiser requires
        // pc_knowledge_read to be in the expanded tool list. Without it,
        // the footer would tell the agent to call a tool it can't reach.
        tools: ['Read', 'Glob', 'mcp__pc-rig__pc_knowledge_read'],
      },
      U,
    );
    createKnowledge(
      {
        agentId: agent.id,
        scope: 'global',
        name: 'agent-roster',
        // 17b.9: full content is NOT inlined — only a one-line summary lives
        // in the .md. Agents pull full content at runtime via pc_knowledge_read.
        content: 'this summary line surfaces but full content stays at runtime',
      },
      U,
    );
    const prep = preparePodSpawn({
      agentName: 'pod-knows',
      worktreeDir: dirs.worktree,
      scratchDir: dirs.scratch,
    });
    assert.ok(prep);
    const md = readFileSync(
      resolve(dirs.worktree, '.claude', 'agents', 'pod-knows.md'),
      'utf8',
    );
    // Footer present + roster + pc_knowledge_read pattern + summary
    assert.ok(md.includes('## Knowledge available'));
    assert.ok(md.includes('**agent-roster**'));
    assert.ok(md.includes('pc_knowledge_read'));
    assert.ok(md.includes('this summary line surfaces'));
  } finally {
    dirs.cleanup();
  }
});

// --- cleanup ----------------------------------------------------------------

test('preparePodSpawn cleanup() removes the materialised .md + mcp.json', () => {
  const dirs = freshDirs();
  try {
    createAgent({ name: 'pod-cleanup', scope: 'global' }, U);
    const prep = preparePodSpawn({
      agentName: 'pod-cleanup',
      worktreeDir: dirs.worktree,
      scratchDir: dirs.scratch,
    });
    assert.ok(prep);
    const mdPath = resolve(dirs.worktree, '.claude', 'agents', 'pod-cleanup.md');
    assert.ok(existsSync(mdPath));
    assert.ok(existsSync(prep.mcpConfigPath));

    prep.cleanup();
    assert.ok(!existsSync(mdPath));
    assert.ok(!existsSync(prep.mcpConfigPath));
    // Repeat cleanup is safe.
    prep.cleanup();
  } finally {
    dirs.cleanup();
  }
});
