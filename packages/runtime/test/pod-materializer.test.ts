// Unit tests for the Section 17a.3 pod materialiser.
//
// Verifies the on-disk shape claude.exe consumes: frontmatter contents, file
// paths, mcp.json structure, secret env-var map, and the wildcard-expansion
// contract documented in `pod-validation/RESULTS.md`. No real claude.exe
// spawn — pure file IO into a tmp dir.
//
// Run via:  pnpm --filter @pc/runtime test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildEnvMap,
  expandToolWildcards,
  materializePod,
  renderAgentMd,
  renderMcpConfig,
} from '../src/pod-materializer.ts';
import type {
  PodAgentRow,
  PodKnowledgeRow,
  PodMcpServerRow,
  PodSecretRow,
  PodSpawnBundle,
  ULID,
} from '@pc/domain';

// --- fixtures ---------------------------------------------------------------

const A_ID = '01HXAGENT00000000000000000' as ULID;

function makeAgent(patch: Partial<PodAgentRow> = {}): PodAgentRow {
  return {
    id: A_ID,
    name: 'researcher',
    scope: 'global',
    projectId: null,
    prompt: 'You are a researcher. Read sources and synthesize.',
    tools: ['Read', 'Glob', 'Grep'],
    model: 'sonnet',
    effort: 'medium',
    maxTurns: 20,
    outputDestination: null,
    description: 'Reads sources and returns synthesised findings.',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    deletedAt: null,
    ...patch,
  };
}

function makeBundle(patch: Partial<PodSpawnBundle> = {}): PodSpawnBundle {
  return {
    agent: makeAgent(),
    knowledge: [],
    secrets: [],
    mcpServers: [],
    ...patch,
  };
}

function makeSecret(envVarName: string, valuePlaintext: string): PodSecretRow {
  return {
    id: ('01HXSEC' + envVarName.padEnd(20, '0').slice(0, 20)) as ULID,
    agentId: A_ID,
    scope: 'global',
    projectId: null,
    envVarName,
    valuePlaintext,
    createdAt: 1_700_000_000_000,
  };
}

function makeMcpRow(name: string, config: PodMcpServerRow['config']): PodMcpServerRow {
  return {
    id: ('01HXMCP' + name.padEnd(20, '0').slice(0, 20)) as ULID,
    agentId: A_ID,
    scope: 'global',
    projectId: null,
    name,
    config,
    createdAt: 1_700_000_000_000,
  };
}

function makeKnowledge(name: string, content: string): PodKnowledgeRow {
  return {
    id: ('01HXKB' + name.padEnd(21, '0').slice(0, 21)) as ULID,
    agentId: A_ID,
    scope: 'global',
    projectId: null,
    name,
    kind: 'knowledge',
    content,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

function freshDirs(): { worktree: string; scratch: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-pod-mat-'));
  const worktree = join(root, 'worktree');
  const scratch = join(root, 'scratch');
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

// --- renderAgentMd ----------------------------------------------------------

test('renderAgentMd emits the canonical frontmatter shape', () => {
  const md = renderAgentMd(makeAgent(), ['Read', 'Glob', 'Grep']);
  const lines = md.split('\n');
  assert.equal(lines[0], '---');
  assert.equal(lines[1], 'name: researcher');
  assert.equal(lines[2], 'description: Reads sources and returns synthesised findings.');
  assert.equal(lines[3], 'tools: Read, Glob, Grep');
  assert.equal(lines[4], 'model: sonnet');
  assert.equal(lines[5], 'effort: medium');
  assert.equal(lines[6], 'maxTurns: 20');
  assert.equal(lines[7], '---');
  assert.equal(lines[8], '');
  assert.equal(lines[9], 'You are a researcher. Read sources and synthesize.');
});

test('renderAgentMd omits optional fields when null/empty', () => {
  const agent = makeAgent({
    description: '',
    model: null,
    effort: null,
    maxTurns: null,
  });
  const md = renderAgentMd(agent, []);
  assert.ok(!md.includes('description:'), 'description omitted when empty');
  assert.ok(!md.includes('tools:'), 'tools omitted when empty');
  assert.ok(!md.includes('model:'), 'model omitted when null');
  assert.ok(!md.includes('effort:'), 'effort omitted when null');
  assert.ok(!md.includes('maxTurns:'), 'maxTurns omitted when null');
  // Frontmatter still bracketed; prompt body intact.
  assert.match(md, /^---\nname: researcher\n---\n\nYou are a researcher/);
});

test('renderAgentMd trims trailing whitespace on the prompt body', () => {
  const md = renderAgentMd(makeAgent({ prompt: '\n\n  body  \n\n\n' }), []);
  // We trim, but the trailing newline added by the renderer survives once.
  assert.ok(md.endsWith('body\n'));
  assert.ok(!md.endsWith('\n\n'));
});

// --- expandToolWildcards ----------------------------------------------------

test('expandToolWildcards passes non-wildcard entries through unchanged', () => {
  const out = expandToolWildcards(['Read', 'Glob', 'mcp__pc-rig__pc_log'], {});
  assert.deepEqual(out, ['Read', 'Glob', 'mcp__pc-rig__pc_log']);
});

test('expandToolWildcards expands mcp__<server>__* against the catalog', () => {
  const out = expandToolWildcards(['Read', 'mcp__pc-rig__*'], {
    'pc-rig': ['mcp__pc-rig__pc_log', 'mcp__pc-rig__pc_knowledge_read'],
  });
  assert.deepEqual(out, [
    'Read',
    'mcp__pc-rig__pc_log',
    'mcp__pc-rig__pc_knowledge_read',
  ]);
});

test('expandToolWildcards dedupes overlapping wildcard + explicit entries', () => {
  const out = expandToolWildcards(
    ['mcp__pc-rig__pc_log', 'mcp__pc-rig__*', 'mcp__pc-rig__pc_log'],
    { 'pc-rig': ['mcp__pc-rig__pc_log', 'mcp__pc-rig__pc_knowledge_read'] },
  );
  assert.deepEqual(out, [
    'mcp__pc-rig__pc_log',
    'mcp__pc-rig__pc_knowledge_read',
  ]);
});

test('expandToolWildcards throws on unknown server', () => {
  assert.throws(
    () => expandToolWildcards(['mcp__gmail__*'], { 'pc-rig': ['mcp__pc-rig__pc_log'] }),
    /unknown MCP server "gmail"/,
  );
});

// --- renderMcpConfig --------------------------------------------------------

test('renderMcpConfig merges baseline + pod-declared, pod wins on conflict', () => {
  const baseline = {
    'pc-rig': { command: 'node', args: ['baseline.mjs'] },
    'gmail': { command: 'gmail-server' },
  };
  const podRows = [
    makeMcpRow('pc-rig', { command: 'node', args: ['pod-override.mjs'] }),
    makeMcpRow('jira', { command: 'jira-server', env: { JIRA_HOST: 'example.com' } }),
  ];
  const json = JSON.parse(renderMcpConfig(podRows, baseline));
  // pc-rig overridden by pod
  assert.deepEqual(json.mcpServers['pc-rig'], { command: 'node', args: ['pod-override.mjs'] });
  // gmail survives from baseline
  assert.deepEqual(json.mcpServers.gmail, { command: 'gmail-server' });
  // jira added from pod
  assert.deepEqual(json.mcpServers.jira, {
    command: 'jira-server',
    env: { JIRA_HOST: 'example.com' },
  });
});

test('renderMcpConfig with empty baseline + empty pod = empty mcpServers', () => {
  const json = JSON.parse(renderMcpConfig([], {}));
  assert.deepEqual(json, { mcpServers: {} });
});

// --- buildEnvMap ------------------------------------------------------------

test('buildEnvMap maps env var names to plaintext values', () => {
  const env = buildEnvMap([
    makeSecret('JIRA_TOKEN', 'jt-abc'),
    makeSecret('OPENAI_KEY', 'sk-xyz'),
  ]);
  assert.deepEqual(env, { JIRA_TOKEN: 'jt-abc', OPENAI_KEY: 'sk-xyz' });
});

test('buildEnvMap returns {} for no secrets', () => {
  assert.deepEqual(buildEnvMap([]), {});
});

// --- materializePod (end-to-end file IO) ------------------------------------

test('materializePod writes .md + mcp.json + returns env map', () => {
  const dirs = freshDirs();
  try {
    const bundle = makeBundle({
      mcpServers: [makeMcpRow('jira', { command: 'jira-server' })],
      secrets: [makeSecret('JIRA_TOKEN', 'jt-abc')],
    });
    const baseline = { 'pc-rig': { command: 'node', args: ['pc-rig.mjs'] } };
    const result = materializePod({
      bundle,
      worktreeDir: dirs.worktree,
      scratchDir: dirs.scratch,
      baselineMcpServers: baseline,
    });

    // Paths land in the expected places.
    assert.equal(
      result.agentMdPath,
      join(dirs.worktree, '.claude', 'agents', 'researcher.md'),
    );
    assert.equal(result.mcpConfigPath, join(dirs.scratch, 'mcp.json'));
    assert.ok(existsSync(result.agentMdPath));
    assert.ok(existsSync(result.mcpConfigPath));

    // Frontmatter body is what renderAgentMd would emit.
    const md = readFileSync(result.agentMdPath, 'utf8');
    assert.match(md, /\nname: researcher\n/);
    assert.match(md, /\ntools: Read, Glob, Grep\n/);
    assert.match(md, /\n\nYou are a researcher\./);

    // mcp.json merges baseline + pod.
    const mcp = JSON.parse(readFileSync(result.mcpConfigPath, 'utf8'));
    assert.deepEqual(mcp.mcpServers['pc-rig'], { command: 'node', args: ['pc-rig.mjs'] });
    assert.deepEqual(mcp.mcpServers.jira, { command: 'jira-server' });

    // Env map carries secrets.
    assert.deepEqual(result.envVars, { JIRA_TOKEN: 'jt-abc' });

    // Cleanup removes the files (tolerant of repeat calls).
    result.cleanup();
    assert.ok(!existsSync(result.agentMdPath));
    assert.ok(!existsSync(result.mcpConfigPath));
    result.cleanup();
  } finally {
    dirs.cleanup();
  }
});

test('materializePod filters mcp.json to referenced servers when filterMcpToReferencedTools: true', () => {
  const dirs = freshDirs();
  try {
    // Researcher-style bundle: tools reference pc-rig but NOT webhook.
    // Baseline carries pc-rig + webhook (matches PC's project .mcp.json
    // scaffold). Pod adds a jira server. Tools reference jira too.
    const bundle = makeBundle({
      agent: makeAgent({
        tools: [
          'Read', 'Glob', 'Grep',
          'mcp__pc-rig__pc_log',
          'mcp__jira__create_issue',
        ],
      }),
      mcpServers: [makeMcpRow('jira', { command: 'jira-server' })],
    });
    const baseline = {
      'pc-rig': { command: 'node', args: ['pc-rig.mjs'] },
      'webhook': { command: 'node', args: ['channel-server.js'] },
    };
    const result = materializePod({
      bundle,
      worktreeDir: dirs.worktree,
      scratchDir: dirs.scratch,
      baselineMcpServers: baseline,
      filterMcpToReferencedTools: true,
    });

    const mcp = JSON.parse(readFileSync(result.mcpConfigPath, 'utf8'));
    // pc-rig + jira survive (referenced by tools).
    assert.deepEqual(mcp.mcpServers['pc-rig'], { command: 'node', args: ['pc-rig.mjs'] });
    assert.deepEqual(mcp.mcpServers.jira, { command: 'jira-server' });
    // webhook is dropped (no `mcp__webhook__*` in tools).
    assert.equal(mcp.mcpServers.webhook, undefined);
    assert.equal(Object.keys(mcp.mcpServers).length, 2);
  } finally {
    dirs.cleanup();
  }
});

test('materializePod expands mcp__pc-rig__* against the supplied catalog', () => {
  const dirs = freshDirs();
  try {
    const bundle = makeBundle({
      agent: makeAgent({
        tools: ['Read', 'mcp__pc-rig__*'],
      }),
    });
    const result = materializePod({
      bundle,
      worktreeDir: dirs.worktree,
      scratchDir: dirs.scratch,
      mcpToolCatalog: {
        'pc-rig': ['mcp__pc-rig__pc_log', 'mcp__pc-rig__pc_knowledge_read'],
      },
    });
    const md = readFileSync(result.agentMdPath, 'utf8');
    assert.match(
      md,
      /\ntools: Read, mcp__pc-rig__pc_log, mcp__pc-rig__pc_knowledge_read\n/,
    );
  } finally {
    dirs.cleanup();
  }
});

test('materializePod throws when a wildcard targets an unknown server', () => {
  const dirs = freshDirs();
  try {
    const bundle = makeBundle({
      agent: makeAgent({ tools: ['mcp__gmail__*'] }),
    });
    assert.throws(
      () =>
        materializePod({
          bundle,
          worktreeDir: dirs.worktree,
          scratchDir: dirs.scratch,
          mcpToolCatalog: { 'pc-rig': ['mcp__pc-rig__pc_log'] },
        }),
      /unknown MCP server "gmail"/,
    );
  } finally {
    dirs.cleanup();
  }
});

test('materializePod creates nested .claude/agents/ even when worktree is empty', () => {
  const dirs = freshDirs();
  try {
    assert.ok(!existsSync(dirs.worktree));
    const result = materializePod({
      bundle: makeBundle(),
      worktreeDir: dirs.worktree,
      scratchDir: dirs.scratch,
    });
    assert.ok(existsSync(result.agentMdPath));
    assert.ok(existsSync(result.mcpConfigPath));
  } finally {
    dirs.cleanup();
  }
});

test('materializePod ignores knowledge rows in 17a.3 (footer is a 17b concern)', () => {
  const dirs = freshDirs();
  try {
    const bundle = makeBundle({
      knowledge: [makeKnowledge('agent-roster', 'roster content'.repeat(10))],
    });
    const result = materializePod({
      bundle,
      worktreeDir: dirs.worktree,
      scratchDir: dirs.scratch,
    });
    const md = readFileSync(result.agentMdPath, 'utf8');
    // Knowledge MCP tools land in 17b; until then the materialiser doesn't
    // dump knowledge into the prompt body (would be useless without
    // pc_knowledge_read to act on it).
    assert.ok(!md.includes('agent-roster'));
    assert.ok(!md.includes('roster content'));
  } finally {
    dirs.cleanup();
  }
});
