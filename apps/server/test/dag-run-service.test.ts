// Section 19.4e — live DAG wiring integration test. Real DB + WorkItemService +
// v2 repo; only claude.exe (the spawner) + verification are faked. Proves
// contract-WI creation, $nodeId.output resolution from real child WIs, sidecar
// persistence, and the review pause→approve resume path.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project, Stage, ULID, WorkflowV2 } from '@pc/domain';
import type { Spawner, Verifier, DagRunServiceOptions } from '../src/services/dag-run-service.ts';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-dag-run-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, runMigrations, createProject, getWorkItem, listWorkItems, workflowRunsV2Repo } =
  await import('@pc/db');
const { WorkItemService } = await import('../src/services/work-item.ts');
const { fireDagWorkflow, applyV2ReviewDecision } = await import('../src/services/dag-run-service.ts');

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

let project: Project;
let optsBase: Omit<DagRunServiceOptions, 'spawner' | 'verify'>;
/** WI bodies captured at creation time (before the fake agent overwrites them). */
let createdBodies: { title: string; body: string }[] = [];

beforeEach(() => {
  createdBodies = [];
  project = createProject({
    slug: `dag-${Math.random().toString(36).slice(2, 8)}`,
    name: 'dag',
    stages,
    folderPath: tmpDir,
  }) as unknown as Project;
  const workItemService = new WorkItemService({
    projectId: project.id as ULID,
    getProject: () => project,
    getFieldSchemas: () => [],
    broadcast: (ev: unknown) => {
      const e = ev as { type?: string; change?: string; workItem?: { title: string; body: string } };
      if (e.type === 'work-items-changed' && e.change === 'created' && e.workItem) {
        createdBodies.push({ title: e.workItem.title, body: e.workItem.body });
      }
    },
  });
  optsBase = {
    projectId: project.id as ULID,
    workspaceDir: tmpDir,
    channelPort: 0,
    getProject: () => project,
    workItemService,
    worktrees: {} as never, // worktree:'none' in tests → never called
    sessionDirFor: (id) => join(tmpDir, 'sessions', id),
    broadcast: () => {},
    exec: async () => ({ ok: true }),
    postChannel: async () => {},
  };
});

/** Fake claude.exe: parses the WI id from initialInput, patches the child WI
 *  body to simulate the agent's report, then resolves success. */
const fakeSpawner: Spawner = (req) => ({
  done: Promise.resolve().then(() => {
    const m = /work item (\w+)/.exec(req.initialInput);
    const wiId = m?.[1] as ULID | undefined;
    if (wiId) {
      const wi = getWorkItem(wiId);
      if (wi) optsBase.workItemService.patch(wiId, { expectedVersion: wi.version, body: `report::${req.agentName}` });
    }
    return { kind: 'success', lastAssistantText: 'ok', pcCompletePayload: null, transcriptPath: '', jsonlPath: null };
  }),
  kill: () => {},
  transcriptPath: () => '',
  jsonlPath: () => null,
});

const passVerify: Verifier = async (input) => ({
  workItemId: input.workItemId as ULID,
  workItemStatus: 'complete',
  verificationStatus: 'passed',
  verificationTier: 'auto',
  notes: '',
  predicatesEvaluated: 0,
});

function agent(id: string, task: string, next?: string[]): WorkflowV2.WorkflowNode {
  return { kind: 'agent', id, agent: 'researcher', task, ...(next ? { next } : {}) } as WorkflowV2.WorkflowNode;
}
function wf(nodes: WorkflowV2.WorkflowNode[]): WorkflowV2.Workflow {
  return { id: 'wf', name: 'Test WF', triggers: [{ kind: 'manual' }], nodes, worktree: 'none' };
}

test('fire creates a workflow-root WI + child WIs + sidecar run; completes', async () => {
  const opts = { ...optsBase, spawner: fakeSpawner, verify: passVerify };
  const res = await fireDagWorkflow(wf([agent('a', 'do a', ['b']), agent('b', 'do b')]), { kind: 'manual' }, opts);
  const status = await res.done;

  assert.equal(status, 'completed');

  const root = getWorkItem(res.rootWorkItemId)!;
  assert.equal(root.isWorkflowRoot, true);

  // two child agent WIs created under the root
  const children = listWorkItems(project.id as ULID).filter((w) => w.isAgentTask);
  assert.equal(children.length, 2);

  // sidecar run reflects completion + both nodes settled
  const run = workflowRunsV2Repo.getRun(res.runId)!;
  assert.equal(run.status, 'completed');
  assert.equal(run.dagState.nodes.a!.state, 'completed');
  assert.equal(run.dagState.nodes.b!.state, 'completed');

  // event log captured the lifecycle
  const types = workflowRunsV2Repo.listEvents(res.runId).map((e) => e.type);
  assert.ok(types.includes('node_started'));
  assert.ok(types.includes('workflow_completed'));
});

test('$nodeId.output in a downstream task resolves from the upstream child WI', async () => {
  const opts = { ...optsBase, spawner: fakeSpawner, verify: passVerify };
  const res = await fireDagWorkflow(
    wf([agent('a', 'do a', ['b']), agent('b', 'use upstream: $a.output')]),
    { kind: 'manual' },
    opts
  );
  await res.done;

  // node b's child WI was CREATED with its rendered task — $a.output resolved
  // to node a's report. (The fake agent later overwrites the body with b's own
  // report, so we assert against the creation-time body captured via broadcast.)
  const bCreated = createdBodies.find((w) => w.title.endsWith('· b'))!;
  assert.match(bCreated.body, /use upstream: report::researcher/);
});

test('review node pauses the run (paused), then approve completes it', async () => {
  const reviewWf: WorkflowV2.Workflow = {
    id: 'wf',
    name: 'Review WF',
    triggers: [{ kind: 'manual' }],
    worktree: 'none',
    nodes: [
      agent('code', 'write code', ['rev']),
      { kind: 'orchestrator-review', id: 'rev', next: ['done'], prompt: 'check it' } as WorkflowV2.WorkflowNode,
      agent('done', 'ship it'),
    ],
  };
  let posted = 0;
  const opts: DagRunServiceOptions = {
    ...optsBase,
    spawner: fakeSpawner,
    verify: passVerify,
    postChannel: async () => {
      posted += 1;
    },
  };
  const res = await fireDagWorkflow(reviewWf, { kind: 'manual' }, opts);
  const status = await res.done;

  assert.equal(status, 'awaiting-review');
  assert.equal(posted, 1); // orchestrator gate posted to the channel
  assert.equal(workflowRunsV2Repo.getRun(res.runId)!.status, 'paused');

  const after = await applyV2ReviewDecision(res.runId, 'rev', { kind: 'approve' }, opts);
  assert.equal(after, 'completed');
  assert.equal(workflowRunsV2Repo.getRun(res.runId)!.status, 'completed');
});

test('bash node runs via exec; failure fails the run', async () => {
  const opts: DagRunServiceOptions = {
    ...optsBase,
    spawner: fakeSpawner,
    verify: passVerify,
    exec: async () => ({ ok: false, error: 'exit 1' }),
  };
  const res = await fireDagWorkflow(
    { id: 'wf', name: 'Bash WF', triggers: [{ kind: 'manual' }], worktree: 'none', nodes: [{ kind: 'bash', id: 'b', bash: 'false' } as WorkflowV2.WorkflowNode] },
    { kind: 'manual' },
    opts
  );
  const status = await res.done;
  assert.equal(status, 'failed');
});

test('bash node stdout feeds $nodeId.output in a downstream agent task (F#1)', async () => {
  // Pre-F#1: bash nodes had no workItemId, the resolver returned '' for
  // `$bash.output`, and downstream tasks rendered with empty substitutions.
  // Post-fix: captured stdout lives on `state.nodes[bash].output` and resolves.
  const opts: DagRunServiceOptions = {
    ...optsBase,
    spawner: fakeSpawner,
    verify: passVerify,
    exec: async () => ({ ok: true, stdout: 'count=42' }),
  };
  const res = await fireDagWorkflow(
    {
      id: 'wf',
      name: 'Bash→Agent',
      triggers: [{ kind: 'manual' }],
      worktree: 'none',
      nodes: [
        { kind: 'bash', id: 'count', bash: 'wc -l foo.txt', next: ['summarize'] } as WorkflowV2.WorkflowNode,
        agent('summarize', 'upstream said: $count.output'),
      ],
    },
    { kind: 'manual' },
    opts
  );
  const status = await res.done;
  assert.equal(status, 'completed');

  // sidecar persisted the captured stdout on the bash node record
  const run = workflowRunsV2Repo.getRun(res.runId)!;
  assert.equal(run.dagState.nodes.count!.output, 'count=42');

  // downstream agent's child WI was created with the substituted task body
  const summarizeCreated = createdBodies.find((w) => w.title.endsWith('· summarize'))!;
  assert.match(summarizeCreated.body, /upstream said: count=42/);
});
