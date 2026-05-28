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
  renderAvailableTools,
  renderAgentMd,
  renderMcpConfig,
  substituteVariables,
} from '../src/pod-materializer.ts';
import type {
  PodAgentRow,
  PodKnowledgeRow,
  PodMcpServerRow,
  PodSecretRow,
  PodSpawnBundle,
  ULID,
} from '@pc/domain';
import { mergeRequiredAgentTools } from '@pc/domain';

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
    origin: 'stock',
    dispatchGuidance: null,
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

test('renderAgentMd appends the generated available-tools footer', () => {
  const md = renderAgentMd(makeAgent(), ['Read', 'mcp__pc-rig__pc_get_work_item']);
  assert.ok(md.includes('## Available tools'));
  assert.ok(md.includes('- `Read` - Read text files from the project'));
  assert.ok(md.includes('- `mcp__pc-rig__pc_get_work_item` - Fetch a card'));
});

test('renderAgentMd suppresses the generated footer when the prompt places {{AVAILABLE_TOOLS}}', () => {
  const md = renderAgentMd(
    makeAgent({ prompt: 'Tools:\n\n{{AVAILABLE_TOOLS}}\n\nDone.' }),
    ['Read'],
  );
  assert.equal((md.match(/## Available tools/g) ?? []).length, 0);
  assert.ok(md.includes('- `Read` - Read text files from the project'));
  assert.ok(!md.includes('{{AVAILABLE_TOOLS}}'));
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

// --- Section 26.4: work-item assignment header ------------------------------

test('renderAgentMd omits the assignment section when no work-item context is supplied', () => {
  const md = renderAgentMd(makeAgent(), ['Read']);
  assert.ok(!md.includes('## Your assignment'));
  assert.ok(!md.includes('pc_get_work_item'));
});

test('renderAgentMd renders the assignment section when work-item context is supplied', () => {
  const md = renderAgentMd(makeAgent(), ['Read'], [], {
    workItemId: '01HXWI00000000000000000001',
    expectedOutput: { kind: 'text', sections: ['summary'] },
  });
  assert.ok(md.includes('## Your assignment'), 'has section heading');
  assert.ok(
    md.includes('pc_get_work_item({ id: "01HXWI00000000000000000001" })'),
    'has fetch instruction',
  );
  assert.ok(md.includes('### Expected output'), 'has expected_output subheading');
  // expected_output JSON appears as a pretty-printed block.
  assert.ok(md.includes('"kind": "text"'));
  assert.ok(md.includes('"sections"'));
  assert.ok(md.includes('"summary"'));
});

test('renderAgentMd renders assignment AFTER body but BEFORE knowledge footer', () => {
  const knowledge = [makeKnowledge('style-guide', 'Use the Oxford comma.')];
  const md = renderAgentMd(
    makeAgent({ tools: ['mcp__pc-rig__pc_knowledge_read'] }),
    ['mcp__pc-rig__pc_knowledge_read'],
    knowledge,
    {
      workItemId: '01HXWI00000000000000000002',
      expectedOutput: { kind: 'text' },
    },
  );
  const bodyIdx = md.indexOf('You are a researcher.');
  const assignmentIdx = md.indexOf('## Your assignment');
  const knowledgeIdx = md.indexOf('## Knowledge available');
  assert.ok(bodyIdx >= 0 && assignmentIdx > bodyIdx, 'assignment after body');
  assert.ok(knowledgeIdx > assignmentIdx, 'knowledge footer after assignment');
});

test('materializePod writes the assignment section into the .md when workItem is supplied', () => {
  const dirs = freshDirs();
  try {
    const out = materializePod({
      bundle: makeBundle({ knowledge: [] }),
      worktreeDir: dirs.worktree,
      scratchDir: dirs.scratch,
      workItem: {
        workItemId: '01HXWI00000000000000000003',
        expectedOutput: {
          kind: 'structured',
          fields: { verdict: 'string', issues: 'object' },
        },
      },
    });
    const content = readFileSync(out.agentMdPath, 'utf8');
    assert.ok(content.includes('## Your assignment'));
    assert.ok(content.includes('01HXWI00000000000000000003'));
    assert.ok(content.includes('"verdict": "string"'));
  } finally {
    dirs.cleanup();
  }
});

// --- expandToolWildcards ----------------------------------------------------

test('expandToolWildcards passes non-wildcard entries through unchanged', () => {
  const out = expandToolWildcards(['Read', 'Glob', 'mcp__pc-rig__pc_get_work_item'], {});
  assert.deepEqual(out, ['Read', 'Glob', 'mcp__pc-rig__pc_get_work_item']);
});

test('expandToolWildcards expands mcp__<server>__* against the catalog', () => {
  const out = expandToolWildcards(['Read', 'mcp__pc-rig__*'], {
    'pc-rig': ['mcp__pc-rig__pc_get_work_item', 'mcp__pc-rig__pc_knowledge_read'],
  });
  assert.deepEqual(out, [
    'Read',
    'mcp__pc-rig__pc_get_work_item',
    'mcp__pc-rig__pc_knowledge_read',
  ]);
});

test('expandToolWildcards dedupes overlapping wildcard + explicit entries', () => {
  const out = expandToolWildcards(
    ['mcp__pc-rig__pc_get_work_item', 'mcp__pc-rig__*', 'mcp__pc-rig__pc_get_work_item'],
    { 'pc-rig': ['mcp__pc-rig__pc_get_work_item', 'mcp__pc-rig__pc_knowledge_read'] },
  );
  assert.deepEqual(out, [
    'mcp__pc-rig__pc_get_work_item',
    'mcp__pc-rig__pc_knowledge_read',
  ]);
});

test('expandToolWildcards throws on unknown server', () => {
  assert.throws(
    () => expandToolWildcards(['mcp__gmail__*'], { 'pc-rig': ['mcp__pc-rig__pc_get_work_item'] }),
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

    // Frontmatter body is what renderAgentMd would emit. Section 26: the
    // materializer always merges in the required work-item tools.
    const md = readFileSync(result.agentMdPath, 'utf8');
    assert.match(md, /\nname: researcher\n/);
    const expectedTools = mergeRequiredAgentTools(['Read', 'Glob', 'Grep']).join(', ');
    assert.match(md, new RegExp(`\\ntools: ${expectedTools}\\n`));
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
          'mcp__pc-rig__pc_get_work_item',
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
        'pc-rig': ['mcp__pc-rig__pc_get_work_item', 'mcp__pc-rig__pc_knowledge_read'],
      },
    });
    // Section 26: required work-item tools merge in after wildcard expansion.
    const md = readFileSync(result.agentMdPath, 'utf8');
    const expectedTools = mergeRequiredAgentTools([
      'Read',
      'mcp__pc-rig__pc_get_work_item',
      'mcp__pc-rig__pc_knowledge_read',
    ]).join(', ');
    assert.match(md, new RegExp(`\\ntools: ${expectedTools}\\n`));
    assert.ok(md.includes('## Available tools'));
    assert.ok(md.includes('- `mcp__pc-rig__pc_get_work_item` - Fetch a card'));
    assert.ok(!md.includes('- `mcp__pc-rig__*`'));
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
          mcpToolCatalog: { 'pc-rig': ['mcp__pc-rig__pc_get_work_item'] },
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

test('materializePod emits a knowledge footer when knowledge rows exist AND pc_knowledge_read is in tools (17b.9)', () => {
  const dirs = freshDirs();
  try {
    const bundle = makeBundle({
      agent: makeAgent({
        tools: ['Read', 'Glob', 'Grep', 'mcp__pc-rig__pc_knowledge_read'],
      }),
      knowledge: [
        makeKnowledge('agent-roster', 'researcher is the file reader\nwriter is the drafter'),
        makeKnowledge('pricing', '# Pricing tiers\n\nTier A is $10/mo'),
      ],
    });
    const result = materializePod({
      bundle,
      worktreeDir: dirs.worktree,
      scratchDir: dirs.scratch,
    });
    const md = readFileSync(result.agentMdPath, 'utf8');
    // Footer section heading present
    assert.ok(md.includes('## Knowledge available'));
    // pc_knowledge_read pattern shown
    assert.ok(md.includes('pc_knowledge_read'));
    // Both doc names + ids surfaced
    assert.ok(md.includes('**agent-roster**'));
    assert.ok(md.includes('**pricing**'));
    // First non-heading line surfaced as summary
    assert.ok(md.includes('researcher is the file reader'));
    // H1 skipped in favor of body line for 'pricing' summary
    assert.ok(md.includes('Tier A is $10/mo'));
  } finally {
    dirs.cleanup();
  }
});

test('materializePod emits no knowledge footer when knowledge is empty', () => {
  const dirs = freshDirs();
  try {
    const bundle = makeBundle({ knowledge: [] });
    const result = materializePod({
      bundle,
      worktreeDir: dirs.worktree,
      scratchDir: dirs.scratch,
    });
    const md = readFileSync(result.agentMdPath, 'utf8');
    assert.ok(!md.includes('## Knowledge available'));
    assert.ok(!md.includes('pc_knowledge_read'));
  } finally {
    dirs.cleanup();
  }
});

// --- Section 36 — prompt variable substitution -----------------------------

test('substituteVariables replaces a known {{KEY}} with its value', () => {
  const out = substituteVariables('Hello {{NAME}}, welcome.', { NAME: 'world' });
  assert.equal(out, 'Hello world, welcome.');
});

test('substituteVariables replaces multiple occurrences', () => {
  const out = substituteVariables(
    '{{A}} and {{B}} and {{A}} again.',
    { A: 'apple', B: 'banana' },
  );
  assert.equal(out, 'apple and banana and apple again.');
});

test('substituteVariables leaves unknown variables intact (loud surface, never silent strip)', () => {
  const out = substituteVariables(
    'Known {{NAME}}, unknown {{UNDEFINED_VAR}}.',
    { NAME: 'pc' },
  );
  assert.equal(out, 'Known pc, unknown {{UNDEFINED_VAR}}.');
});

test('substituteVariables is a no-op when variables is undefined', () => {
  const out = substituteVariables('Plain text {{VAR}} no map.', undefined);
  assert.equal(out, 'Plain text {{VAR}} no map.');
});

test('substituteVariables only matches uppercase-underscore-digit keys (avoids prose collisions)', () => {
  // Lowercase / mixed-case / spaces inside should NOT match — these often
  // appear in prose ({{ some thing }} style) and substituting them would be
  // surprising. Only ALL-CAPS canonical keys are treated as variables.
  const out = substituteVariables(
    '{{lowercase}} stays. {{Mixed_Case}} stays. {{ UPPER_BUT_SPACED }} stays. {{UPPER_OK}} replaced.',
    { UPPER_OK: 'X', lowercase: 'should-not-apply', Mixed_Case: 'should-not-apply' },
  );
  assert.equal(
    out,
    '{{lowercase}} stays. {{Mixed_Case}} stays. {{ UPPER_BUT_SPACED }} stays. X replaced.',
  );
});

test('substituteVariables works with multiline values (e.g. rendered AVAILABLE_AGENTS block)', () => {
  const block = '### researcher (stock)\nReads.\n\n### writer (stock)\nDrafts.';
  const out = substituteVariables('Roster:\n\n{{AVAILABLE_AGENTS}}\n\nEnd.', {
    AVAILABLE_AGENTS: block,
  });
  assert.equal(out, `Roster:\n\n${block}\n\nEnd.`);
});

test('renderAgentMd substitutes variables in the prompt body', () => {
  const md = renderAgentMd(
    makeAgent({ prompt: 'You can dispatch:\n\n{{AVAILABLE_AGENTS}}\n\nGo.' }),
    ['Read'],
    [],
    undefined,
    { AVAILABLE_AGENTS: '### researcher (stock)\nReads files.' },
  );
  assert.ok(md.includes('### researcher (stock)\nReads files.'));
  assert.ok(!md.includes('{{AVAILABLE_AGENTS}}'));
});

test('renderAgentMd leaves the body unchanged when no variables map is passed', () => {
  const md = renderAgentMd(
    makeAgent({ prompt: 'Use {{UNKNOWN}} as-is.' }),
    ['Read'],
  );
  assert.ok(md.includes('Use {{UNKNOWN}} as-is.'));
});

test('renderAvailableTools describes cataloged tools and leaves unknown tools as slugs', () => {
  const out = renderAvailableTools(['Read', 'mcp__external__do_thing']);
  assert.ok(out.includes('- `Read` - Read text files from the project'));
  assert.ok(out.includes('- `mcp__external__do_thing`'));
});

test('materializePod renders AVAILABLE_TOOLS from final expanded tools, overriding stale caller values', () => {
  const dirs = freshDirs();
  try {
    const bundle = makeBundle({
      agent: makeAgent({
        prompt: 'Tools you have:\n\n{{AVAILABLE_TOOLS}}',
        tools: ['Read', 'mcp__pc-rig__*'],
      }),
    });
    const result = materializePod({
      bundle,
      worktreeDir: dirs.worktree,
      scratchDir: dirs.scratch,
      mcpToolCatalog: {
        'pc-rig': ['mcp__pc-rig__pc_get_work_item', 'mcp__pc-rig__pc_knowledge_read'],
      },
      variables: { AVAILABLE_TOOLS: '- `stale` - should not render' },
    });
    const md = readFileSync(result.agentMdPath, 'utf8');
    assert.ok(md.includes('- `Read` - Read text files from the project'));
    assert.ok(md.includes('- `mcp__pc-rig__pc_get_work_item` - Fetch a card'));
    assert.ok(md.includes('- `mcp__pc-rig__pc_knowledge_read` - Runtime: pull'));
    assert.ok(!md.includes('mcp__pc-rig__*'));
    assert.ok(!md.includes('stale'));
    assert.ok(!md.includes('{{AVAILABLE_TOOLS}}'));
  } finally {
    dirs.cleanup();
  }
});

test('materializePod suppresses the footer when the agent lacks pc_knowledge_read (defensive)', () => {
  // Knowledge rows exist but the agent's tool allowlist doesn't include
  // pc_knowledge_read — emitting the footer would tell the agent to call
  // a tool it can't reach. Suppress instead.
  const dirs = freshDirs();
  try {
    const bundle = makeBundle({
      agent: makeAgent({
        tools: ['Read', 'Glob', 'Grep', 'mcp__pc-rig__pc_get_work_item'], // no _knowledge_read
      }),
      knowledge: [makeKnowledge('agent-roster', 'roster content')],
    });
    const result = materializePod({
      bundle,
      worktreeDir: dirs.worktree,
      scratchDir: dirs.scratch,
    });
    const md = readFileSync(result.agentMdPath, 'utf8');
    assert.ok(!md.includes('## Knowledge available'));
    assert.ok(!md.includes('pc_knowledge_read'));
    assert.ok(!md.includes('agent-roster'));
  } finally {
    dirs.cleanup();
  }
});
