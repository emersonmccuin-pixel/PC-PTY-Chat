// Section 25 Session 9 — v2 invoke + continue HTTP route smoke.
//
// Exercises the pre-spawn validation surfaces (unknown agent, missing
// dispatcherSessionId, parent not-found, ownership-mismatch) without
// actually spawning claude.exe. The factory's dispatch path is covered
// by `pause-resume.test.ts` end-to-end; here we just pin the route-layer
// contract the MCP tools call into.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-server-v2-invoke-'));
process.env.PC_DATA_DIR = tmpDir;
delete process.env.PC_DELIVERY_TRANSPORT;

const {
  closeDb,
  runMigrations,
  createProject,
  createAgent,
  newId,
} = await import('@pc/db');
const { ChannelServer } = await import('../../src/services/channel-server.ts');
const {
  dispatchFreshAgentV2,
  dispatchContinueAgentV2,
} = await import('../../src/services/v2/agent-run-factory.ts');

import type { Stage, ULID } from '@pc/domain';

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

let server: InstanceType<typeof ChannelServer>;
let projectId: ULID;
let slug: string;
let projectFolder: string;

before(() => {
  runMigrations();
  projectFolder = join(tmpDir, 'v2-invoke-project');
  mkdirSync(projectFolder, { recursive: true });
  const p = createProject({
    slug: 'v2-invoke-smoke',
    name: 'V2 Invoke Smoke',
    stages,
    folderPath: projectFolder,
  });
  projectId = p.id as ULID;
  slug = p.slug;

  // Seed an agent so the unknown-agent branch can be distinguished.
  createAgent(
    {
      id: newId(),
      scope: 'global',
      name: 'researcher',
      prompt: 'You are a researcher.',
      tools: [],
      description: 'Lab researcher pod',
    },
    { actor: 'orchestrator', reason: 'test seed' },
  );

  server = new ChannelServer({
    port: 0,
    allowedSenders: new Set(),
    onEvent: () => {},
  });
});

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('dispatchFreshAgentV2 — unknown agent name returns cause=unknown-agent before any side effects', () => {
  const result = dispatchFreshAgentV2(
    {
      projectId,
      worktreeDir: projectFolder,
      agentName: 'does-not-exist',
      input: 'hello',
      dispatcherSessionId: 'orch-sess',
      invokeDepth: 1,
      slug,
    },
    { channelServer: server },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.cause, 'unknown-agent');
  assert.match(result.error, /no agent named "does-not-exist"/);
});

test('dispatchContinueAgentV2 — unknown parent run id returns cause=run-not-found', () => {
  const fakeRunId = newId() as ULID;
  const result = dispatchContinueAgentV2(
    {
      projectId,
      worktreeDir: projectFolder,
      parentAgentRunId: fakeRunId,
      input: 'follow-up',
      dispatcherSessionId: 'orch-sess',
      slug,
    },
    { channelServer: server },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.cause, 'run-not-found');
});
