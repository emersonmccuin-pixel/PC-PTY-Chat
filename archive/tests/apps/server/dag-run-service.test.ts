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
import type {
  AgentHostCommand,
  AgentHostCommandResponse,
  AgentHostEvent,
  AgentHostWorkflowSubagentSnapshot,
  SubagentSpawnRequest,
} from '@pc/runtime';
import type { Spawner, Verifier, DagRunServiceOptions } from '../src/services/dag-run-service.ts';
import type { AgentHostReattachClient } from '../src/services/agent-host-reattach.ts';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-dag-run-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, runMigrations, createProject, createAgent, getWorkItem, listWorkItems, workflowRunsV2Repo } =
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
  createAgent(
    {
      name: 'researcher',
      scope: 'project',
      projectId: project.id as ULID,
      prompt: 'test researcher',
      tools: ['mcp__pc-rig__pc_get_work_item'],
    },
    { actor: 'user', reason: 'dag-run-service test fixture' },
  );
  const workItemService = new WorkItemService({
    projectId: project.id as ULID,
    getProject: () => project,
    getFieldSchemas: () => [],
    broadcast: (ev: unknown) => {
      const e = ev as { type?: string; workItem?: { title: string; body: string } };
      if (e.type === 'work-item-changed' && e.workItem) {
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

function workflowHostSnapshot(
  req: SubagentSpawnRequest,
  patch: Partial<AgentHostWorkflowSubagentSnapshot> = {},
): AgentHostWorkflowSubagentSnapshot {
  return {
    pcSessionId: req.pcSessionId,
    ccSessionId: `cc-${req.pcSessionId}`,
    agentName: req.agentName,
    worktreeDir: req.worktreeDir,
    state: 'running',
    transcriptPath: join(req.sessionDataDir, 'transcript.log'),
    jsonlPath: join(req.sessionDataDir, 'session.jsonl'),
    startedAt: 1,
    updatedAt: 1,
    terminalAt: null,
    ...patch,
  };
}

function createWorkflowHostClient(): {
  hostClient: AgentHostReattachClient;
  commands: AgentHostCommand[];
} {
  const commands: AgentHostCommand[] = [];
  const listeners = new Set<(event: AgentHostEvent) => void>();
  let seq = 0;
  const emit = (event: AgentHostEvent): void => {
    for (const listener of listeners) listener(event);
  };
  return {
    commands,
    hostClient: {
      listRuns: () => [],
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      sendCommand: (command): AgentHostCommandResponse => {
        commands.push(command);
        if (command.type === 'start-workflow-subagent') {
          const running = workflowHostSnapshot(command.request);
          queueMicrotask(() => {
            const completed = workflowHostSnapshot(command.request, {
              state: 'completed',
              updatedAt: 2,
              terminalAt: 2,
              terminalResult: {
                kind: 'success',
                lastAssistantText: 'host ok',
                pcCompletePayload: null,
                transcriptPath: running.transcriptPath,
                jsonlPath: running.jsonlPath,
              },
            });
            emit({
              seq: ++seq,
              type: 'workflow-subagent-terminal',
              workflowSubagent: completed,
            });
          });
          return {
            ok: true,
            command: 'start-workflow-subagent',
            workflowSubagent: running,
            lastSeq: seq,
          };
        }
        if (command.type === 'cancel-workflow-subagent') {
          const req = commands.find(
            (entry): entry is Extract<AgentHostCommand, { type: 'start-workflow-subagent' }> =>
              entry.type === 'start-workflow-subagent' &&
              entry.request.pcSessionId === command.pcSessionId,
          )?.request;
          if (!req) {
            return {
              ok: false,
              command: 'cancel-workflow-subagent',
              code: 'not-found',
              error: 'missing',
              lastSeq: seq,
            };
          }
          const cancelled = workflowHostSnapshot(req, {
            state: 'cancelled',
            updatedAt: 2,
            terminalAt: 2,
            terminalResult: {
              kind: 'failure',
              cause: 'killed',
              message: command.reason ?? 'cancelled',
              transcriptPath: join(req.sessionDataDir, 'transcript.log'),
              jsonlPath: join(req.sessionDataDir, 'session.jsonl'),
              partialAssistantText: '',
            },
          });
          return {
            ok: true,
            command: 'cancel-workflow-subagent',
            workflowSubagent: cancelled,
            lastSeq: seq,
          };
        }
        return {
          ok: false,
          command: command.type,
          code: 'unsupported',
          error: 'unexpected command',
          lastSeq: seq,
        };
      },
    },
  };
}

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

test('agent nodes use the host-backed workflow spawner when a host client is available', async () => {
  const { hostClient, commands } = createWorkflowHostClient();
  const opts: DagRunServiceOptions = {
    ...optsBase,
    hostClient,
    verify: passVerify,
  };

  const res = await fireDagWorkflow(wf([agent('hosted', 'do hosted work')]), { kind: 'manual' }, opts);
  const status = await res.done;

  assert.equal(status, 'completed');
  const start = commands.find(
    (command): command is Extract<AgentHostCommand, { type: 'start-workflow-subagent' }> =>
      command.type === 'start-workflow-subagent',
  );
  assert.ok(start, 'workflow should start through the host client');
  assert.match(start.request.pcSessionId, /^wf-/);
  assert.equal(start.request.worktreeDir, tmpDir);
  assert.equal(start.request.extraEnv?.PC_WORKFLOW_RUN_ID, res.runId);
  assert.equal(start.request.extraEnv?.PC_AGENT_NAME, 'researcher');
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
  assert.match(bCreated.body, /use upstream: report::pc-runtime:researcher/);
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

test('fireDagWorkflow with triggerWorkItemId uses existing card as run root — no new WI minted, stage unchanged', async () => {
  // Create a card that will enter a stage and trigger the workflow.
  const triggerWi = optsBase.workItemService.create({
    stageId: 'backlog',
    title: 'Brief Card',
    body: 'the brief body',
  });
  const rootsBeforeFire = createdBodies.filter((w) => w.title === 'Test WF').length;

  const opts = { ...optsBase, spawner: fakeSpawner, verify: passVerify };
  const res = await fireDagWorkflow(
    wf([agent('a', 'do a')]),
    { kind: 'stage-on-entry', stage: 'backlog' },
    opts,
    triggerWi.id as ULID,
  );
  const status = await res.done;

  assert.equal(status, 'completed');
  // Run root is the trigger card.
  assert.equal(res.rootWorkItemId, triggerWi.id);
  // No new WI with the workflow name was minted as a root.
  const rootsAfterFire = createdBodies.filter((w) => w.title === 'Test WF').length;
  assert.equal(rootsAfterFire, rootsBeforeFire);
  // Trigger card's stage is unchanged.
  const wi = getWorkItem(triggerWi.id as ULID)!;
  assert.equal(wi.stageId, 'backlog');
  // isWorkflowRoot must NOT be set on the trigger card.
  assert.ok(!wi.isWorkflowRoot);
});

test('$root.output and $root.output.<field> resolve from the run-root card', async () => {
  const triggerWi = optsBase.workItemService.create({
    stageId: 'backlog',
    title: 'Root Card',
    body: 'root body text',
    fields: { tag: 'alpha' },
  });
  // Reset captures so we only see WIs created during this test's run.
  createdBodies = [];

  const opts = { ...optsBase, spawner: fakeSpawner, verify: passVerify };
  await (await fireDagWorkflow(
    wf([agent('read', 'body=$root.output tag=$root.output.tag')]),
    { kind: 'stage-on-entry', stage: 'backlog' },
    opts,
    triggerWi.id as ULID,
  )).done;

  const readCreated = createdBodies.find((w) => w.title.endsWith('· read'))!;
  assert.ok(readCreated, 'agent node child WI should have been created');
  assert.match(readCreated.body, /body=root body text/);
  assert.match(readCreated.body, /tag=alpha/);
});

test('move-work-item node moves run-root card to target stage and returns stage id as output', async () => {
  // Build a project with two stages so there is somewhere to move to.
  const twoStages: Stage[] = [
    { id: 'build', name: 'Build', order: 0 },
    { id: 'review', name: 'Review', order: 1 },
  ];
  const p2 = createProject({
    slug: `dag-mv-${Math.random().toString(36).slice(2, 8)}`,
    name: 'move-test',
    stages: twoStages,
    folderPath: tmpDir,
  }) as unknown as Project;
  const workItemService2 = new WorkItemService({
    projectId: p2.id as ULID,
    getProject: () => p2,
    getFieldSchemas: () => [],
    broadcast: () => {},
  });
  const broadcastEvents: unknown[] = [];
  const opts: DagRunServiceOptions = {
    ...optsBase,
    projectId: p2.id as ULID,
    getProject: () => p2,
    workItemService: workItemService2,
    broadcast: (ev: unknown) => broadcastEvents.push(ev),
    spawner: fakeSpawner,
    verify: passVerify,
  };

  // Trigger card starts in 'build'.
  const triggerWi = workItemService2.create({ stageId: 'build', title: 'Card', body: 'brief' });

  const moveWf: WorkflowV2.Workflow = {
    id: 'move-wf',
    name: 'Move WF',
    triggers: [{ kind: 'manual' }],
    worktree: 'none',
    nodes: [{ kind: 'move-work-item', id: 'mv', to_stage: 'review' } as WorkflowV2.WorkflowNode],
  };
  const res = await fireDagWorkflow(moveWf, { kind: 'manual' }, opts, triggerWi.id as ULID);
  const status = await res.done;

  assert.equal(status, 'completed');

  // The run-root card is now in 'review'.
  const moved = getWorkItem(triggerWi.id as ULID)!;
  assert.equal(moved.stageId, 'review');

  // The node output is the destination stage id.
  const run = workflowRunsV2Repo.getRun(res.runId)!;
  assert.equal(run.dagState.nodes.mv!.state, 'completed');
  assert.equal(run.dagState.nodes.mv!.output, 'review');

  // A work-item-changed broadcast was emitted (UI sync).
  assert.ok(broadcastEvents.some((e) => (e as { type: string }).type === 'work-item-changed'));
});

test('move-work-item does NOT invoke the spawner (no stage-on-entry fire)', async () => {
  // If moveWorkItemStage (non-firing path) is used instead of moveAndFireV2,
  // the spawner should never be called for a pure move-work-item workflow.
  const twoStages: Stage[] = [
    { id: 'build2', name: 'Build', order: 0 },
    { id: 'review2', name: 'Review', order: 1 },
  ];
  const p3 = createProject({
    slug: `dag-mv2-${Math.random().toString(36).slice(2, 8)}`,
    name: 'move-no-fire',
    stages: twoStages,
    folderPath: tmpDir,
  }) as unknown as Project;
  const workItemService3 = new WorkItemService({
    projectId: p3.id as ULID,
    getProject: () => p3,
    getFieldSchemas: () => [],
    broadcast: () => {},
  });

  let spawnerCallCount = 0;
  const countingSpawner: Spawner = (req) => {
    spawnerCallCount++;
    return fakeSpawner(req);
  };

  const opts: DagRunServiceOptions = {
    ...optsBase,
    projectId: p3.id as ULID,
    getProject: () => p3,
    workItemService: workItemService3,
    spawner: countingSpawner,
    verify: passVerify,
  };

  const triggerWi = workItemService3.create({ stageId: 'build2', title: 'Card', body: 'brief' });
  const moveWf: WorkflowV2.Workflow = {
    id: 'move-wf2',
    name: 'Move WF2',
    triggers: [{ kind: 'manual' }],
    worktree: 'none',
    nodes: [{ kind: 'move-work-item', id: 'mv', to_stage: 'review2' } as WorkflowV2.WorkflowNode],
  };
  const res = await fireDagWorkflow(moveWf, { kind: 'manual' }, opts, triggerWi.id as ULID);
  await res.done;

  // No agent spawned — purely a stage move.
  assert.equal(spawnerCallCount, 0);
});

test('move-work-item with unknown stage fails the node and the run', async () => {
  const opts: DagRunServiceOptions = {
    ...optsBase,
    spawner: fakeSpawner,
    verify: passVerify,
  };
  const triggerWi = optsBase.workItemService.create({ stageId: 'backlog', title: 'Card', body: 'brief' });
  const moveWf: WorkflowV2.Workflow = {
    id: 'move-fail-wf',
    name: 'Move Fail',
    triggers: [{ kind: 'manual' }],
    worktree: 'none',
    nodes: [{ kind: 'move-work-item', id: 'mv', to_stage: 'no-such-stage' } as WorkflowV2.WorkflowNode],
  };
  const res = await fireDagWorkflow(moveWf, { kind: 'manual' }, opts, triggerWi.id as ULID);
  const status = await res.done;

  assert.equal(status, 'failed');
  const run = workflowRunsV2Repo.getRun(res.runId)!;
  assert.equal(run.dagState.nodes.mv!.state, 'failed');
  assert.match(run.dagState.nodes.mv!.error ?? '', /no-such-stage/);
});

test('manual fire (no triggerWorkItemId) mints a blank isWorkflowRoot card (regression)', async () => {
  const opts = { ...optsBase, spawner: fakeSpawner, verify: passVerify };
  const res = await fireDagWorkflow(wf([agent('a', 'do a')]), { kind: 'manual' }, opts);
  await res.done;

  const root = getWorkItem(res.rootWorkItemId)!;
  assert.equal(root.isWorkflowRoot, true);
  assert.equal(root.title, 'Test WF');
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
