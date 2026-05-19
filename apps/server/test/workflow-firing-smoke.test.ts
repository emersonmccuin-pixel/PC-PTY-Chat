// End-to-end smoke test for the workflow → channel-server → registered-WS
// delivery path (4c.4 / D39). The integration we actually care about — unit
// tests of the runtime state machine missed two stacked bugs (channel POST
// URL + drag-fires-workflow) for ~10 days because they never made a live
// HTTP request to the channel server. This test closes that gap.
//
// Covers the surviving channel-routed kind (post-4d):
//   - `terminated` ping (a cancel-only callable workflow → cancelled run)
//
// Plus a focused integration test for Section 4d's spawner-routed dispatch:
//   - `subagent` node fires via the injected `subagentSpawner`, NOT via the
//     channel server, and `nodeComplete` propagates the helper's output back
//     into the run state.
//
// Stands up a real ChannelServer on an ephemeral port + a real WS client
// playing the part of the per-project registered child, then drives a real
// WorkflowRuntime backed by the test SQLite DB.
//
// Run via:  pnpm --filter @pc/server test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import type {
  SubagentSpawnHandle,
  SubagentSpawnRequest,
  SubagentSpawnResult,
} from '@pc/runtime';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-server-smoke-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
} = await import('@pc/db');
const { WorkflowRuntime } = await import('../src/services/workflow-runtime.ts');
const { WorkItemService } = await import('../src/services/work-item.ts');
const { ChannelServer } = await import('../src/services/channel-server.ts');
const { WorkflowRegistry } = await import('@pc/workflows');
import type { Project, Stage, ULID } from '@pc/domain';
import type { WorktreeService } from '../src/services/worktree.ts';

const stages: Stage[] = [
  { id: 'draft', name: 'Draft', order: 0 },
];

const CANCEL_WORKFLOW_YAML = `id: smoke-cancel
triggers:
  callable: true
worktree: none
nodes:
  - id: stop
    kind: cancel
    cancel: smoke test forcing cancellation
`;

const SUBAGENT_WORKFLOW_YAML = `id: smoke-subagent
triggers:
  callable: true
worktree: none
nodes:
  - id: investigate
    kind: subagent
    subagent: researcher
    prompt: Take a look.
`;

let channelServer: InstanceType<typeof ChannelServer>;
let channelPort = 0;

// Stand up the channel server on an ephemeral port. We do this once for the
// file since starting/stopping the underlying Node http server adds noise.
async function startChannelServer(): Promise<void> {
  channelServer = new ChannelServer({
    port: 0, // OS picks an ephemeral port
    allowedSenders: new Set(['test']),
    onEvent: () => {
      // UI broadcasts are not relevant to this smoke test — the assertion
      // target is the registered-child WS forwarding path.
    },
  });
  channelServer.start();
  // The underlying server fires its listen callback async. Poll until the
  // bound port is known via the channel-server's internal http server.
  const internal = channelServer as unknown as {
    httpServer: { address: () => { port: number } | string | null } | null;
  };
  for (let attempt = 0; attempt < 50; attempt++) {
    const addr = internal.httpServer?.address?.();
    if (addr && typeof addr === 'object' && addr.port > 0) {
      channelPort = addr.port;
      return;
    }
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error('channel server did not bind a port within 1s');
}

before(async () => {
  runMigrations();
  await startChannelServer();
});

after(() => {
  channelServer?.shutdown();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

interface RegisteredChild {
  socket: WebSocket;
  received: Array<Record<string, unknown>>;
}

async function registerChild(projectId: ULID, slug: string): Promise<RegisteredChild> {
  const url = `ws://127.0.0.1:${channelPort}/channel-register?projectId=${projectId}&slug=${slug}`;
  const socket = new WebSocket(url);
  const received: Array<Record<string, unknown>> = [];
  socket.on('message', (raw) => {
    try {
      received.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    } catch {
      // ignore non-JSON frames
    }
  });
  await new Promise<void>((res, rej) => {
    socket.once('open', () => res());
    socket.once('error', rej);
  });
  return { socket, received };
}

interface Fixture {
  project: Project;
  runtime: InstanceType<typeof WorkflowRuntime>;
  child: RegisteredChild;
  workflowsDir: string;
  cleanup: () => void;
}

let fixtureSeq = 0;

interface FixtureOptions {
  /** Override the WorkflowRuntime's subagent spawner. Tests that exercise
   *  subagent dispatch pass a fake that synthesizes results without booting
   *  a real claude.exe. */
  subagentSpawner?: (req: SubagentSpawnRequest) => SubagentSpawnHandle;
}

async function mkFixture(
  workflows: Array<{ name: string; yaml: string }>,
  fopts: FixtureOptions = {},
): Promise<Fixture> {
  const seq = ++fixtureSeq;
  const folder = resolve(tmpDir, `smoke-${seq}`);
  mkdirSync(folder, { recursive: true });
  const workflowsDir = resolve(folder, 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  for (const w of workflows) {
    writeFileSync(resolve(workflowsDir, `${w.name}.yaml`), w.yaml, 'utf-8');
  }
  const project = createProject({
    slug: `smoke-${seq}`,
    name: `Smoke ${seq}`,
    stages,
    folderPath: folder,
  });
  const registry = new WorkflowRegistry(workflowsDir);
  registry.reload();

  const broadcast = () => {};
  const worktreeSvc = {
    async ensureWorktree(name: string) {
      return { path: resolve(folder, 'worktrees', name) };
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
    workspaceDir: folder,
    projectId: project.id as ULID,
    channelPort,
    broadcast,
    registry,
    worktrees: worktreeSvc,
    workItemService: workItemSvc,
    getProject: () => project,
    subagentSessionDirFor: (pcSessionId) => resolve(folder, 'subagent-sessions', pcSessionId),
    subagentSpawner: fopts.subagentSpawner,
  });

  const child = await registerChild(project.id as ULID, project.slug);
  return {
    project,
    runtime,
    child,
    workflowsDir,
    cleanup: () => {
      try { child.socket.close(); } catch { /* best effort */ }
    },
  };
}

async function waitForMessage(child: RegisteredChild, ms = 2000): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (child.received.length > 0) return child.received.shift()!;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`timeout waiting for channel forward (${ms}ms)`);
}

test('e2e smoke: callable cancel workflow → terminated ping forwarded to registered WS with kind=terminated header', async () => {
  const f = await mkFixture([{ name: 'smoke-cancel', yaml: CANCEL_WORKFLOW_YAML }]);
  try {
    await f.runtime.runWorkflow('smoke-cancel');

    const msg = await waitForMessage(f.child);
    assert.equal(msg['type'], 'channel-event');
    assert.equal(msg['source'], 'workflow', 'channel POST should land on /channel/<slug>/workflow');
    assert.equal(msg['method'], 'POST');
    const path = msg['path'] as string;
    assert.match(path, new RegExp(`^/channel/${f.project.slug}/workflow$`));
    const content = msg['content'] as string;
    const firstLine = content.split('\n', 1)[0];
    assert.equal(firstLine, '[pc:workflow-event kind=terminated version=1]');
    assert.match(content, /Workflow run terminated:.*status="cancelled"/);
    assert.match(content, /Reason: smoke test forcing cancellation/);
  } finally {
    f.cleanup();
  }
});

test('e2e smoke (4d): subagent node fires via injected spawner (NOT the channel); helper output lands on the run', async () => {
  const recordedSpawns: SubagentSpawnRequest[] = [];
  const fakeSpawner = (req: SubagentSpawnRequest): SubagentSpawnHandle => {
    recordedSpawns.push(req);
    const success: SubagentSpawnResult = {
      kind: 'success',
      lastAssistantText: 'investigation complete: nothing to report',
      pcCompletePayload: null,
      transcriptPath: resolve(req.sessionDataDir, 'transcript.log'),
      jsonlPath: null,
    };
    return {
      done: Promise.resolve(success),
      kill: () => {},
      transcriptPath: () => resolve(req.sessionDataDir, 'transcript.log'),
      jsonlPath: () => null,
    };
  };

  const f = await mkFixture(
    [{ name: 'smoke-subagent', yaml: SUBAGENT_WORKFLOW_YAML }],
    { subagentSpawner: fakeSpawner },
  );
  try {
    const run = await f.runtime.runWorkflow('smoke-subagent');

    // The runtime defers the first dispatch + the spawner resolves async; give
    // the microtask + tick chain a moment to settle. Poll instead of fixed
    // wait so the test doesn't bake in flakiness on slow CI.
    for (let i = 0; i < 50; i++) {
      const fresh = f.runtime['tryGetRun'].call(f.runtime, run.id);
      if (fresh?.nodeOutputs?.['investigate']?.status === 'complete') break;
      await new Promise((res) => setTimeout(res, 20));
    }

    // 1. Spawner was called once with the right shape.
    assert.equal(recordedSpawns.length, 1, 'spawner should be invoked exactly once');
    assert.equal(recordedSpawns[0]!.agentName, 'researcher');
    assert.match(recordedSpawns[0]!.initialInput, /Take a look\./);
    assert.match(recordedSpawns[0]!.initialInput, /\[workflowRunId:/);
    assert.match(recordedSpawns[0]!.initialInput, /\[nodeId: investigate\]/);

    // 2. No channel-event was forwarded to the registered child — subagent
    //    dispatch no longer routes through the channel server.
    assert.equal(
      f.child.received.length,
      0,
      `expected zero channel forwards for subagent dispatch, got: ${JSON.stringify(f.child.received)}`,
    );

    // 3. nodeComplete propagated the helper's lastAssistantText as the node
    //    output, and the run advanced to terminal status.
    const settled = f.runtime['tryGetRun'].call(f.runtime, run.id);
    assert.equal(settled?.nodeOutputs?.['investigate']?.status, 'complete');
    assert.equal(
      settled?.nodeOutputs?.['investigate']?.output,
      'investigation complete: nothing to report',
    );
    assert.equal(settled?.status, 'complete');
  } finally {
    f.cleanup();
  }
});

test('e2e smoke (4d): spawner idle-timeout → nodeFailed with "timeout (...)" prefix + run failed', async () => {
  const failure: SubagentSpawnResult = {
    kind: 'failure',
    cause: 'idle-timeout',
    message: 'helper idle for 300s — likely hung',
    transcriptPath: '/dev/null',
    jsonlPath: null,
    partialAssistantText: '',
  };
  const fakeSpawner = (req: SubagentSpawnRequest): SubagentSpawnHandle => ({
    done: Promise.resolve(failure),
    kill: () => {},
    transcriptPath: () => resolve(req.sessionDataDir, 'transcript.log'),
    jsonlPath: () => null,
  });

  const f = await mkFixture(
    [{ name: 'smoke-subagent', yaml: SUBAGENT_WORKFLOW_YAML }],
    { subagentSpawner: fakeSpawner },
  );
  try {
    const run = await f.runtime.runWorkflow('smoke-subagent');

    for (let i = 0; i < 50; i++) {
      const fresh = f.runtime['tryGetRun'].call(f.runtime, run.id);
      if (fresh?.status === 'failed') break;
      await new Promise((res) => setTimeout(res, 20));
    }

    const settled = f.runtime['tryGetRun'].call(f.runtime, run.id);
    assert.equal(settled?.nodeOutputs?.['investigate']?.status, 'failed');
    assert.match(settled?.nodeOutputs?.['investigate']?.error ?? '', /^timeout \(/);
    assert.equal(settled?.status, 'failed');
  } finally {
    f.cleanup();
  }
});

test('4e.1 / D55: subagent spawn handle reports jsonlPath → persisted onto nodeOutputs[id].transcriptPath', async () => {
  const fakeJsonlPath = '/tmp/fake-cc-session.jsonl';
  const fakeSpawner = (req: SubagentSpawnRequest): SubagentSpawnHandle => {
    const success: SubagentSpawnResult = {
      kind: 'success',
      lastAssistantText: 'done',
      pcCompletePayload: null,
      transcriptPath: resolve(req.sessionDataDir, 'transcript.log'),
      jsonlPath: fakeJsonlPath,
    };
    return {
      done: Promise.resolve(success),
      kill: () => {},
      transcriptPath: () => resolve(req.sessionDataDir, 'transcript.log'),
      jsonlPath: () => fakeJsonlPath,
    };
  };

  const f = await mkFixture(
    [{ name: 'smoke-subagent', yaml: SUBAGENT_WORKFLOW_YAML }],
    { subagentSpawner: fakeSpawner },
  );
  try {
    const run = await f.runtime.runWorkflow('smoke-subagent');
    for (let i = 0; i < 50; i++) {
      const fresh = f.runtime['tryGetRun'].call(f.runtime, run.id);
      if (fresh?.nodeOutputs?.['investigate']?.status === 'complete') break;
      await new Promise((res) => setTimeout(res, 20));
    }
    const settled = f.runtime['tryGetRun'].call(f.runtime, run.id);
    assert.equal(settled?.nodeOutputs?.['investigate']?.status, 'complete');
    assert.equal(
      settled?.nodeOutputs?.['investigate']?.transcriptPath,
      fakeJsonlPath,
      'transcriptPath must survive nodeComplete spread + dbPersistRun round-trip',
    );
  } finally {
    f.cleanup();
  }
});

test('4e.1: readRunForProject returns null for cross-project run ids (no info leak)', async () => {
  const fakeSpawner = (req: SubagentSpawnRequest): SubagentSpawnHandle => ({
    done: Promise.resolve({
      kind: 'success',
      lastAssistantText: 'done',
      pcCompletePayload: null,
      transcriptPath: resolve(req.sessionDataDir, 'transcript.log'),
      jsonlPath: null,
    } as SubagentSpawnResult),
    kill: () => {},
    transcriptPath: () => resolve(req.sessionDataDir, 'transcript.log'),
    jsonlPath: () => null,
  });

  const a = await mkFixture(
    [{ name: 'smoke-subagent', yaml: SUBAGENT_WORKFLOW_YAML }],
    { subagentSpawner: fakeSpawner },
  );
  const b = await mkFixture(
    [{ name: 'smoke-subagent', yaml: SUBAGENT_WORKFLOW_YAML }],
    { subagentSpawner: fakeSpawner },
  );
  try {
    const runA = await a.runtime.runWorkflow('smoke-subagent');
    // Same-project lookup hits.
    const sameProject = a.runtime.readRunForProject(runA.id);
    assert.equal(sameProject?.id, runA.id);
    // Cross-project lookup misses (run exists, project doesn't own it).
    const crossProject = b.runtime.readRunForProject(runA.id);
    assert.equal(crossProject, null);
    // Unknown id misses too.
    const unknown = a.runtime.readRunForProject('00000000-0000-0000-0000-000000000000');
    assert.equal(unknown, null);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});
