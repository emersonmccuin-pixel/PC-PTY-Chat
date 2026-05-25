// Section 19.4e — LIVE wiring for the v2 DAG executor. Implements DagExecutorDeps
// against the real machinery (work-item-as-contract creation, spawnSubagent,
// verification, worktree exec, channel posts, the v2 sidecar repo) and provides
// the fire entry point. Spawner / verification / exec / channel are injectable
// so the integration is testable against a real DB with a FAKE claude.exe (see
// test/dag-run-service.test.ts); the live claude.exe smoke is 19.14.

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Project, ULID, WorkflowV2 } from '@pc/domain';
import { substituteRefs, type RefResolver, type ReviewDecision, type RunStatus } from '@pc/workflows';
import { getWorkItem, workflowRunsV2Repo } from '@pc/db';
import { spawnSubagent, type SubagentSpawnHandle, type SubagentSpawnRequest } from '@pc/runtime';
import { DagExecutor, type DagExecutorDeps, type DagNodeContext, type NodeOutcome } from './dag-executor.ts';
import { createAgentWorkItem } from './agent-work-item.ts';
import { runVerificationOnTerminal } from './agent-verification.ts';
import { preparePodSpawn } from './pod-spawn.ts';
import { registerWorkflowSubagentHandshake } from './workflow-subagent-handshake.ts';
import type { WorkItemService } from './work-item.ts';
import type { WorktreeService } from './worktree.ts';

const execFileAsync = promisify(execFile);

export type Spawner = (req: SubagentSpawnRequest) => SubagentSpawnHandle;
export type Verifier = typeof runVerificationOnTerminal;
export type CommandExec = (
  kind: 'bash' | 'node' | 'python',
  code: string,
  opts: { cwd: string; timeout?: number }
) => Promise<{ ok: boolean; error?: string }>;
export type ChannelPoster = (body: string, source: string) => Promise<void>;

export interface DagRunServiceOptions {
  projectId: ULID;
  workspaceDir: string;
  channelPort: number;
  getProject: () => Project;
  workItemService: WorkItemService;
  worktrees: WorktreeService;
  /** Per-dispatch session-data dir factory (mirrors WorkflowRuntime). */
  sessionDirFor: (pcSessionId: string) => string;
  broadcast: (event: unknown) => void;
  // ── injectable seams (live defaults) ──
  spawner?: Spawner;
  verify?: Verifier;
  exec?: CommandExec;
  postChannel?: ChannelPoster;
}

const liveSpawner: Spawner = (req) =>
  spawnSubagent(req, { registerHandshakeListener: registerWorkflowSubagentHandshake });

const liveExec: CommandExec = async (kind, code, { cwd, timeout }) => {
  const [cmd, args]: [string, string[]] =
    kind === 'bash' ? ['bash', ['-c', code]] : kind === 'node' ? ['node', ['-e', code]] : ['python', ['-c', code]];
  try {
    await execFileAsync(cmd, args, {
      cwd,
      timeout,
      killSignal: 'SIGKILL', // hard-kill on timeout (PC improvement over Archon's soft abort)
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true };
  } catch (err) {
    const e = err as Error & { killed?: boolean };
    const reason = e.killed && timeout !== undefined ? `timeout (${String(timeout)}ms exceeded)` : e.message;
    return { ok: false, error: reason };
  }
};

/** awaiting-review maps to the persisted `paused` status. */
function toRunStatus(s: RunStatus): WorkflowV2.WorkflowRunStatus {
  return s === 'awaiting-review' ? 'paused' : (s as WorkflowV2.WorkflowRunStatus);
}

/** Apply `$carry.X` substitution on top of `$nodeId.output` resolution. */
function render(template: string, ctx: DagNodeContext, escapedForBash = false): string {
  const withRefs = substituteRefs(template, ctx.resolve, { escapedForBash });
  return withRefs.replace(/\$carry\.([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, key: string) => ctx.carry[key] ?? '');
}

interface RunHandle {
  id: ULID;
  workItemId: ULID | null;
  worktreePath: string | null;
}

/** Build the live DagExecutorDeps for one run. */
export function makeExecutorDeps(
  run: RunHandle,
  workflow: WorkflowV2.Workflow,
  opts: DagRunServiceOptions
): DagExecutorDeps {
  const spawner = opts.spawner ?? liveSpawner;
  const verify = opts.verify ?? runVerificationOnTerminal;
  const exec = opts.exec ?? liveExec;
  const postChannel =
    opts.postChannel ??
    (async (body, source) => {
      const slug = opts.getProject().slug;
      const url = `http://127.0.0.1:${String(opts.channelPort)}/channel/${encodeURIComponent(slug)}/${encodeURIComponent(source)}`;
      await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body });
    });

  const resolveRef =
    (state: WorkflowV2.WorkflowDagState): RefResolver =>
    (nodeId, field) => {
      const wiId = state.nodes[nodeId]?.workItemId;
      if (!wiId) return '';
      const wi = getWorkItem(wiId as ULID);
      if (!wi) return '';
      if (!field) return wi.body ?? '';
      const v = wi.fields?.[field];
      if (v == null) return '';
      return typeof v === 'string' ? v : JSON.stringify(v);
    };

  const dispatchAgent = async (
    node: WorkflowV2.AgentNode,
    ctx: DagNodeContext
  ): Promise<NodeOutcome> => {
    const task = render(node.task, ctx);
    const childWi = createAgentWorkItem(
      {
        title: `${workflow.name} · ${node.id}`,
        task,
        pod: node.agent,
        ...(node.expected_output ? { expectedOutput: node.expected_output } : {}),
        // Workflow-level review is done via review NODES, so agent-node child
        // WIs always verify on the `auto` tier (no per-node double-gating).
        verificationTier: 'auto',
        parentWorkItemId: run.workItemId,
        worktree: run.worktreePath,
      },
      { workItemService: opts.workItemService, getProject: opts.getProject }
    );

    const worktreeDir = run.worktreePath ?? opts.workspaceDir;
    const pcSessionId = `wf-${run.id.slice(-8)}-${node.id}-${randomUUID().slice(0, 8)}`;
    const sessionDataDir = opts.sessionDirFor(pcSessionId);
    mkdirSync(sessionDataDir, { recursive: true });

    const podPrep = preparePodSpawn({
      agentName: node.agent,
      projectId: opts.projectId,
      worktreeDir,
      scratchDir: sessionDataDir,
      filterMcpToReferencedTools: true,
    });

    const initialInput =
      `Your assignment is work item ${childWi.id}. Call pc_get_work_item({ id: "${childWi.id}" }) ` +
      `to read its body, acceptance criteria, and attachments, then begin. When finished, update the ` +
      `work item with your report.`;

    const handle = spawner({
      agentName: node.agent,
      worktreeDir,
      initialInput,
      sessionDataDir,
      pcSessionId,
      ...(node.timeout !== undefined ? { idleTimeoutMs: node.timeout } : {}),
      ...(podPrep?.mcpConfigPath ? { mcpConfigPath: podPrep.mcpConfigPath } : {}),
      ...(podPrep?.extraEnv ? { extraEnv: podPrep.extraEnv } : {}),
    });

    let failureReason: string | null = null;
    try {
      const result = await handle.done;
      if (result.kind === 'failure') failureReason = `${result.cause}: ${result.message}`;
    } finally {
      podPrep?.cleanup();
    }

    const outcome = await verify({
      workItemId: childWi.id as ULID,
      terminalStatus: failureReason ? 'failed' : 'completed',
      failureReason,
      projectFolderPath: opts.workspaceDir,
      worktreeDir,
      project: opts.getProject(),
    });

    const failed =
      failureReason !== null ||
      outcome?.verificationStatus === 'failed' ||
      outcome?.workItemStatus === 'failed';
    return {
      state: failed ? 'failed' : 'completed',
      workItemId: childWi.id as ULID,
      ...(failed && failureReason ? { error: failureReason } : {}),
    };
  };

  const runCommand = async (
    node: WorkflowV2.BashNode | WorkflowV2.ScriptNode,
    ctx: DagNodeContext
  ): Promise<NodeOutcome> => {
    const cwd = run.worktreePath ?? opts.workspaceDir;
    if (node.kind === 'bash') {
      const code = render(node.bash, ctx, true);
      const r = await exec('bash', code, { cwd, ...(node.timeout !== undefined ? { timeout: node.timeout } : {}) });
      return r.ok ? { state: 'completed' } : { state: 'failed', ...(r.error ? { error: r.error } : {}) };
    }
    const code = render(node.script, ctx);
    const r = await exec(node.runtime, code, { cwd, ...(node.timeout !== undefined ? { timeout: node.timeout } : {}) });
    return r.ok ? { state: 'completed' } : { state: 'failed', ...(r.error ? { error: r.error } : {}) };
  };

  const requestReview = async (
    node: WorkflowV2.HumanReviewNode | WorkflowV2.OrchestratorReviewNode,
    _ctx: DagNodeContext,
    bundle: { nodeId: string; output: string }[]
  ): Promise<void> => {
    const flavor = node.kind === 'orchestrator-review' ? 'orchestrator' : 'human';
    const summary = bundle.map((b) => `### ${b.nodeId}\n${b.output}`).join('\n\n');
    const body =
      `[pc:workflow-review run=${run.id} node=${node.id} flavor=${flavor}]\n` +
      `${node.prompt ?? 'Please review the work below.'}\n\n${summary}\n\n` +
      `Approve: pc_complete_node-equivalent (v2 review endpoint) · Reject sends it back.`;
    if (node.kind === 'orchestrator-review') {
      await postChannel(body, 'workflow');
    }
    opts.broadcast({
      type: 'workflow-v2-review-pending',
      projectId: opts.projectId,
      runId: run.id,
      nodeId: node.id,
      flavor,
      prompt: node.prompt ?? null,
      bundle,
    });
  };

  const persist = (
    state: WorkflowV2.WorkflowDagState,
    status: RunStatus,
    o?: { lastReason?: string }
  ): void => {
    workflowRunsV2Repo.setDagState(run.id, state);
    workflowRunsV2Repo.setStatus(run.id, toRunStatus(status), {
      ...(o?.lastReason !== undefined ? { lastReason: o.lastReason } : {}),
    });
    opts.broadcast({
      type: 'workflow-v2-run-changed',
      projectId: opts.projectId,
      runId: run.id,
      workItemId: run.workItemId,
      status: toRunStatus(status),
      dagState: state,
    });
  };

  return {
    resolveRef,
    dispatchAgent,
    runCommand,
    requestReview,
    persist,
    event: (ev) => {
      workflowRunsV2Repo.appendEvent({
        runId: run.id,
        type: ev.type,
        ...(ev.nodeId ? { nodeId: ev.nodeId } : {}),
        ...(ev.data ? { data: ev.data } : {}),
      });
    },
    isCancelled: () => workflowRunsV2Repo.getRun(run.id)?.status === 'cancelled',
    holdForHuman: (nodeId, reason) => {
      opts.broadcast({
        type: 'workflow-v2-human-hold',
        projectId: opts.projectId,
        runId: run.id,
        nodeId,
        reason,
      });
    },
  };
}

export interface FireResult {
  runId: ULID;
  rootWorkItemId: ULID;
  /** Resolves when the run pauses (review), completes, or fails. */
  done: Promise<RunStatus>;
}

/**
 * Fire a v2 workflow: create the run-root work item, acquire a worktree, write
 * the sidecar run row, and start the executor. `done` resolves at the first
 * pause/terminal; callers that don't want to block (HTTP route) ignore it.
 */
export async function fireDagWorkflow(
  workflow: WorkflowV2.Workflow,
  trigger: WorkflowV2.WorkflowTrigger,
  opts: DagRunServiceOptions
): Promise<FireResult> {
  const project = opts.getProject();
  const stages = (project.stages ?? []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const stageId = stages[0]?.id;
  if (!stageId) throw new Error('project has no stages — cannot create a workflow run root');

  const rootWi = opts.workItemService.create({
    title: workflow.name,
    stageId,
    body: `Workflow run — ${workflow.name}`,
    isWorkflowRoot: true,
  });

  let worktreePath: string | null = null;
  if (workflow.worktree !== 'none') {
    const wt = await opts.worktrees.ensureWorktree(`wf-${rootWi.id.slice(-8)}`);
    worktreePath = wt.path;
  }

  const run = workflowRunsV2Repo.createRun({
    workflowId: workflow.id,
    workflowName: workflow.name,
    projectId: opts.projectId,
    workflowYamlSnapshot: JSON.stringify(workflow),
    trigger: trigger.kind,
    ...(trigger.kind === 'stage-on-entry' ? { stageId: trigger.stage } : {}),
    workItemId: rootWi.id as ULID,
    worktreePath,
    status: 'running',
  });
  workflowRunsV2Repo.markStarted(run.id);

  const deps = makeExecutorDeps(
    { id: run.id, workItemId: rootWi.id as ULID, worktreePath },
    workflow,
    opts
  );
  const exec = DagExecutor.start(workflow, deps, {
    runId: run.id,
    rootWorkItemId: rootWi.id as ULID,
    worktreePath,
  });

  return { runId: run.id, rootWorkItemId: rootWi.id as ULID, done: exec.advance() };
}

/**
 * Resume a paused run to apply a review decision. Loads the run + its frozen
 * workflow + DAG state, then drives the executor's onReviewDecision.
 */
export async function applyV2ReviewDecision(
  runId: ULID,
  reviewNodeId: string,
  decision: ReviewDecision,
  opts: DagRunServiceOptions
): Promise<RunStatus | null> {
  const run = workflowRunsV2Repo.getRun(runId);
  if (!run) return null;
  const workflow = JSON.parse(run.workflowYamlSnapshot) as WorkflowV2.Workflow;
  const deps = makeExecutorDeps(
    { id: run.id, workItemId: run.workItemId, worktreePath: run.worktreePath },
    workflow,
    opts
  );
  const exec = DagExecutor.resume(workflow, run.dagState, deps, {
    runId: run.id,
    rootWorkItemId: run.workItemId,
    worktreePath: run.worktreePath,
  });
  return exec.onReviewDecision(reviewNodeId, decision);
}
