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

// 4h.6 / D78 — subagent with an author-declared output_schema. The runtime
// must validate the helper's pc_complete_node payload against the schema.
const SCHEMA_SUBAGENT_YAML = `id: smoke-schema
triggers:
  callable: true
worktree: none
nodes:
  - id: investigate
    kind: subagent
    subagent: researcher
    prompt: Take a look.
    output_schema:
      result: text
      count: int
`;

const TWO_STEP_SUBAGENT_YAML = `id: smoke-two-step
triggers:
  callable: true
worktree: none
nodes:
  - id: first
    kind: subagent
    subagent: researcher
    prompt: Step one.
  - id: second
    kind: subagent
    subagent: researcher
    prompt: Step two.
    depends_on: [first]
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
  /** Capture every envelope the runtime broadcasts. 4e.3 tests inspect for
   *  `workflow-run-changed`. Defaults to a no-op when omitted. */
  onBroadcast?: (event: unknown) => void;
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

  const broadcast = fopts.onBroadcast ?? (() => {});
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

test('4h.6 / D78: subagent pcCompletePayload matches output_schema → node complete', async () => {
  const fakeSpawner = (req: SubagentSpawnRequest): SubagentSpawnHandle => {
    const success: SubagentSpawnResult = {
      kind: 'success',
      lastAssistantText: 'never read — pcCompletePayload wins',
      pcCompletePayload: { result: 'all good', count: 7 },
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
    [{ name: 'smoke-schema', yaml: SCHEMA_SUBAGENT_YAML }],
    { subagentSpawner: fakeSpawner },
  );
  try {
    const run = await f.runtime.runWorkflow('smoke-schema');
    for (let i = 0; i < 50; i++) {
      const fresh = f.runtime['tryGetRun'].call(f.runtime, run.id);
      if (fresh?.status === 'complete' || fresh?.status === 'failed') break;
      await new Promise((res) => setTimeout(res, 20));
    }
    const settled = f.runtime['tryGetRun'].call(f.runtime, run.id);
    assert.equal(settled?.nodeOutputs?.['investigate']?.status, 'complete');
    assert.deepEqual(settled?.nodeOutputs?.['investigate']?.output, {
      result: 'all good',
      count: 7,
    });
    assert.equal(settled?.status, 'complete');
  } finally {
    f.cleanup();
  }
});

test('4h.6 / D78: subagent pcCompletePayload violates output_schema → node failed with shape-mismatch message', async () => {
  const fakeSpawner = (req: SubagentSpawnRequest): SubagentSpawnHandle => {
    const success: SubagentSpawnResult = {
      kind: 'success',
      lastAssistantText: 'irrelevant',
      // count declared as int; helper returned a string — shape mismatch.
      pcCompletePayload: { result: 'all good', count: 'seven' },
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
    [{ name: 'smoke-schema', yaml: SCHEMA_SUBAGENT_YAML }],
    { subagentSpawner: fakeSpawner },
  );
  try {
    const run = await f.runtime.runWorkflow('smoke-schema');
    for (let i = 0; i < 50; i++) {
      const fresh = f.runtime['tryGetRun'].call(f.runtime, run.id);
      if (fresh?.status === 'complete' || fresh?.status === 'failed') break;
      await new Promise((res) => setTimeout(res, 20));
    }
    const settled = f.runtime['tryGetRun'].call(f.runtime, run.id);
    assert.equal(settled?.nodeOutputs?.['investigate']?.status, 'failed');
    assert.match(
      settled?.nodeOutputs?.['investigate']?.error ?? '',
      /output_schema mismatch.*"count".*int/,
    );
    assert.equal(settled?.status, 'failed');
  } finally {
    f.cleanup();
  }
});

test('4h.6 / D78: helper returned plain-text fallback (no pcCompletePayload) → schema mismatch fails the node', async () => {
  // When the helper doesn't call pc_complete_node, the runtime falls back
  // to lastAssistantText (a string). With a declared output_schema, that
  // string is structurally not an object → must fail with the same shape-
  // mismatch message format, NOT bypass validation.
  const fakeSpawner = (req: SubagentSpawnRequest): SubagentSpawnHandle => {
    const success: SubagentSpawnResult = {
      kind: 'success',
      lastAssistantText: 'I did the thing',
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
    [{ name: 'smoke-schema', yaml: SCHEMA_SUBAGENT_YAML }],
    { subagentSpawner: fakeSpawner },
  );
  try {
    const run = await f.runtime.runWorkflow('smoke-schema');
    for (let i = 0; i < 50; i++) {
      const fresh = f.runtime['tryGetRun'].call(f.runtime, run.id);
      if (fresh?.status === 'complete' || fresh?.status === 'failed') break;
      await new Promise((res) => setTimeout(res, 20));
    }
    const settled = f.runtime['tryGetRun'].call(f.runtime, run.id);
    assert.equal(settled?.nodeOutputs?.['investigate']?.status, 'failed');
    assert.match(
      settled?.nodeOutputs?.['investigate']?.error ?? '',
      /output_schema mismatch.*got string/,
    );
    assert.equal(settled?.status, 'failed');
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

test('4e.2 / D53: retry-from-failed creates new run with carry-forward + lineage metadata', async () => {
  // Two-step workflow: first succeeds, second fails. Then retry-from
  // `second` with a NEW spawner (this time `second` succeeds). The new run
  // must (a) carry forward `first`'s output without re-spawning, (b)
  // re-run `second` and reach `complete`, and (c) carry the lineage
  // metadata + prior lastReason suffix.
  const results: SubagentSpawnResult[] = [
    {
      kind: 'success',
      lastAssistantText: 'first-step-original-output',
      pcCompletePayload: null,
      transcriptPath: '/tmp/first.log',
      jsonlPath: null,
    },
    {
      kind: 'failure',
      cause: 'idle-timeout',
      message: 'second step timed out',
      transcriptPath: '/tmp/second.log',
      jsonlPath: null,
      partialAssistantText: '',
    },
  ];
  let dispatchIdx = 0;
  const callLog: string[] = [];
  const stagedSpawner = (req: SubagentSpawnRequest): SubagentSpawnHandle => {
    callLog.push(req.pcSessionId);
    const result = results[dispatchIdx++] ?? results[results.length - 1]!;
    return {
      done: Promise.resolve(result),
      kill: () => {},
      transcriptPath: () => resolve(req.sessionDataDir, 'transcript.log'),
      jsonlPath: () => null,
    };
  };

  const f = await mkFixture(
    [{ name: 'smoke-two-step', yaml: TWO_STEP_SUBAGENT_YAML }],
    { subagentSpawner: stagedSpawner },
  );
  try {
    const priorRun = await f.runtime.runWorkflow('smoke-two-step');
    // Wait for the run to settle in `failed` (second step's failure).
    for (let i = 0; i < 100; i++) {
      const fresh = f.runtime['tryGetRun'].call(f.runtime, priorRun.id);
      if (fresh?.status === 'failed') break;
      await new Promise((res) => setTimeout(res, 20));
    }
    const priorSettled = f.runtime['tryGetRun'].call(f.runtime, priorRun.id);
    assert.equal(priorSettled?.status, 'failed', 'prior run must reach failed');
    assert.equal(priorSettled?.nodeOutputs?.['first']?.status, 'complete');
    assert.equal(priorSettled?.nodeOutputs?.['second']?.status, 'failed');

    // Now stage the retry — give the spawner a fresh success for `second`.
    results.push({
      kind: 'success',
      lastAssistantText: 'second-step-retry-output',
      pcCompletePayload: null,
      transcriptPath: '/tmp/second-retry.log',
      jsonlPath: null,
    });
    const callsBeforeRetry = callLog.length;

    const result = await f.runtime.retryFromFailedNode(priorRun.id, 'second');
    assert.ok(result.ok, `retry-from should succeed: ${(result as { error?: string }).error ?? ''}`);
    assert.ok(result.ok && result.runId !== priorRun.id, 'new run id must differ from prior');

    // Wait for the new run to complete.
    const newRunId = result.ok ? result.runId : '';
    for (let i = 0; i < 100; i++) {
      const fresh = f.runtime['tryGetRun'].call(f.runtime, newRunId);
      if (fresh?.status === 'complete') break;
      await new Promise((res) => setTimeout(res, 20));
    }
    const newRun = f.runtime['tryGetRun'].call(f.runtime, newRunId);
    assert.equal(newRun?.status, 'complete', 'new run must reach complete');

    // Carry-forward: `first` keeps its prior output (the spawner was NOT
    // called for it on this retry).
    assert.equal(newRun?.nodeOutputs?.['first']?.status, 'complete');
    assert.equal(
      newRun?.nodeOutputs?.['first']?.output,
      'first-step-original-output',
      'first-node output must carry forward from the prior run',
    );
    // `second` was re-dispatched and completed with the new output.
    assert.equal(newRun?.nodeOutputs?.['second']?.status, 'complete');
    assert.equal(newRun?.nodeOutputs?.['second']?.output, 'second-step-retry-output');

    // Exactly one new spawn happened for the retry (the second step). The
    // first step did NOT re-spawn.
    assert.equal(
      callLog.length - callsBeforeRetry,
      1,
      `retry should spawn exactly once (for the failed step); spawn log: ${callLog.join(', ')}`,
    );

    // Lineage metadata on the new run.
    assert.equal(newRun?.metadata?.['reFiredFromRunId'], priorRun.id);
    assert.equal(newRun?.metadata?.['reFiredFromNodeId'], 'second');

    // Prior run's lastReason got the lineage suffix appended.
    const priorAfterRetry = f.runtime['tryGetRun'].call(f.runtime, priorRun.id);
    assert.match(
      priorAfterRetry?.lastReason ?? '',
      new RegExp(`re-fired as ${newRunId}`),
      'prior run lastReason should carry the "re-fired as <id>" suffix',
    );
  } finally {
    f.cleanup();
  }
});

test('4e.2: retry-from validation — rejects unknown run, non-failed run, non-failed node', async () => {
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

  const f = await mkFixture(
    [{ name: 'smoke-subagent', yaml: SUBAGENT_WORKFLOW_YAML }],
    { subagentSpawner: fakeSpawner },
  );
  try {
    // 1. Unknown run id.
    const unknown = await f.runtime.retryFromFailedNode(
      '00000000-0000-0000-0000-000000000000',
      'investigate',
    );
    assert.equal(unknown.ok, false);
    assert.match(
      (unknown as { error?: string }).error ?? '',
      /unknown run:/,
    );

    // 2. Completed (not failed) run.
    const completedRun = await f.runtime.runWorkflow('smoke-subagent');
    for (let i = 0; i < 100; i++) {
      const fresh = f.runtime['tryGetRun'].call(f.runtime, completedRun.id);
      if (fresh?.status === 'complete') break;
      await new Promise((res) => setTimeout(res, 20));
    }
    const notFailed = await f.runtime.retryFromFailedNode(completedRun.id, 'investigate');
    assert.equal(notFailed.ok, false);
    assert.match(
      (notFailed as { error?: string }).error ?? '',
      /retry-from requires "failed" or "cancelled"/,
    );

    // 3. Node-not-failed: run that's failed, but the node we point at is
    //    `complete`. Synthesize this by failing a separate two-step run on
    //    its SECOND node, then trying to retry from FIRST (which succeeded).
    const stagedResults: SubagentSpawnResult[] = [
      {
        kind: 'success',
        lastAssistantText: 'first done',
        pcCompletePayload: null,
        transcriptPath: '/tmp/x.log',
        jsonlPath: null,
      },
      {
        kind: 'failure',
        cause: 'idle-timeout',
        message: 'second step timed out',
        transcriptPath: '/tmp/y.log',
        jsonlPath: null,
        partialAssistantText: '',
      },
    ];
    let stagedIdx = 0;
    const stagedSpawner = (req: SubagentSpawnRequest): SubagentSpawnHandle => ({
      done: Promise.resolve(stagedResults[stagedIdx++] ?? stagedResults[stagedResults.length - 1]!),
      kill: () => {},
      transcriptPath: () => resolve(req.sessionDataDir, 'transcript.log'),
      jsonlPath: () => null,
    });
    const f2 = await mkFixture(
      [{ name: 'smoke-two-step', yaml: TWO_STEP_SUBAGENT_YAML }],
      { subagentSpawner: stagedSpawner },
    );
    try {
      const partialRun = await f2.runtime.runWorkflow('smoke-two-step');
      for (let i = 0; i < 100; i++) {
        const fresh = f2.runtime['tryGetRun'].call(f2.runtime, partialRun.id);
        if (fresh?.status === 'failed') break;
        await new Promise((res) => setTimeout(res, 20));
      }
      const nodeNotFailed = await f2.runtime.retryFromFailedNode(partialRun.id, 'first');
      assert.equal(nodeNotFailed.ok, false);
      assert.match(
        (nodeNotFailed as { error?: string }).error ?? '',
        /node "first" is "complete", retry-from requires "failed"/,
      );

      // 4. Unknown node id.
      const unknownNode = await f2.runtime.retryFromFailedNode(partialRun.id, 'nope');
      assert.equal(unknownNode.ok, false);
      assert.match(
        (unknownNode as { error?: string }).error ?? '',
        /unknown nodeId in run/,
      );
    } finally {
      f2.cleanup();
    }
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

interface RunChangedEnvelope {
  type: 'workflow-run-changed';
  projectId: string;
  workflowId: string;
  runId: string;
  status: string;
  nodeOutputs: Record<string, { status: string }>;
}

function pickRunChanged(captured: unknown[]): RunChangedEnvelope[] {
  return captured.filter(
    (e): e is RunChangedEnvelope =>
      !!e &&
      typeof e === 'object' &&
      (e as { type?: unknown }).type === 'workflow-run-changed',
  );
}

test('4e.3 / D52: workflow-run-changed envelope fires on lifecycle transitions (create, dispatch, complete)', async () => {
  const captured: unknown[] = [];
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

  const f = await mkFixture(
    [{ name: 'smoke-subagent', yaml: SUBAGENT_WORKFLOW_YAML }],
    { subagentSpawner: fakeSpawner, onBroadcast: (e) => captured.push(e) },
  );
  try {
    const run = await f.runtime.runWorkflow('smoke-subagent');

    // Wait for the run to settle.
    for (let i = 0; i < 100; i++) {
      const fresh = f.runtime['tryGetRun'].call(f.runtime, run.id);
      if (fresh?.status === 'complete') break;
      await new Promise((res) => setTimeout(res, 20));
    }

    const envelopes = pickRunChanged(captured).filter((e) => e.runId === run.id);
    assert.ok(
      envelopes.length >= 2,
      `expected at least 2 workflow-run-changed envelopes (create + complete); got ${envelopes.length}`,
    );

    // Initial envelope: created with the node at `pending`.
    const first = envelopes[0]!;
    assert.equal(first.type, 'workflow-run-changed');
    assert.equal(first.projectId, f.project.id);
    assert.equal(first.workflowId, 'smoke-subagent');
    assert.equal(first.nodeOutputs['investigate']?.status, 'pending');

    // Terminal envelope: run + node both complete.
    const last = envelopes[envelopes.length - 1]!;
    assert.equal(last.status, 'complete');
    assert.equal(last.nodeOutputs['investigate']?.status, 'complete');
  } finally {
    f.cleanup();
  }
});

test('4e.3 / D52: retry-from-failed fires envelopes for both the prior lineage append AND the new run', async () => {
  const captured: unknown[] = [];
  const results: SubagentSpawnResult[] = [
    {
      kind: 'success',
      lastAssistantText: 'first ok',
      pcCompletePayload: null,
      transcriptPath: '/tmp/first.log',
      jsonlPath: null,
    },
    {
      kind: 'failure',
      cause: 'idle-timeout',
      message: 'second step timed out',
      transcriptPath: '/tmp/second.log',
      jsonlPath: null,
      partialAssistantText: '',
    },
  ];
  let idx = 0;
  const stagedSpawner = (req: SubagentSpawnRequest): SubagentSpawnHandle => ({
    done: Promise.resolve(results[idx++] ?? results[results.length - 1]!),
    kill: () => {},
    transcriptPath: () => resolve(req.sessionDataDir, 'transcript.log'),
    jsonlPath: () => null,
  });

  const f = await mkFixture(
    [{ name: 'smoke-two-step', yaml: TWO_STEP_SUBAGENT_YAML }],
    { subagentSpawner: stagedSpawner, onBroadcast: (e) => captured.push(e) },
  );
  try {
    const priorRun = await f.runtime.runWorkflow('smoke-two-step');
    for (let i = 0; i < 100; i++) {
      const fresh = f.runtime['tryGetRun'].call(f.runtime, priorRun.id);
      if (fresh?.status === 'failed') break;
      await new Promise((res) => setTimeout(res, 20));
    }

    // Stage a successful retry attempt for `second`.
    results.push({
      kind: 'success',
      lastAssistantText: 'second-retry ok',
      pcCompletePayload: null,
      transcriptPath: '/tmp/second-retry.log',
      jsonlPath: null,
    });

    const capturedBeforeRetry = captured.length;
    const retry = await f.runtime.retryFromFailedNode(priorRun.id, 'second');
    assert.ok(retry.ok, 'retry-from must succeed');
    const newRunId = retry.ok ? retry.runId : '';

    for (let i = 0; i < 100; i++) {
      const fresh = f.runtime['tryGetRun'].call(f.runtime, newRunId);
      if (fresh?.status === 'complete') break;
      await new Promise((res) => setTimeout(res, 20));
    }

    const sinceRetry = pickRunChanged(captured.slice(capturedBeforeRetry));

    const newRunEnvs = sinceRetry.filter((e) => e.runId === newRunId);
    assert.ok(
      newRunEnvs.some((e) => e.status === 'complete'),
      'new run should fire a terminal `complete` envelope',
    );

    const priorRunEnvs = sinceRetry.filter((e) => e.runId === priorRun.id);
    assert.ok(
      priorRunEnvs.length >= 1,
      'retry-from must broadcast the prior run after appending the lineage suffix',
    );
  } finally {
    f.cleanup();
  }
});

/** Section 4e.8 / D39. End-to-end HTTP smoke for the per-run + retry-from
 *  surfaces the drawer hits. Spins up a minimal Hono app that mirrors the
 *  three 4e endpoints (list-runs, get-run-detail, retry-from) wired to the
 *  fixture's runtime, then drives the failure → retry → success arc
 *  exclusively through `app.fetch(new Request(...))`. This guards the wire
 *  layer the same way 4c.4 guards the channel-POST URL — unit tests would
 *  miss a misnamed route or a JSON-shape regression. */
test('4e.8 / D39 e2e smoke (HTTP): fire → fail → list → get-detail → retry-from → succeed', async () => {
  const { Hono } = await import('hono');

  // Spawner stages: first dispatch fails, second dispatch (the retry)
  // succeeds. Mirrors a user inspecting a failed run in the drawer and
  // clicking "Retry from here."
  let dispatchIdx = 0;
  const results: SubagentSpawnResult[] = [
    {
      kind: 'failure',
      cause: 'idle-timeout',
      message: 'first dispatch failed',
      transcriptPath: '/dev/null',
      jsonlPath: null,
      partialAssistantText: '',
    },
    {
      kind: 'success',
      lastAssistantText: 'second dispatch succeeded',
      pcCompletePayload: null,
      transcriptPath: '/dev/null',
      jsonlPath: null,
    },
  ];
  const stagedSpawner = (req: SubagentSpawnRequest): SubagentSpawnHandle => ({
    done: Promise.resolve(results[dispatchIdx++] ?? results[results.length - 1]!),
    kill: () => {},
    transcriptPath: () => resolve(req.sessionDataDir, 'transcript.log'),
    jsonlPath: () => null,
  });

  const f = await mkFixture(
    [{ name: 'smoke-subagent', yaml: SUBAGENT_WORKFLOW_YAML }],
    { subagentSpawner: stagedSpawner },
  );
  try {
    const projectId = f.project.id as string;
    const runtime = f.runtime;

    // Stand up a focused Hono app wired to this fixture's runtime. Only the
    // three 4e routes — enough to validate URL shape + JSON contract.
    const app = new Hono();
    app.get('/api/projects/:projectId/workflow-runs', (c) => {
      const id = c.req.param('projectId');
      if (id !== projectId) return c.json({ ok: false, error: 'unknown project' }, 404);
      return c.json({ runs: runtime.readRunsForProject() });
    });
    app.get('/api/projects/:projectId/workflow-runs/:runId', (c) => {
      const id = c.req.param('projectId');
      const runId = c.req.param('runId');
      if (id !== projectId) return c.json({ ok: false, error: 'unknown project' }, 404);
      const run = runtime.readRunForProject(runId);
      if (!run) return c.json({ ok: false, error: `unknown run: ${runId}` }, 404);
      return c.json({ run });
    });
    app.post('/api/projects/:projectId/workflow-runs/:runId/retry-from', async (c) => {
      const id = c.req.param('projectId');
      const runId = c.req.param('runId');
      if (id !== projectId) return c.json({ ok: false, error: 'unknown project' }, 404);
      const body = await c.req.json<{ nodeId?: string }>().catch(() => ({}) as { nodeId?: string });
      const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : '';
      if (!nodeId) return c.json({ ok: false, error: 'nodeId required' }, 400);
      const result = await runtime.retryFromFailedNode(runId, nodeId);
      if (!result.ok) {
        const status = result.error.startsWith('unknown run:') ? 404 : 400;
        return c.json({ ok: false, error: result.error }, status);
      }
      return c.json({ ok: true, runId: result.runId });
    });

    // 1. Drag-fire equivalent: invoke the workflow on the runtime, wait for
    //    failure to settle.
    const priorRun = await runtime.runWorkflow('smoke-subagent');
    for (let i = 0; i < 100; i++) {
      const fresh = runtime['tryGetRun'].call(runtime, priorRun.id);
      if (fresh?.status === 'failed') break;
      await new Promise((res) => setTimeout(res, 20));
    }

    // 2. List the runs — drawer "open" path.
    const listRes = await app.fetch(
      new Request(`http://test.local/api/projects/${projectId}/workflow-runs`),
    );
    assert.equal(listRes.status, 200);
    const listJson = (await listRes.json()) as { runs: Array<{ id: string; status: string }> };
    const failedRun = listJson.runs.find((r) => r.id === priorRun.id);
    assert.ok(failedRun, 'list endpoint must surface the failed run');
    assert.equal(failedRun!.status, 'failed');

    // 3. Get the per-run detail — drawer "open run" path.
    const detailRes = await app.fetch(
      new Request(`http://test.local/api/projects/${projectId}/workflow-runs/${priorRun.id}`),
    );
    assert.equal(detailRes.status, 200);
    const detailJson = (await detailRes.json()) as {
      run: { nodeOutputs: Record<string, { status: string }> };
    };
    assert.equal(detailJson.run.nodeOutputs['investigate']?.status, 'failed');

    // 4. Retry-from — drawer "Retry from here" path.
    const retryRes = await app.fetch(
      new Request(
        `http://test.local/api/projects/${projectId}/workflow-runs/${priorRun.id}/retry-from`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeId: 'investigate' }),
        },
      ),
    );
    assert.equal(retryRes.status, 200);
    const retryJson = (await retryRes.json()) as { ok: boolean; runId: string };
    assert.ok(retryJson.ok);
    assert.notEqual(retryJson.runId, priorRun.id);
    const newRunId = retryJson.runId;

    // 5. Wait for the new run to complete, then verify via HTTP.
    for (let i = 0; i < 100; i++) {
      const fresh = runtime['tryGetRun'].call(runtime, newRunId);
      if (fresh?.status === 'complete') break;
      await new Promise((res) => setTimeout(res, 20));
    }
    const newDetailRes = await app.fetch(
      new Request(`http://test.local/api/projects/${projectId}/workflow-runs/${newRunId}`),
    );
    assert.equal(newDetailRes.status, 200);
    const newDetailJson = (await newDetailRes.json()) as {
      run: {
        status: string;
        metadata?: Record<string, unknown>;
        nodeOutputs: Record<string, { status: string }>;
      };
    };
    assert.equal(newDetailJson.run.status, 'complete');
    assert.equal(newDetailJson.run.nodeOutputs['investigate']?.status, 'complete');
    assert.equal(newDetailJson.run.metadata?.['reFiredFromRunId'], priorRun.id);
    assert.equal(newDetailJson.run.metadata?.['reFiredFromNodeId'], 'investigate');

    // 6. Validation paths: invalid retry-from inputs return the right HTTP codes.
    const missingNodeId = await app.fetch(
      new Request(
        `http://test.local/api/projects/${projectId}/workflow-runs/${priorRun.id}/retry-from`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      ),
    );
    assert.equal(missingNodeId.status, 400);

    const unknownRun = await app.fetch(
      new Request(
        `http://test.local/api/projects/${projectId}/workflow-runs/00000000-0000-0000-0000-000000000000/retry-from`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeId: 'investigate' }),
        },
      ),
    );
    assert.equal(unknownRun.status, 404);
  } finally {
    f.cleanup();
  }
});

test('4e.3: nodeFailed broadcasts the failed envelope', async () => {
  const captured: unknown[] = [];
  const fakeSpawner = (req: SubagentSpawnRequest): SubagentSpawnHandle => ({
    done: Promise.resolve({
      kind: 'failure',
      cause: 'wall-clock-timeout',
      message: 'helper timed out (wall-clock)',
      transcriptPath: '/dev/null',
      jsonlPath: null,
      partialAssistantText: '',
    } as SubagentSpawnResult),
    kill: () => {},
    transcriptPath: () => resolve(req.sessionDataDir, 'transcript.log'),
    jsonlPath: () => null,
  });

  const f = await mkFixture(
    [{ name: 'smoke-subagent', yaml: SUBAGENT_WORKFLOW_YAML }],
    { subagentSpawner: fakeSpawner, onBroadcast: (e) => captured.push(e) },
  );
  try {
    const run = await f.runtime.runWorkflow('smoke-subagent');
    for (let i = 0; i < 100; i++) {
      const fresh = f.runtime['tryGetRun'].call(f.runtime, run.id);
      if (fresh?.status === 'failed') break;
      await new Promise((res) => setTimeout(res, 20));
    }

    const envelopes = pickRunChanged(captured).filter((e) => e.runId === run.id);
    const last = envelopes[envelopes.length - 1]!;
    assert.equal(last.status, 'failed');
    assert.equal(last.nodeOutputs['investigate']?.status, 'failed');
  } finally {
    f.cleanup();
  }
});
