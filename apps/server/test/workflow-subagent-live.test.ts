// Section 4d / D39 gate: live end-to-end smoke for the spawner-driven
// subagent dispatch path. Boots a real claude.exe via the runtime's default
// spawner, lets the helper run to natural turn-end, and asserts the workflow
// runtime captures the last assistant message and closes the node.
//
// Skipped by default — opt in with `PC_LIVE_CLAUDE=1 pnpm --filter @pc/server
// test test/workflow-subagent-live.test.ts`. Skipping in CI is fine; this
// covers the contract between WorkflowRuntime + the real PtySession-backed
// spawner, which the fake-spawner smoke (workflow-firing-smoke.test.ts)
// cannot exercise.
//
// Requires:
//   - claude.exe at C:\Users\example\.local\bin\claude.exe (override via
//     CLAUDE_EXE env var).
//   - A working Anthropic subscription on this machine — the helper hits the
//     network.
//
// Run via:  PC_LIVE_CLAUDE=1 pnpm --filter @pc/server test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const LIVE = process.env.PC_LIVE_CLAUDE === '1';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-live-subagent-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, runMigrations, createProject } = await import('@pc/db');
const { WorkflowRuntime } = await import('../src/services/workflow-runtime.ts');
const { WorkItemService } = await import('../src/services/work-item.ts');
const { WorkflowRegistry } = await import('@pc/workflows');
import type { Stage, ULID } from '@pc/domain';
import type { WorktreeService } from '../src/services/worktree.ts';

const stages: Stage[] = [{ id: 'draft', name: 'Draft', order: 0 }];

const LIVE_AGENT = `---
name: live-echo
description: Live-test helper. Responds with a single short sentence then exits.
tools: Read, Bash
model: sonnet
---

You are a test helper. Respond with one short sentence that includes the literal token OK_LIVE_DONE, then stop. Do not call any tools, do not ask questions. Reply once and end the turn.
`;

const LIVE_WORKFLOW_YAML = `id: live-subagent
triggers:
  callable: true
worktree: none
nodes:
  - id: echo
    kind: subagent
    subagent: live-echo
    prompt: Say the token and stop.
`;

let projectFolder = '';

before(() => {
  if (!LIVE) return;
  runMigrations();
  projectFolder = resolve(tmpDir, 'proj');
  mkdirSync(resolve(projectFolder, '.claude', 'agents'), { recursive: true });
  mkdirSync(resolve(projectFolder, 'workflows'), { recursive: true });
  // Minimal .mcp.json — the spawner unconditionally passes --strict-mcp-config,
  // so an empty servers map prevents claude.exe from failing at boot. Live-echo
  // doesn't need any MCP tools; the runtime captures completion from JSONL.
  writeFileSync(resolve(projectFolder, '.mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2));
  writeFileSync(resolve(projectFolder, '.claude', 'agents', 'live-echo.md'), LIVE_AGENT);
  writeFileSync(resolve(projectFolder, 'workflows', 'live-subagent.yaml'), LIVE_WORKFLOW_YAML);
});

after(() => {
  if (!LIVE) {
    rmSync(tmpDir, { recursive: true, force: true });
    return;
  }
  // KEEP tmpDir so we can inspect transcript + spawned-session events on
  // failure. Print the path so it's findable.
  try { closeDb(); } catch { /* best-effort */ }
  console.log(`[live test] tmpDir preserved at: ${tmpDir}`);
});

test('live (4d.7): real claude.exe helper natural-terminates → spawner resolves success → node closes with lastAssistantText', { skip: !LIVE, timeout: 300_000 }, async () => {
  const project = createProject({
    slug: 'live-1',
    name: 'Live 1',
    stages,
    folderPath: projectFolder,
  });
  const registry = new WorkflowRegistry(resolve(projectFolder, 'workflows'));
  registry.reload();

  const broadcast = () => {};
  const worktreeSvc = {
    async ensureWorktree(name: string) {
      return { path: resolve(projectFolder, 'worktrees', name) };
    },
    ensureScratchDir() {},
    sweepStaleScratch() {
      return { removed: [] as string[] };
    },
  } as unknown as WorktreeService;

  const workItemSvc = new WorkItemService({
    projectId: project.id as ULID,
    getProject: () => project,
    getFieldSchemas: () => [],
    broadcast,
  });

  const runtime = new WorkflowRuntime({
    workspaceDir: projectFolder,
    projectId: project.id as ULID,
    channelPort: 0,
    broadcast,
    registry,
    worktrees: worktreeSvc,
    workItemService: workItemSvc,
    getProject: () => project,
    subagentSessionDirFor: (pcSessionId) => resolve(projectFolder, 'subagent-sessions', pcSessionId),
  });

  const run = await runtime.runWorkflow('live-subagent');

  // Real claude.exe boot is ~3–5s; the test prompt is one-shot. Poll up to
  // 90s for terminal status. The framework's 120s timeout is the hard fail.
  let settled: ReturnType<typeof runtime['tryGetRun']> = undefined;
  for (let i = 0; i < 450; i++) {
    settled = runtime['tryGetRun'].call(runtime, run.id);
    const status = settled?.nodeOutputs?.['echo']?.status;
    if (status === 'complete' || status === 'failed') break;
    await new Promise((res) => setTimeout(res, 200));
  }

  assert.equal(
    settled?.nodeOutputs?.['echo']?.status,
    'complete',
    `node should close complete; final error: ${settled?.nodeOutputs?.['echo']?.error ?? '(none)'}`,
  );
  const output = settled?.nodeOutputs?.['echo']?.output;
  const outputText = typeof output === 'string' ? output : JSON.stringify(output);
  assert.match(
    outputText,
    /OK_LIVE_DONE/,
    `node output should contain the live-echo token; got: ${outputText.slice(0, 200)}`,
  );
  assert.equal(settled?.status, 'complete');
});
