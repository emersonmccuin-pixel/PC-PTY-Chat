// Workflow runtime. Owns work-item + project read/write plus the DAG scheduler
// + per-node dispatch.
//
// Scheduler is stateless against the run row: tick loads the run, parses the
// YAML snapshot, finds ready nodes (deps satisfied per trigger_rule + when
// expression evaluates true + not yet started), dispatches each in parallel,
// updates per-node outputs, recomputes the run-level status, persists. Async
// nodes (subagent, approval) leave their nodeOutput at 'running' and exit;
// external callbacks call tick again to resume:
//   - nodeComplete(runId, nodeId, output)  ← pc_complete_node MCP tool
//   - nodeFailed(runId, nodeId, reason)    ← pc_node_failed MCP tool
//   - approval response (M10)
//
// Safety net: onTurnEnd() scans every in-progress run and marks any subagent
// node still in 'running' state as failed. Assumption: workflows are dispatched
// between orchestrator turns (UI move on an idle orchestrator OR orchestrator-
// idle channel events). Mid-orchestrator-turn dispatch (M14's pc_run_workflow)
// is dodged via setImmediate in runWorkflow so the channel POST lands in the
// next turn.

import { execFile } from 'node:child_process';
import { statSync, writeFileSync, unlinkSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import type {
  ApprovalNode,
  AttachToWorkItemNode,
  BashNode,
  CancelNode,
  CreateWorkItemNode,
  DagNode,
  HttpNode,
  LoopNode,
  NestedWorkflowNode,
  NodeOutput,
  NodeOutputStatus,
  OrchestratorReviewNode,
  Project,
  RetryCause,
  ScriptNode,
  SubagentFailureCause,
  SubagentFailureSignal,
  SubagentNode,
  ULID,
  UpdateWorkItemNode,
  WorkItem,
  Workflow,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowRunTrigger,
  WriteToWorktreeNode,
} from '@pc/domain';
import {
  applyRunOutcome,
  createRun as dbCreateRun,
  getProjectById,
  getRun as dbGetRun,
  getWorkItem,
  listActiveRuns,
  listRuns as dbListRuns,
  listRunsByProject as dbListRunsByProject,
  listWorkItems as dbListWorkItems,
  moveWorkItemStage,
  newId,
  persistRun as dbPersistRun,
  updateWorkItemFields as dbUpdateWorkItemFields,
  updateWorkItemStatus,
} from '@pc/db';
import { parseWorkflowText, type WorkflowRegistry } from '@pc/workflows';

import { runHttpStep } from './http-step.ts';
import { runAttachToWorkItemStep } from './attach-to-work-item-step.ts';
import { runCreateWorkItemStep } from './create-work-item-step.ts';
import { runUpdateWorkItemStep } from './update-work-item-step.ts';
import { runWriteToWorktreeStep } from './write-to-worktree-step.ts';
import { runOrchestratorReviewStep } from './orchestrator-review-step.ts';
import { detectRetryCause, shouldRetry } from './retry-policy.ts';
import { buildWorkflowEventHeader } from './workflow-event-header.ts';
import type { AttachmentService } from './attachment.ts';
import type { WorktreeService } from './worktree.ts';
import type { WorkItemService } from './work-item.ts';

const execFileAsync = promisify(execFile);

/** Response shape for /api/work-items — UI expects {workItems: [...]}. */
export interface WorkItemsResponse {
  workItems: WorkItem[];
}

export type EvaluateBoolean = (expression: string, run: WorkflowRun) => boolean;
export type SubstituteOutputs = (text: string, run: WorkflowRun) => string;
export type BroadcastFn = (event: unknown) => void;

const defaultEvaluateBoolean: EvaluateBoolean = () => true;
const defaultSubstituteOutputs: SubstituteOutputs = (text) => text;
const defaultBroadcast: BroadcastFn = () => {};

export interface WorkflowRuntimeOptions {
  workspaceDir: string;
  /** Default project id — apps/server bootstraps this before constructing the runtime. */
  projectId: ULID;
  /** Webhook channel port (apps/server's `/api/channel-send` proxies here too). */
  channelPort?: number;
  evaluateBoolean?: EvaluateBoolean;
  substituteOutputs?: SubstituteOutputs;
  /** WS broadcast — used by the approval dispatcher to push `approval-required` UI events. */
  broadcast?: BroadcastFn;
  /** Registry for looking up workflows by id (nested-workflow nodes + M14 triggers). */
  registry?: WorkflowRegistry;
  /** Worktree provisioning for stage-move + orchestrator-call dispatch. */
  worktrees?: WorktreeService;
  /** Optional WorkItemService — when present, createWorkItem delegates here so
   *  stage + field validation runs in one place. Not required (older test
   *  paths construct WorkflowRuntime directly without one); when missing the
   *  legacy createWorkItem path runs against the repo directly. */
  workItemService?: WorkItemService;
  /** Optional AttachmentService — required for `attach-to-work-item` routing
   *  steps (4a.5). Steps fail at dispatch with a clear error when missing. */
  attachmentService?: AttachmentService;
  /** Optional Project lookup — required for `create-work-item` routing steps
   *  to default the stage to the project's first stage when unset. */
  getProject?: () => Project;
  /** Optional lookup for the latest subagent transcript JSONL path. Threaded
   *  through ProjectRuntime — fed by the SubagentStop hook payload. Used to
   *  decorate D10 failure signals with a clickable transcript link. */
  subagentTranscriptLookup?: () => string | null;
}

const MAX_NESTING_DEPTH = 10;

export interface PendingApproval {
  workflowRunId: string;
  nodeId: string;
  message: string;
  onRejectPrompt: string | null;
}

const TERMINAL_NODE_STATUSES: ReadonlySet<NodeOutputStatus> = new Set([
  'complete',
  'failed',
  'cancelled',
  'skipped',
]);

const TERMINAL_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set([
  'complete',
  'failed',
  'cancelled',
]);

type DispatchResult =
  | { kind: 'sync'; output: NodeOutput }
  | { kind: 'async' }
  | { kind: 'cancel'; reason: string };

interface DispatchContext {
  node: DagNode;
  run: WorkflowRun;
  workflow: Workflow;
  evaluateBoolean: EvaluateBoolean;
  substituteOutputs: SubstituteOutputs;
}

type Dispatcher = (ctx: DispatchContext) => Promise<DispatchResult>;

export interface NodeUpdateResult {
  ok: boolean;
  error?: string;
}

export class WorkflowRuntime {
  private readonly evaluateBoolean: EvaluateBoolean;
  private readonly substituteOutputs: SubstituteOutputs;
  private readonly broadcast: BroadcastFn;
  private readonly channelPort: number;
  private readonly registry: WorkflowRegistry | undefined;
  private readonly worktrees: WorktreeService | undefined;
  private readonly workItemSvc: WorkItemService | undefined;
  private readonly attachmentSvc: AttachmentService | undefined;
  private readonly getProjectFn: (() => Project) | undefined;
  private readonly projectId: ULID;
  private readonly subagentTranscriptLookup: () => string | null;
  private readonly dispatchers: Record<DagNode['kind'], Dispatcher>;

  constructor(private readonly opts: WorkflowRuntimeOptions) {
    this.evaluateBoolean = opts.evaluateBoolean ?? defaultEvaluateBoolean;
    this.substituteOutputs = opts.substituteOutputs ?? defaultSubstituteOutputs;
    this.broadcast = opts.broadcast ?? defaultBroadcast;
    this.channelPort = opts.channelPort ?? 8788;
    this.registry = opts.registry;
    this.worktrees = opts.worktrees;
    this.workItemSvc = opts.workItemService;
    this.attachmentSvc = opts.attachmentService;
    this.getProjectFn = opts.getProject;
    this.projectId = opts.projectId;
    this.subagentTranscriptLookup = opts.subagentTranscriptLookup ?? (() => null);
    // 4a.8 / D18. Fire-and-forget sweep of this project's stale scratch
    // entries on construction. Runs once per WorkflowRuntime lifecycle —
    // ProjectRuntime lazy-spawns the runtime on first work-item / workflow
    // API call, so the sweep happens at that point (not at server boot for
    // every project simultaneously).
    if (this.worktrees) {
      try {
        const { removed } = this.worktrees.sweepStaleScratch();
        if (removed.length > 0) {
          console.log(
            `[workflow-runtime] scratch sweep removed ${removed.length} stale entr${removed.length === 1 ? 'y' : 'ies'}`,
          );
        }
      } catch (err) {
        console.warn(`[workflow-runtime] scratch sweep failed: ${(err as Error).message}`);
      }
    }

    this.dispatchers = {
      subagent: (ctx) => this.dispatchSubagent(ctx),
      bash: (ctx) => this.dispatchBash(ctx),
      http: (ctx) => this.dispatchHttp(ctx),
      script: (ctx) => this.dispatchScript(ctx),
      approval: (ctx) => this.dispatchApproval(ctx),
      cancel: (ctx) => this.dispatchCancel(ctx),
      workflow: (ctx) => this.dispatchNestedWorkflow(ctx),
      loop: (ctx) => this.dispatchLoop(ctx),
      'attach-to-work-item': (ctx) => this.dispatchAttachToWorkItem(ctx),
      'create-work-item': (ctx) => this.dispatchCreateWorkItem(ctx),
      'update-work-item': (ctx) => this.dispatchUpdateWorkItem(ctx),
      'write-to-worktree': (ctx) => this.dispatchWriteToWorktree(ctx),
      'orchestrator-review': (ctx) => this.dispatchOrchestratorReview(ctx),
    };
  }

  private async dispatchOrchestratorReview(ctx: DispatchContext): Promise<DispatchResult> {
    const result = await runOrchestratorReviewStep(ctx.node as OrchestratorReviewNode, ctx.run, {
      workflow: ctx.workflow,
      substituteOutputs: ctx.substituteOutputs,
      postChannel: (body) => this.postChannel(body),
      broadcast: (event) => this.broadcast(event),
    });
    if (result.kind === 'async') return { kind: 'async' };
    return { kind: 'sync', output: result.output! };
  }

  private async dispatchAttachToWorkItem(ctx: DispatchContext): Promise<DispatchResult> {
    if (!this.attachmentSvc) {
      return failedSync(
        `attach-to-work-item step requires an AttachmentService; runtime was not configured with one`,
        new Date().toISOString(),
      );
    }
    return runAttachToWorkItemStep(ctx.node as AttachToWorkItemNode, ctx.run, {
      attachmentService: this.attachmentSvc,
      workflow: ctx.workflow,
      substituteOutputs: ctx.substituteOutputs,
    });
  }

  private async dispatchCreateWorkItem(ctx: DispatchContext): Promise<DispatchResult> {
    if (!this.workItemSvc) {
      return failedSync(
        `create-work-item step requires a WorkItemService; runtime was not configured with one`,
        new Date().toISOString(),
      );
    }
    if (!this.getProjectFn) {
      return failedSync(
        `create-work-item step requires a getProject() lookup; runtime was not configured with one`,
        new Date().toISOString(),
      );
    }
    return runCreateWorkItemStep(ctx.node as CreateWorkItemNode, ctx.run, {
      workItemService: this.workItemSvc,
      getProject: this.getProjectFn,
      substituteOutputs: ctx.substituteOutputs,
    });
  }

  private async dispatchUpdateWorkItem(ctx: DispatchContext): Promise<DispatchResult> {
    if (!this.workItemSvc) {
      return failedSync(
        `update-work-item step requires a WorkItemService; runtime was not configured with one`,
        new Date().toISOString(),
      );
    }
    return runUpdateWorkItemStep(ctx.node as UpdateWorkItemNode, ctx.run, {
      workItemService: this.workItemSvc,
      substituteOutputs: ctx.substituteOutputs,
    });
  }

  private async dispatchWriteToWorktree(ctx: DispatchContext): Promise<DispatchResult> {
    return runWriteToWorktreeStep(ctx.node as WriteToWorktreeNode, ctx.run, {
      substituteOutputs: ctx.substituteOutputs,
    });
  }

  private async dispatchHttp(ctx: DispatchContext): Promise<DispatchResult> {
    return runHttpStep(ctx.node as HttpNode, ctx.run, ctx.substituteOutputs);
  }

  // ── Project / work items ─────────────────────────────────────────────────

  readProject(): Project {
    const project = getProjectById(this.projectId);
    if (!project) throw new Error(`default project not found: ${this.projectId}`);
    return project;
  }

  readWorkItems(): WorkItemsResponse {
    return { workItems: dbListWorkItems(this.projectId) };
  }

  /**
   * Move a work item to a stage and, if any workflow's `triggers.on_enter`
   * matches, fire it as a fresh run bound to the wi-<id> worktree. Four-case
   * lookup mirrors the 8b contract:
   *   none    → pure move, status reset to pending
   *   one     → ensure worktree, lock work item to in-progress, createRun + tick
   *   many    → throw "ambiguous trigger" (caller maps to HTTP 409)
   *   invalid → throw "no valid workflow" (caller maps to HTTP 409)
   *
   * Many/invalid throw BEFORE applying the move. ensureWorktree throws BEFORE
   * the move + lock so the work item stays put on dispatch failure.
   */
  async moveWorkItem(id: string, toStage: string): Promise<WorkItem> {
    const project = this.readProject();
    const stage = project.stages.find((s) => s.id === toStage);
    if (!stage) throw new Error(`unknown stage: ${toStage}`);

    const workItem = getWorkItem(id as ULID);
    if (!workItem) throw new Error(`unknown work item: ${id}`);

    if (workItem.status === 'in-progress') {
      throw new Error(`work item ${id} is locked: workflow in progress`);
    }

    const match = this.registry?.findByStageEnter(toStage) ?? { kind: 'none' as const };
    if (match.kind === 'many') {
      throw new Error(`ambiguous trigger: ${match.count} workflows match stage_id "${toStage}"`);
    }
    if (match.kind === 'invalid') {
      throw new Error(`no valid workflow for stage_id "${toStage}" (${match.count} invalid file(s))`);
    }

    if (match.kind === 'none') {
      const moved = moveWorkItemStage(id as ULID, toStage);
      if (!moved) throw new Error(`unknown work item: ${id}`);
      return moved;
    }

    // Fire workflow: ensure worktree first so a failure leaves the work item
    // where it was. Then commit the move + lock, then create the run + tick.
    let worktreePath: string | null = null;
    if (match.entry.workflow.worktree !== 'none') {
      worktreePath = await this.ensureWorktree(id);
    }
    moveWorkItemStage(id as ULID, toStage);
    updateWorkItemStatus(id as ULID, 'in-progress', null);

    const run = this.createRun({
      workflow: match.entry.workflow,
      yamlText: match.entry.yamlText,
      trigger: 'on_enter',
      workItemId: id,
      stageId: toStage,
      worktreePath,
    });
    void this.tick(run.id).catch((err) => {
      console.error('[workflow-runtime] stage-move tick failed:', (err as Error).message);
    });

    const final = getWorkItem(id as ULID);
    if (!final) throw new Error(`work item disappeared mid-move: ${id}`);
    return final;
  }

  updateWorkItem(id: string, fields: Record<string, unknown>): WorkItem {
    const updated = dbUpdateWorkItemFields(id as ULID, fields);
    if (!updated) throw new Error(`unknown work item: ${id}`);
    return updated;
  }

  createWorkItem(title: string, stageId: string, body?: string): WorkItem {
    if (this.workItemSvc) {
      return this.workItemSvc.create({
        title,
        stageId,
        ...(body !== undefined ? { body } : {}),
      });
    }
    // Legacy fallback for tests that construct WorkflowRuntime directly
    // without wiring a WorkItemService. Production paths always pass one.
    throw new Error('createWorkItem requires a WorkItemService — wire one via WorkflowRuntimeOptions.workItemService');
  }

  // ── Workflow runs ────────────────────────────────────────────────────────

  /**
   * Create a fresh WorkflowRun, persist, return. Caller should call tick(run.id)
   * to fire ready nodes. Initializes nodeOutputs with one entry per top-level
   * node at 'pending'.
   */
  createRun(args: {
    /** Optional pre-generated id (UUID string) — used by runWorkflow so the
     *  `run-<short>` worktree dir name can be derived before persistence. */
    id?: string;
    workflow: Workflow;
    yamlText: string;
    trigger: WorkflowRunTrigger;
    workItemId?: string;
    stageId?: string;
    parentRunId?: string;
    parentNodeId?: string;
    worktreePath: string | null;
    inputs?: Record<string, unknown>;
  }): WorkflowRun {
    const nodeOutputs: Record<string, NodeOutput> = {};
    for (const node of args.workflow.nodes) {
      nodeOutputs[node.id] = { status: 'pending' };
    }
    const id = (args.id ?? newId()) as ULID;
    return dbCreateRun({
      id,
      workflowId: args.workflow.id,
      workflowName: args.workflow.id,
      projectId: this.projectId,
      workflowYamlSnapshot: args.yamlText,
      trigger: args.trigger,
      workItemId: (args.workItemId as ULID | undefined) ?? null,
      stageId: args.stageId ?? null,
      parentRunId: (args.parentRunId as ULID | undefined) ?? null,
      parentNodeId: args.parentNodeId ?? null,
      worktreePath: args.worktreePath,
      ...(args.inputs ? { inputs: args.inputs } : {}),
      nodeOutputs,
    });
  }

  /** Read all workflow runs — used by the UI's run history pane (when it lands). */
  readRuns(): WorkflowRun[] {
    return dbListRuns();
  }

  /** Read this project's workflow runs (recent first). */
  readRunsForProject(): WorkflowRun[] {
    return dbListRunsByProject(this.projectId);
  }

  /**
   * Orchestrator-callable entry. Looks up `name` against the registry, applies
   * the four-case rule, checks `triggers.callable: true`, ensures a
   * `run-<short>` worktree, creates the run, and defers the first tick via
   * setImmediate (parks past the current orchestrator turn's Stop so the
   * safety net doesn't false-fail the first subagent node).
   */
  async runWorkflow(name: string, inputs?: Record<string, unknown>): Promise<WorkflowRun> {
    if (!this.registry) {
      throw new Error(`workflow registry not configured`);
    }
    this.registry.reload();
    const snapshot = this.registry.snapshot();
    const validHits = snapshot.valid.filter((e) => e.workflow.id === name);
    if (validHits.length > 1) {
      throw new Error(`ambiguous trigger: ${validHits.length} workflows match name "${name}"`);
    }
    if (validHits.length === 0) {
      const invalidHits = snapshot.invalid.filter((e) => e.fileName.startsWith(`${name}.`));
      if (invalidHits.length > 0) {
        throw new Error(`no valid workflow for name "${name}" (${invalidHits.length} invalid file(s))`);
      }
      throw new Error(`unknown workflow: "${name}"`);
    }
    const entry = validHits[0]!;
    if (entry.workflow.triggers?.callable !== true) {
      throw new Error(`workflow "${name}" is not callable (triggers.callable !== true)`);
    }

    const runId = randomUUID();
    let worktreePath: string | null = null;
    if (entry.workflow.worktree !== 'none') {
      worktreePath = await this.ensureWorktree(`run-${runId.slice(0, 8)}`);
    }

    const run = this.createRun({
      id: runId,
      workflow: entry.workflow,
      yamlText: entry.yamlText,
      trigger: 'callable',
      worktreePath,
      ...(inputs ? { inputs } : {}),
    });
    setImmediate(() => {
      void this.tick(run.id).catch((err) => {
        console.error('[workflow-runtime] runWorkflow tick failed:', (err as Error).message);
      });
    });
    return run;
  }

  /**
   * Run one scheduling pass. Loops until no sync progress is possible. Async
   * dispatch (subagent / approval) leaves the node at 'running' and tick
   * returns — external completion endpoints call tick again.
   */
  async tick(runId: string): Promise<WorkflowRun> {
    const run = this.getRun(runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return run;

    const parsed = parseWorkflowText(run.workflowYamlSnapshot, { expectedId: run.workflowId });
    if (!parsed.ok || !parsed.workflow) {
      run.status = 'failed';
      run.completedAt = new Date().toISOString();
      run.lastReason = `frozen YAML snapshot failed to parse: ${parsed.errors
        .map((e) => `${e.path}: ${e.message}`)
        .join('; ')}`;
      dbPersistRun(run);
      return run;
    }
    const workflow = parsed.workflow;

    if (run.status === 'pending') run.status = 'in-progress';

    for (let safety = 0; safety < 1000; safety++) {
      let changed = false;
      for (const node of workflow.nodes) {
        const status = run.nodeOutputs[node.id]?.status;
        if (status !== 'pending') continue;
        if (isBlocked(node, run.nodeOutputs)) {
          run.nodeOutputs[node.id] = {
            status: 'skipped',
            error: 'trigger_rule not satisfiable: upstream nodes did not meet the dependency contract',
            completedAt: new Date().toISOString(),
          };
          changed = true;
          continue;
        }
        // 4a.9 fix #1. `when: false` short-circuit. Without this, the node
        // stays 'pending' forever and downstream `all_done` trigger_rules
        // never satisfy. Mark explicit skip so downstream knows the node is
        // terminal-but-not-run.
        if (
          isDepsSatisfied(node, run.nodeOutputs) &&
          node.when &&
          !this.evaluateBoolean(node.when, run)
        ) {
          run.nodeOutputs[node.id] = {
            status: 'skipped',
            error: `when expression evaluated false: ${node.when}`,
            completedAt: new Date().toISOString(),
          };
          changed = true;
        }
      }

      const ready = findReadyNodes(workflow, run, this.evaluateBoolean);
      if (ready.length === 0) {
        if (changed) continue;
        break;
      }

      const startedAt = new Date().toISOString();
      for (const node of ready) {
        const priorAttempt = run.nodeOutputs[node.id]?.attempt;
        run.nodeOutputs[node.id] = {
          ...run.nodeOutputs[node.id],
          status: 'running',
          startedAt,
          ...(priorAttempt !== undefined ? { attempt: priorAttempt } : {}),
        };
      }
      const results = await Promise.all(ready.map((node) => this.dispatch(node, run, workflow)));

      const completedAt = new Date().toISOString();
      let cancelled = false;
      for (let i = 0; i < ready.length; i++) {
        const node = ready[i]!;
        const result = results[i]!;
        if (result.kind === 'sync') {
          if (result.output.status === 'failed') {
            const cause = detectRetryCause(result.output.error);
            const retried = await this.tryRetry(run, node, cause);
            if (retried) continue;
            run.nodeOutputs[node.id] = {
              ...result.output,
              startedAt,
              ...(run.nodeOutputs[node.id]?.attempt !== undefined
                ? { attempt: run.nodeOutputs[node.id]!.attempt }
                : {}),
            };
            if (!run.nodeOutputs[node.id]!.completedAt) {
              run.nodeOutputs[node.id]!.completedAt = completedAt;
            }
            if (node.kind === 'subagent') {
              this.broadcastSubagentFailure(
                run,
                node.id,
                'dispatch-error',
                result.output.error ?? 'subagent dispatch failed',
              );
            }
          } else {
            run.nodeOutputs[node.id] = {
              ...result.output,
              startedAt,
              ...(run.nodeOutputs[node.id]?.attempt !== undefined
                ? { attempt: run.nodeOutputs[node.id]!.attempt }
                : {}),
            };
            if (!run.nodeOutputs[node.id]!.completedAt) {
              run.nodeOutputs[node.id]!.completedAt = completedAt;
            }
            // 4a.9 fix #3. Enforce done_when on successful completion. If
            // violated, flip the node to 'failed' so downstream trigger_rule
            // sees the contract failure.
            if (run.nodeOutputs[node.id]!.status === 'complete') {
              const check = this.enforceDoneWhen(run, node);
              if (!check.ok) {
                const cause = detectRetryCause(check.error);
                const retried = await this.tryRetry(run, node, cause);
                if (retried) continue;
                run.nodeOutputs[node.id] = {
                  ...run.nodeOutputs[node.id]!,
                  status: 'failed',
                  error: check.error,
                  completedAt: new Date().toISOString(),
                };
                if (node.kind === 'subagent') {
                  this.broadcastSubagentFailure(
                    run,
                    node.id,
                    'agent-self-failed',
                    check.error ?? 'done_when violated',
                  );
                }
              }
            }
          }
        } else if (result.kind === 'cancel') {
          run.nodeOutputs[node.id] = {
            status: 'cancelled',
            error: result.reason,
            startedAt,
            completedAt,
          };
          run.status = 'cancelled';
          run.lastReason = result.reason;
          cancelled = true;
        }
      }
      if (cancelled) break;
    }

    run.status = recomputeRunStatus(workflow, run);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      run.completedAt = run.completedAt ?? new Date().toISOString();
      // 4a.9 fix #2. Populate `run.outputs` from declared `workflow.outputs`
      // keys. Walks all nodes in declaration order, last-wins. Caller (a
      // parent workflow's nested-workflow step, or `pc_run_workflow`'s
      // return value) reads these via `$<step>.output` or `run.outputs`.
      this.populateRunOutputs(workflow, run);
    }
    dbPersistRun(run);

    if (TERMINAL_RUN_STATUSES.has(run.status) && run.workItemId && !run.parentRunId) {
      this.unlockWorkItem(run);
    }

    // 4a.8 / D18. Per-run scratch cleanup. Runs only at the top-level
    // terminal status — nested runs share the parent's worktree, so their
    // scratch belongs to the parent's lifecycle.
    if (
      TERMINAL_RUN_STATUSES.has(run.status) &&
      !run.parentRunId &&
      run.worktreePath &&
      workflow.scratch_cleanup === 'auto' &&
      this.worktrees
    ) {
      try {
        this.worktrees.wipeScratchDir(run.worktreePath);
      } catch (err) {
        console.warn(
          `[workflow-runtime] wipeScratchDir(${run.worktreePath}) failed: ${(err as Error).message}`,
        );
      }
    }

    if (TERMINAL_RUN_STATUSES.has(run.status) && run.parentRunId && run.parentNodeId) {
      await this.propagateToParent(run);
    }

    // 4a.9 fix #4. Terminated-workflow ping. Only on failure / cancellation
    // for top-level runs — success doesn't need to interrupt the orchestrator,
    // and nested runs' status flows up via propagateToParent. The orchestrator
    // gets a channel event it can reflect on in its next reply; without this
    // the chat goes silent after a workflow failure.
    if (
      TERMINAL_RUN_STATUSES.has(run.status) &&
      !run.parentRunId &&
      (run.status === 'failed' || run.status === 'cancelled')
    ) {
      void this.notifyOrchestratorTerminated(run, workflow).catch((err) => {
        console.warn(
          `[workflow-runtime] terminated-workflow ping failed: ${(err as Error).message}`,
        );
      });
    }
    return run;
  }

  /** 4a.9 fix #2. Walk every node's output in declaration order and copy
   *  keys declared in `workflow.outputs` into `run.outputs`. Later nodes
   *  override earlier ones (matches "final step's output" semantic without
   *  having to define which node is "final" in a branching DAG). */
  private populateRunOutputs(workflow: Workflow, run: WorkflowRun): void {
    if (!workflow.outputs) return;
    const keys = Object.keys(workflow.outputs);
    if (keys.length === 0) return;
    const captured: Record<string, unknown> = {};
    for (const node of workflow.nodes) {
      const out = run.nodeOutputs[node.id]?.output;
      if (!out || typeof out !== 'object' || Array.isArray(out)) continue;
      const obj = out as Record<string, unknown>;
      for (const key of keys) {
        if (key in obj) captured[key] = obj[key];
      }
    }
    if (Object.keys(captured).length > 0) {
      run.outputs = captured;
    }
  }

  /** 4a.9 fix #4. POST a terminated-workflow notification to the channel so
   *  the orchestrator can reflect on it in its next reply. */
  private async notifyOrchestratorTerminated(
    run: WorkflowRun,
    workflow: Workflow,
  ): Promise<void> {
    await this.postChannel(
      buildTerminatedChannelBody({
        runId: run.id,
        workflowId: workflow.id,
        status: run.status,
        lastReason: run.lastReason ?? null,
      }),
    );
  }

  /** 4a.9 fix #3. Strict `done_when` enforcement. Returns ok=true when the
   *  contract is satisfied; ok=false + error when not. Callers flip the node
   *  status from 'complete' to 'failed' on violation. */
  private enforceDoneWhen(
    run: WorkflowRun,
    node: DagNode,
  ): { ok: boolean; error?: string } {
    if (!node.done_when) return { ok: true };
    const wt = run.worktreePath ?? this.opts.workspaceDir;
    for (const rel of node.done_when['files-non-empty'] ?? []) {
      let ok = false;
      try {
        const stat = statSync(resolve(wt, rel));
        ok = stat.isFile() && stat.size > 0;
      } catch {
        ok = false;
      }
      if (!ok) {
        return {
          ok: false,
          error: `done_when violated: file missing or empty: ${rel}`,
        };
      }
    }
    const fields = node.done_when['output-fields-non-empty'] ?? [];
    if (fields.length > 0) {
      const out = run.nodeOutputs[node.id]?.output;
      const obj = out && typeof out === 'object' && !Array.isArray(out)
        ? (out as Record<string, unknown>)
        : null;
      for (const key of fields) {
        const value = obj?.[key];
        if (isEmptyValue(value)) {
          return {
            ok: false,
            error: `done_when violated: output field empty: ${key}`,
          };
        }
      }
    }
    return { ok: true };
  }

  /**
   * Flip the work item back to pending (success) or blocked (failure /
   * cancellation) after the bound top-level run terminates.
   */
  private unlockWorkItem(run: WorkflowRun): void {
    if (!run.workItemId) return;
    const status = run.status === 'complete' ? 'pending' : 'blocked';
    const reason = run.status === 'complete'
      ? null
      : run.lastReason ?? `workflow run ${run.id} ${run.status}`;
    applyRunOutcome(
      run.workItemId as ULID,
      status,
      reason,
      `workflow ${run.workflowId} ${run.status}`,
    );
  }

  /**
   * Resolve a paused / terminal child run back into its parent's nested-workflow
   * node. Called at end-of-tick when a child terminates.
   */
  private async propagateToParent(child: WorkflowRun): Promise<void> {
    if (!child.parentRunId || !child.parentNodeId) return;
    const parent = this.tryGetRun(child.parentRunId);
    if (!parent) return;
    const parentNode = parent.nodeOutputs[child.parentNodeId];
    if (!parentNode || parentNode.status !== 'running') return;

    if (child.status === 'complete') {
      parent.nodeOutputs[child.parentNodeId] = {
        ...parentNode,
        status: 'complete',
        output: child.outputs ?? {},
        completedAt: new Date().toISOString(),
      };
    } else {
      parent.nodeOutputs[child.parentNodeId] = {
        ...parentNode,
        status: child.status === 'cancelled' ? 'cancelled' : 'failed',
        error: `child run ${child.id} ${child.status}: ${child.lastReason ?? 'no reason'}`,
        completedAt: new Date().toISOString(),
      };
    }
    dbPersistRun(parent);
    await this.tick(parent.id);
  }

  // ── Async node callbacks (subagent + approval) ────────────────────────────

  async nodeComplete(runId: string, nodeId: string, output: unknown): Promise<NodeUpdateResult> {
    const run = this.tryGetRun(runId);
    if (!run) return { ok: false, error: `unknown workflowRunId: ${runId}` };
    const current = run.nodeOutputs[nodeId];
    if (!current) return { ok: false, error: `unknown nodeId: ${nodeId}` };
    if (current.status !== 'running') {
      return { ok: false, error: `nodeId "${nodeId}" is "${current.status}", not "running"` };
    }
    run.nodeOutputs[nodeId] = {
      ...current,
      status: 'complete',
      output,
      completedAt: new Date().toISOString(),
    };
    // 4a.9 fix #3. Enforce done_when on async complete too. Subagents call
    // pc_complete_node when they think they're done; the contract still has
    // to hold.
    const node = lookupNode(run, nodeId);
    if (node) {
      const check = this.enforceDoneWhen(run, node);
      if (!check.ok) {
        const cause = detectRetryCause(check.error);
        const retried = await this.tryRetry(run, node, cause);
        if (retried) {
          dbPersistRun(run);
          await this.tick(runId);
          return { ok: true };
        }
        run.nodeOutputs[nodeId] = {
          ...run.nodeOutputs[nodeId]!,
          status: 'failed',
          error: check.error,
          completedAt: new Date().toISOString(),
        };
        dbPersistRun(run);
        if (node.kind === 'subagent') {
          this.broadcastSubagentFailure(
            run,
            nodeId,
            'agent-self-failed',
            check.error ?? 'done_when violated',
          );
        }
        await this.tick(runId);
        return { ok: true };
      }
    }
    dbPersistRun(run);
    await this.tick(runId);
    return { ok: true };
  }

  async nodeFailed(runId: string, nodeId: string, reason: string): Promise<NodeUpdateResult> {
    const run = this.tryGetRun(runId);
    if (!run) return { ok: false, error: `unknown workflowRunId: ${runId}` };
    const current = run.nodeOutputs[nodeId];
    if (!current) return { ok: false, error: `unknown nodeId: ${nodeId}` };
    if (current.status !== 'running') {
      return { ok: false, error: `nodeId "${nodeId}" is "${current.status}", not "running"` };
    }
    const node = lookupNode(run, nodeId);
    const cause = detectRetryCause(reason);
    if (node) {
      const retried = await this.tryRetry(run, node, cause);
      if (retried) {
        dbPersistRun(run);
        await this.tick(runId);
        return { ok: true };
      }
    }
    run.nodeOutputs[nodeId] = {
      ...current,
      status: 'failed',
      error: reason,
      completedAt: new Date().toISOString(),
    };
    dbPersistRun(run);
    this.broadcastSubagentFailure(run, nodeId, 'agent-self-failed', reason);
    await this.tick(runId);
    return { ok: true };
  }

  /** Build + broadcast a D10 SubagentFailureSignal. No-ops when the node isn't a
   *  subagent (failure-surfacing today only targets agent nodes). */
  private broadcastSubagentFailure(
    run: WorkflowRun,
    nodeId: string,
    cause: SubagentFailureCause,
    surfaceError: string,
  ): void {
    const agentName = lookupSubagentName(run, nodeId);
    if (agentName === null) return;
    const signal: SubagentFailureSignal = {
      workflowRunId: run.id,
      nodeId,
      agentName,
      attemptNumber: run.nodeOutputs[nodeId]?.attempt ?? 1,
      cause,
      surfaceError,
      transcriptPath: this.subagentTranscriptLookup() ?? null,
    };
    this.broadcast({
      type: 'event',
      event: {
        kind: 'subagent-failure',
        ts: new Date().toISOString(),
        ...signal,
      },
    });
  }

  async respondToApproval(
    runId: string,
    nodeId: string,
    approved: boolean,
    response: string,
  ): Promise<NodeUpdateResult> {
    const run = this.tryGetRun(runId);
    if (!run) return { ok: false, error: `unknown workflowRunId: ${runId}` };
    const current = run.nodeOutputs[nodeId];
    if (!current) return { ok: false, error: `unknown nodeId: ${nodeId}` };
    if (current.status !== 'running') {
      return { ok: false, error: `nodeId "${nodeId}" is "${current.status}", not "running"` };
    }
    const parsed = parseWorkflowText(run.workflowYamlSnapshot, { expectedId: run.workflowId });
    const node = parsed.ok ? parsed.workflow?.nodes.find((n) => n.id === nodeId) : undefined;
    if (!node || node.kind !== 'approval') {
      return { ok: false, error: `nodeId "${nodeId}" is not an approval node` };
    }
    run.nodeOutputs[nodeId] = {
      ...current,
      status: 'complete',
      output: { approved, response },
      completedAt: new Date().toISOString(),
    };
    dbPersistRun(run);
    await this.tick(runId);
    return { ok: true };
  }

  /** Active approvals (run paused + approval node still 'running'). */
  listPendingApprovals(): PendingApproval[] {
    const out: PendingApproval[] = [];
    for (const run of listActiveRuns()) {
      if (run.status !== 'paused') continue;
      const parsed = parseWorkflowText(run.workflowYamlSnapshot, { expectedId: run.workflowId });
      if (!parsed.ok || !parsed.workflow) continue;
      for (const node of parsed.workflow.nodes) {
        if (node.kind !== 'approval') continue;
        if (run.nodeOutputs[node.id]?.status !== 'running') continue;
        out.push({
          workflowRunId: run.id,
          nodeId: node.id,
          message: this.substituteOutputs(node.approval.message, run),
          onRejectPrompt: node.approval.on_reject?.prompt ?? null,
        });
      }
    }
    return out;
  }

  /**
   * Turn-end safety net. Subagent nodes still 'running' after the orchestrator's
   * turn ends are marked failed.
   */
  async onTurnEnd(): Promise<void> {
    const dirtyRuns: WorkflowRun[] = [];
    const failedNodes: Array<{ run: WorkflowRun; nodeId: string }> = [];
    for (const run of listActiveRuns()) {
      if (run.status !== 'in-progress') continue;
      const subagentNodeIds = collectSubagentNodeIds(run);
      let runChanged = false;
      for (const nodeId of subagentNodeIds) {
        const out = run.nodeOutputs[nodeId];
        if (!out || out.status !== 'running') continue;
        const reason = 'subagent returned without closing the node';
        const node = lookupNode(run, nodeId);
        if (node) {
          const retried = await this.tryRetry(run, node, 'failed');
          if (retried) {
            runChanged = true;
            continue;
          }
        }
        run.nodeOutputs[nodeId] = {
          ...out,
          status: 'failed',
          error: reason,
          completedAt: new Date().toISOString(),
        };
        runChanged = true;
        failedNodes.push({ run, nodeId });
      }
      if (runChanged) {
        dbPersistRun(run);
        dirtyRuns.push(run);
      }
    }
    for (const { run, nodeId } of failedNodes) {
      this.broadcastSubagentFailure(
        run,
        nodeId,
        'agent-returned-without-closing',
        'subagent returned without closing the node',
      );
    }
    for (const run of dirtyRuns) {
      await this.tick(run.id);
    }
  }

  /** Reset a failed node back to pending + bumped attempt counter if its
   *  retry policy allows it. Returns true when retry was scheduled. The
   *  caller's tick (loop or subsequent call) re-discovers + re-dispatches the
   *  node. */
  private async tryRetry(
    run: WorkflowRun,
    node: DagNode,
    cause: RetryCause,
  ): Promise<boolean> {
    const current = run.nodeOutputs[node.id];
    const attempt = current?.attempt ?? 1;
    if (!shouldRetry(node, attempt, cause)) return false;
    run.nodeOutputs[node.id] = {
      status: 'pending',
      attempt: attempt + 1,
    };
    const delay = node.retry?.delay_ms ?? 0;
    if (delay > 0) {
      await new Promise((res) => setTimeout(res, delay));
    }
    return true;
  }

  // ── Dispatchers ──────────────────────────────────────────────────────────

  private async dispatch(
    node: DagNode,
    run: WorkflowRun,
    workflow: Workflow,
  ): Promise<DispatchResult> {
    const dispatcher = this.dispatchers[node.kind];
    return dispatcher({
      node,
      run,
      workflow,
      evaluateBoolean: this.evaluateBoolean,
      substituteOutputs: this.substituteOutputs,
    });
  }

  private async dispatchBash(ctx: DispatchContext): Promise<DispatchResult> {
    const node = ctx.node as BashNode;
    const rendered = ctx.substituteOutputs(node.bash, ctx.run);
    const cwd = ctx.run.worktreePath ?? this.opts.workspaceDir;
    const completedAt = () => new Date().toISOString();

    try {
      const { stdout, stderr } = await execFileAsync('bash', ['-c', rendered], {
        cwd,
        timeout: node.timeout,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });
      return {
        kind: 'sync',
        output: {
          status: 'complete',
          output: { stdout, stderr, exitCode: 0 },
          completedAt: completedAt(),
        },
      };
    } catch (err) {
      const e = err as Error & {
        code?: number | string | null;
        stdout?: string;
        stderr?: string;
        signal?: string;
        killed?: boolean;
      };
      const exitCode = typeof e.code === 'number' ? e.code : -1;
      const isTimeout = e.killed === true && node.timeout !== undefined;
      const reason = isTimeout
        ? `timeout (${node.timeout}ms exceeded)`
        : `exit ${exitCode}: ${e.message}`;
      return {
        kind: 'sync',
        output: {
          status: 'failed',
          error: reason,
          output: {
            stdout: e.stdout ?? '',
            stderr: e.stderr ?? '',
            exitCode,
          },
          completedAt: completedAt(),
        },
      };
    }
  }

  private async dispatchLoop(ctx: DispatchContext): Promise<DispatchResult> {
    const node = ctx.node as LoopNode;
    const completedAt = () => new Date().toISOString();

    for (let iter = 0; iter < node.loop.max_iterations; iter++) {
      const bodyOutputs: Record<string, NodeOutput> = {};
      for (const n of node.loop.body) bodyOutputs[n.id] = { status: 'pending' };

      for (let inner = 0; inner < 1000; inner++) {
        const fakeRun: WorkflowRun = {
          ...ctx.run,
          nodeOutputs: { ...ctx.run.nodeOutputs, ...bodyOutputs },
        };

        let changed = false;
        for (const bodyNode of node.loop.body) {
          if (bodyOutputs[bodyNode.id]?.status !== 'pending') continue;
          if (isBlocked(bodyNode, bodyOutputs)) {
            bodyOutputs[bodyNode.id] = {
              status: 'skipped',
              error: 'trigger_rule not satisfiable',
              completedAt: completedAt(),
            };
            changed = true;
          }
        }

        const ready: DagNode[] = [];
        for (const bodyNode of node.loop.body) {
          if (bodyOutputs[bodyNode.id]?.status !== 'pending') continue;
          if (!isDepsSatisfied(bodyNode, bodyOutputs)) continue;
          if (bodyNode.when && !ctx.evaluateBoolean(bodyNode.when, fakeRun)) continue;
          ready.push(bodyNode);
        }

        if (ready.length === 0) {
          if (changed) continue;
          break;
        }

        const startedAt = new Date().toISOString();
        for (const bodyNode of ready) {
          bodyOutputs[bodyNode.id] = {
            ...bodyOutputs[bodyNode.id],
            status: 'running',
            startedAt,
          };
        }
        const results = await Promise.all(
          ready.map((bodyNode) => this.dispatch(bodyNode, fakeRun, ctx.workflow)),
        );

        let bodyCancelled = false;
        for (let i = 0; i < ready.length; i++) {
          const bodyNode = ready[i]!;
          const result = results[i]!;
          if (result.kind === 'sync') {
            bodyOutputs[bodyNode.id] = { ...result.output, startedAt };
            if (!bodyOutputs[bodyNode.id]!.completedAt) {
              bodyOutputs[bodyNode.id]!.completedAt = completedAt();
            }
          } else if (result.kind === 'cancel') {
            bodyOutputs[bodyNode.id] = {
              status: 'cancelled',
              error: result.reason,
              startedAt,
              completedAt: completedAt(),
            };
            bodyCancelled = true;
          } else {
            bodyOutputs[bodyNode.id] = {
              status: 'failed',
              error:
                'async dispatch (subagent / approval / nested workflow) inside a loop body is not supported in this slice',
              startedAt,
              completedAt: completedAt(),
            };
          }
        }
        if (bodyCancelled) break;
      }

      const anyBodyFailed = Object.values(bodyOutputs).some(
        (o) => o.status === 'failed' || o.status === 'cancelled' || o.status === 'skipped',
      );
      if (anyBodyFailed) {
        return failedSync(`loop body failed in iteration ${iter + 1}`, completedAt());
      }

      const fakeRunForUntil: WorkflowRun = {
        ...ctx.run,
        nodeOutputs: { ...ctx.run.nodeOutputs, ...bodyOutputs },
      };
      if (ctx.evaluateBoolean(node.loop.until, fakeRunForUntil)) {
        return {
          kind: 'sync',
          output: {
            status: 'complete',
            output: {
              iterations: iter + 1,
              last: Object.fromEntries(
                node.loop.body.map((n) => [n.id, bodyOutputs[n.id]?.output]),
              ),
            },
            completedAt: completedAt(),
          },
        };
      }
    }

    return failedSync(
      `max iterations reached (${node.loop.max_iterations})`,
      completedAt(),
    );
  }

  private async dispatchNestedWorkflow(ctx: DispatchContext): Promise<DispatchResult> {
    const node = ctx.node as NestedWorkflowNode;
    const completedAt = () => new Date().toISOString();

    if (!this.registry) {
      return failedSync(`workflow registry not configured`, completedAt());
    }
    const entry = this.registry.findByName(node.workflow);
    if (!entry) {
      return failedSync(`unknown workflow: "${node.workflow}"`, completedAt());
    }

    const ancestry = this.collectAncestryWorkflowIds(ctx.run);
    if (ancestry.includes(entry.workflow.id)) {
      return failedSync(
        `cycle: ${[...ancestry, entry.workflow.id].join(' → ')}`,
        completedAt(),
      );
    }
    if (ancestry.length >= MAX_NESTING_DEPTH) {
      return failedSync(
        `nesting depth exceeded: ${ancestry.length} >= ${MAX_NESTING_DEPTH}`,
        completedAt(),
      );
    }

    const inputs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node.inputs ?? {})) {
      inputs[k] = ctx.substituteOutputs(v, ctx.run);
    }

    const child = this.createRun({
      workflow: entry.workflow,
      yamlText: entry.yamlText,
      trigger: 'nested',
      parentRunId: ctx.run.id,
      parentNodeId: node.id,
      ...(ctx.run.workItemId ? { workItemId: ctx.run.workItemId } : {}),
      worktreePath: ctx.run.worktreePath,
      inputs,
    });

    void this.tick(child.id).catch((err) => {
      console.error('[workflow-runtime] nested-workflow child tick failed:', (err as Error).message);
    });

    return { kind: 'async' };
  }

  private async ensureWorktree(name: string): Promise<string> {
    if (!this.worktrees) {
      throw new Error('workflow runtime not configured with a WorktreeService');
    }
    const entry = await this.worktrees.ensureWorktree(name);
    // 4a.8 / D18. Set up `scratch/` + `.gitignore` on first dispatch into
    // this worktree. Idempotent — subsequent calls no-op the dir create and
    // skip the .gitignore write.
    try {
      this.worktrees.ensureScratchDir(entry.path);
    } catch (err) {
      console.warn(
        `[workflow-runtime] ensureScratchDir(${entry.path}) failed: ${(err as Error).message}`,
      );
    }
    return entry.path;
  }

  private collectAncestryWorkflowIds(run: WorkflowRun): string[] {
    const chain: string[] = [];
    let cur: WorkflowRun | undefined = run;
    while (cur) {
      chain.push(cur.workflowId);
      if (!cur.parentRunId) break;
      cur = this.tryGetRun(cur.parentRunId);
    }
    return chain;
  }

  private async dispatchCancel(ctx: DispatchContext): Promise<DispatchResult> {
    const node = ctx.node as CancelNode;
    const reason = ctx.substituteOutputs(node.cancel, ctx.run);
    return { kind: 'cancel', reason };
  }

  private async dispatchApproval(ctx: DispatchContext): Promise<DispatchResult> {
    const node = ctx.node as ApprovalNode;
    const message = ctx.substituteOutputs(node.approval.message, ctx.run);
    // Existing approval-required envelope kept for current chat UI consumers
    // (ApprovalBubble). Section 7's inbox will switch to `review-pending`.
    this.broadcast({
      type: 'event',
      event: {
        kind: 'approval-required',
        ts: new Date().toISOString(),
        workflowRunId: ctx.run.id,
        nodeId: node.id,
        message,
        on_reject_prompt: node.approval.on_reject?.prompt ?? null,
      },
    });
    this.broadcast({
      type: 'event',
      event: {
        kind: 'review-pending',
        flavor: 'human',
        ts: new Date().toISOString(),
        workflowRunId: ctx.run.id,
        nodeId: node.id,
        prompt: message,
        artifact: null,
        on_revise_prompt: node.approval.on_reject?.prompt ?? null,
      },
    });
    return { kind: 'async' };
  }

  private async dispatchScript(ctx: DispatchContext): Promise<DispatchResult> {
    const node = ctx.node as ScriptNode;
    const rendered = ctx.substituteOutputs(node.script, ctx.run);
    const cwd = ctx.run.worktreePath ?? this.opts.workspaceDir;
    const ext = node.runtime === 'node' ? '.js' : '.py';
    const runner = node.runtime === 'node' ? 'node' : 'python';
    const tmpFile = resolve(tmpdir(), `pc-script-${randomUUID()}${ext}`);

    try {
      writeFileSync(tmpFile, rendered);
      const { stdout, stderr } = await execFileAsync(runner, [tmpFile], {
        cwd,
        timeout: node.timeout,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });
      return {
        kind: 'sync',
        output: {
          status: 'complete',
          output: { stdout, stderr, exitCode: 0 },
          completedAt: new Date().toISOString(),
        },
      };
    } catch (err) {
      const e = err as Error & {
        code?: number | string | null;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      };
      const exitCode = typeof e.code === 'number' ? e.code : -1;
      const isTimeout = e.killed === true && node.timeout !== undefined;
      return {
        kind: 'sync',
        output: {
          status: 'failed',
          error: isTimeout
            ? `timeout (${node.timeout}ms exceeded)`
            : `exit ${exitCode}: ${e.message}`,
          output: {
            stdout: e.stdout ?? '',
            stderr: e.stderr ?? '',
            exitCode,
          },
          completedAt: new Date().toISOString(),
        },
      };
    } finally {
      try { unlinkSync(tmpFile); } catch { /* best-effort */ }
    }
  }

  private async dispatchSubagent(ctx: DispatchContext): Promise<DispatchResult> {
    const node = ctx.node as SubagentNode;
    const rendered = ctx.substituteOutputs(node.prompt, ctx.run);
    // 4a.2 / D16: agent name may be `$inputs.<key>` — resolve at dispatch.
    // Empty / whitespace-only after substitution means the caller didn't
    // pass the input the workflow declared; fail fast with a clear reason.
    const resolvedAgent = ctx.substituteOutputs(node.subagent, ctx.run).trim();
    if (!resolvedAgent) {
      return {
        kind: 'sync',
        output: {
          status: 'failed',
          error: `agent name resolved to empty (raw: "${node.subagent}"; check the workflow's inputs and the caller's input map)`,
          completedAt: new Date().toISOString(),
        },
      };
    }
    const body = buildSubagentChannelBody({
      runId: ctx.run.id,
      nodeId: node.id,
      subagent: resolvedAgent,
      workflowId: ctx.workflow.id,
      worktreePath: ctx.run.worktreePath,
      prompt: rendered,
    });

    try {
      await this.postChannel(body);
    } catch (err) {
      return {
        kind: 'sync',
        output: {
          status: 'failed',
          error: `channel POST failed: ${(err as Error).message}`,
          completedAt: new Date().toISOString(),
        },
      };
    }
    return { kind: 'async' };
  }

  /** 4c / D33–D34. POSTs `body` to the channel server's path-routed entry.
   *  Slug comes from the `getProject` callback (threaded at construction).
   *  `source` is the second URL segment — defaults to `"workflow"` since every
   *  workflow-runtime POST originates from the workflow runtime. */
  private async postChannel(body: string, source = 'workflow'): Promise<void> {
    const slug = this.getProjectFn?.().slug;
    if (!slug) {
      throw new Error(
        'workflow-runtime postChannel requires a getProject() lookup with a slug; runtime was not configured with one',
      );
    }
    const path = `/channel/${encodeURIComponent(slug)}/${encodeURIComponent(source)}`;
    await new Promise<void>((res, rej) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: this.channelPort,
          method: 'POST',
          path,
          headers: {
            'X-Sender': 'test',
            'Content-Type': 'text/plain',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (r) => {
          const chunks: Buffer[] = [];
          r.on('data', (c) => chunks.push(c as Buffer));
          r.on('end', () => {
            const status = r.statusCode ?? 0;
            if (status >= 200 && status < 300) res();
            else rej(new Error(`channel POST status ${status}: ${Buffer.concat(chunks).toString()}`));
          });
        },
      );
      req.on('error', rej);
      req.write(body);
      req.end();
    });
  }

  // ── Persistence helpers ─────────────────────────────────────────────────

  private getRun(runId: string): WorkflowRun {
    const run = this.tryGetRun(runId);
    if (!run) throw new Error(`unknown workflowRunId: ${runId}`);
    return run;
  }

  private tryGetRun(runId: string): WorkflowRun | undefined {
    return dbGetRun(runId as ULID) ?? undefined;
  }
}

// ── Pure helpers ───────────────────────────────────────────────────────────

function findReadyNodes(
  workflow: Workflow,
  run: WorkflowRun,
  evaluateBoolean: EvaluateBoolean,
): DagNode[] {
  const ready: DagNode[] = [];
  for (const node of workflow.nodes) {
    const status = run.nodeOutputs[node.id]?.status;
    if (status !== 'pending') continue;
    if (!isDepsSatisfied(node, run.nodeOutputs)) continue;
    if (node.when && !evaluateBoolean(node.when, run)) continue;
    ready.push(node);
  }
  return ready;
}

function isDepsSatisfied(node: DagNode, outputs: Record<string, NodeOutput>): boolean {
  const deps = node.depends_on ?? [];
  if (deps.length === 0) return true;
  const rule = node.trigger_rule ?? 'all_success';
  const statuses = deps.map((d) => outputs[d]?.status ?? 'pending');

  const isDone = (s: NodeOutputStatus | undefined) =>
    s !== undefined && TERMINAL_NODE_STATUSES.has(s);

  switch (rule) {
    case 'all_success':
      return statuses.every((s) => s === 'complete');
    case 'one_success':
      return statuses.some((s) => s === 'complete');
    case 'all_done':
      return statuses.every(isDone);
    case 'none_failed_min_one_success':
      return (
        statuses.every(isDone) &&
        statuses.every((s) => s !== 'failed' && s !== 'cancelled') &&
        statuses.some((s) => s === 'complete')
      );
  }
}

function isBlocked(node: DagNode, outputs: Record<string, NodeOutput>): boolean {
  const deps = node.depends_on ?? [];
  if (deps.length === 0) return false;
  const rule = node.trigger_rule ?? 'all_success';
  const statuses = deps.map((d) => outputs[d]?.status ?? 'pending');

  switch (rule) {
    case 'all_success':
      return statuses.some(
        (s) => s === 'failed' || s === 'cancelled' || s === 'skipped',
      );
    case 'one_success':
      return (
        statuses.every((s) => s !== undefined && TERMINAL_NODE_STATUSES.has(s)) &&
        statuses.every((s) => s !== 'complete')
      );
    case 'all_done':
      return false;
    case 'none_failed_min_one_success':
      return statuses.some((s) => s === 'failed' || s === 'cancelled');
  }
}

function recomputeRunStatus(workflow: Workflow, run: WorkflowRun): WorkflowRunStatus {
  if (run.status === 'cancelled') return run.status;

  const triples = workflow.nodes.map((n) => ({
    kind: n.kind,
    status: run.nodeOutputs[n.id]?.status ?? 'pending',
  }));

  if (
    triples.some(
      (t) =>
        (t.kind === 'approval' || t.kind === 'orchestrator-review') &&
        t.status === 'running',
    )
  ) {
    return 'paused';
  }

  if (triples.some((t) => t.status === 'running' || t.status === 'pending')) return 'in-progress';

  const anyFailedOrBlocked = triples.some(
    (t) => t.status === 'failed' || t.status === 'cancelled' || t.status === 'skipped',
  );
  return anyFailedOrBlocked ? 'failed' : 'complete';
}

/** Look up a node by id from the run's frozen YAML snapshot. Returns
 *  undefined when the snapshot fails to reparse or the id isn't found. */
function lookupNode(run: WorkflowRun, nodeId: string): DagNode | undefined {
  const parsed = parseWorkflowText(run.workflowYamlSnapshot, { expectedId: run.workflowId });
  if (!parsed.ok || !parsed.workflow) return undefined;
  return parsed.workflow.nodes.find((n) => n.id === nodeId);
}

/** "Empty" per the DoneWhen output-fields-non-empty spec: null/undefined,
 *  trimmed-empty string, [], {}. `0` and `false` pass. */
function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function collectSubagentNodeIds(run: WorkflowRun): string[] {
  const parsed = parseWorkflowText(run.workflowYamlSnapshot, { expectedId: run.workflowId });
  if (!parsed.ok || !parsed.workflow) return [];
  return parsed.workflow.nodes.filter((n) => n.kind === 'subagent').map((n) => n.id);
}

/** Returns the `subagent:` field for a node, or null if the node isn't a
 *  subagent node (or the YAML snapshot fails to reparse). */
function lookupSubagentName(run: WorkflowRun, nodeId: string): string | null {
  const parsed = parseWorkflowText(run.workflowYamlSnapshot, { expectedId: run.workflowId });
  if (!parsed.ok || !parsed.workflow) return null;
  const node = parsed.workflow.nodes.find((n) => n.id === nodeId);
  if (!node || node.kind !== 'subagent') return null;
  return (node as SubagentNode).subagent;
}

export function buildTerminatedChannelBody(args: {
  runId: string;
  workflowId: string;
  status: WorkflowRunStatus;
  lastReason: string | null;
}): string {
  return [
    buildWorkflowEventHeader('terminated'),
    `Workflow run terminated: workflow="${args.workflowId}" status="${args.status}".`,
    args.lastReason ? `Reason: ${args.lastReason}` : '',
    `[workflowRunId: ${args.runId}]`,
    ``,
    `The workflow won't resume on its own. Reflect this in your reply to the user; if action is needed (retry, adjust inputs, file a bug), surface it now.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function buildSubagentChannelBody(args: {
  runId: string;
  nodeId: string;
  subagent: string;
  workflowId: string;
  worktreePath: string | null;
  prompt: string;
}): string {
  const wtToken = args.worktreePath ? ` [worktree: ${args.worktreePath}]` : '';
  return [
    buildWorkflowEventHeader('subagent-dispatch'),
    `Workflow event: workflow="${args.workflowId}" node="${args.nodeId}" subagent="${args.subagent}".`,
    ``,
    `Delegate to subagent "${args.subagent}". Pass this prompt verbatim (keep the tokens intact):`,
    ``,
    args.prompt,
    ``,
    `[workflowRunId: ${args.runId}] [nodeId: ${args.nodeId}]${wtToken}`,
    ``,
    `The subagent MUST close this node before returning to you. On success it calls pc_complete_node({ workflowRunId, nodeId, output }); on hard failure it calls pc_node_failed({ workflowRunId, nodeId, reason }). If the subagent returns without either, the turn-end safety net marks the node failed.`,
  ].join('\n');
}

function failedSync(error: string, completedAt: string): DispatchResult {
  return {
    kind: 'sync',
    output: { status: 'failed', error, completedAt },
  };
}
