// End-to-end smoke test for the workflow → channel-server → registered-WS
// delivery path (4c.4 / D39). The integration we actually care about — unit
// tests of the runtime state machine missed two stacked bugs (channel POST
// URL + drag-fires-workflow) for ~10 days because they never made a live
// HTTP request to the channel server. This test closes that gap.
//
// Covers both surviving post-4d kinds:
//   - `terminated` ping (a cancel-only callable workflow → cancelled run)
//   - `subagent-dispatch` POST (a single-subagent callable workflow)
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

async function mkFixture(workflows: Array<{ name: string; yaml: string }>): Promise<Fixture> {
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

test('e2e smoke: callable subagent workflow → subagent-dispatch POST forwarded with kind=subagent-dispatch header', async () => {
  const f = await mkFixture([{ name: 'smoke-subagent', yaml: SUBAGENT_WORKFLOW_YAML }]);
  try {
    await f.runtime.runWorkflow('smoke-subagent');

    const msg = await waitForMessage(f.child);
    assert.equal(msg['type'], 'channel-event');
    assert.equal(msg['source'], 'workflow');
    const content = msg['content'] as string;
    const firstLine = content.split('\n', 1)[0];
    assert.equal(firstLine, '[pc:workflow-event kind=subagent-dispatch version=1]');
    assert.match(content, /Workflow event:.*workflow="smoke-subagent".*subagent="researcher"/);
  } finally {
    f.cleanup();
  }
});
