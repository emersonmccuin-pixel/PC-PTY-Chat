// Unit test for listResolvedAgents — bucketing rules:
//   - Stock specialists from globals (orchestrator excluded).
//   - This project's project-scope pods.
//   - Non-stock globals hidden.
//   - Project-scope pods that shadow a stock pod by name move to `overrides`
//     and the stock entry drops out of `globals`.
//
// Run via:  pnpm --filter @pc/server test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDataDir = mkdtempSync(join(tmpdir(), 'pc-list-resolved-agents-'));
process.env.PC_DATA_DIR = tmpDataDir;

const { closeDb, runMigrations, createAgent } = await import('@pc/db');
import type { ULID } from '@pc/domain';
import { seedStockPods } from '../src/services/stock-pod-seed.ts';
import { ORCHESTRATOR_POD_CONTENT } from '../src/services/orchestrator-pod-content.ts';
import { listResolvedAgents } from '../src/services/project-agents.ts';

const projectA = '01ABCDEFGHJKMNPQRSTVWXY0AA' as ULID;
const projectB = '01ABCDEFGHJKMNPQRSTVWXY0BB' as ULID;

before(() => {
  runMigrations();
  createAgent(ORCHESTRATOR_POD_CONTENT, { actor: 'orchestrator', reason: 'test-setup' });
  seedStockPods();
});

after(() => {
  closeDb();
  rmSync(tmpDataDir, { recursive: true, force: true });
});

test('returns the seven dispatchable stock specialists, orchestrator excluded', () => {
  const result = listResolvedAgents(projectA);
  const names = new Set(result.globals.map((g) => g.name));
  for (const expected of ['researcher', 'writer', 'code-writer', 'reviewer', 'planner', 'extractor', 'agent-designer']) {
    assert.ok(names.has(expected), `${expected} should be in globals`);
  }
  assert.equal(names.has('orchestrator'), false, 'orchestrator must not appear in the listing');
  assert.deepEqual(result.overrides, []);
  assert.deepEqual(result.projectOnly, []);
});

test('hides non-stock globals (user-promoted reusables)', () => {
  createAgent(
    {
      name: 'cold-emailer',
      scope: 'global',
      prompt: 'test',
      description: 'promoted reusable',
    },
    { actor: 'user', reason: 'test-promote' },
  );

  const result = listResolvedAgents(projectA);
  assert.equal(
    result.globals.some((g) => g.name === 'cold-emailer'),
    false,
    'non-stock globals must not surface in a project listing',
  );
});

test("returns only the calling project's project-scope pods", () => {
  createAgent(
    {
      name: 'project-a-pod',
      scope: 'project',
      projectId: projectA,
      prompt: 'A',
      description: 'A',
    },
    { actor: 'user', reason: 'test-create' },
  );
  createAgent(
    {
      name: 'project-b-pod',
      scope: 'project',
      projectId: projectB,
      prompt: 'B',
      description: 'B',
    },
    { actor: 'user', reason: 'test-create' },
  );

  const resA = listResolvedAgents(projectA);
  assert.equal(
    resA.projectOnly.some((p) => p.name === 'project-a-pod'),
    true,
    "projectA should see its own pod",
  );
  assert.equal(
    resA.projectOnly.some((p) => p.name === 'project-b-pod'),
    false,
    "projectA must not see projectB's pod",
  );

  const resB = listResolvedAgents(projectB);
  assert.equal(
    resB.projectOnly.some((p) => p.name === 'project-b-pod'),
    true,
  );
  assert.equal(
    resB.projectOnly.some((p) => p.name === 'project-a-pod'),
    false,
  );
});

test('project-scope pod sharing a stock name shadows the stock entry', () => {
  createAgent(
    {
      name: 'researcher',
      scope: 'project',
      projectId: projectA,
      prompt: 'project-specific researcher',
      description: 'project-scoped override',
    },
    { actor: 'user', reason: 'test-override' },
  );

  const result = listResolvedAgents(projectA);
  assert.equal(
    result.globals.some((g) => g.name === 'researcher'),
    false,
    'stock researcher must not appear in globals when overridden',
  );
  const override = result.overrides.find((o) => o.name === 'researcher');
  assert.ok(override, 'overridden researcher must appear in overrides');
  assert.equal(override.kind, 'override');

  // projectB has no override → still sees the stock researcher in globals.
  const resB = listResolvedAgents(projectB);
  assert.equal(
    resB.globals.some((g) => g.name === 'researcher'),
    true,
    'projectB must still see the stock researcher',
  );
  assert.equal(
    resB.overrides.some((o) => o.name === 'researcher'),
    false,
  );
});
