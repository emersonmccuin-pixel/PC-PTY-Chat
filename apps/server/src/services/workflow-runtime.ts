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
import { mkdirSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  getRunForProject as dbGetRunForProject,
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
import {
  parseTypedWorkflowText,
  parseWorkflowText,
  type WorkflowRegistry,
} from '@pc/workflows';
import type { NodeEdges } from '@pc/domain';
import {
  encodeCwdForClaude,
  spawnSubagent as defaultSpawnSubagent,
  type SubagentSpawnHandle,
  type SubagentSpawnRequest,
} from '@pc/runtime';

import { runHttpStep } from './http-step.ts';
import { runAttachToWorkItemStep } from './attach-to-work-item-step.ts';
import { runCreateWorkItemStep } from './create-work-item-step.ts';
import { runUpdateWorkItemStep } from './update-work-item-step.ts';
import { runWriteToWorktreeStep } from './write-to-worktree-step.ts';
import { runOrchestratorReviewStep } from './orchestrator-review-step.ts';
import { detectRetryCause, shouldRetry } from './retry-policy.ts';
import { buildWorkflowEventHeader } from './workflow-event-header.ts';
import {
  applyTypedPortEdges,
  makeNodeBoundSubstituter,
  type TypedRefContext,
} from './typed-substitution.ts';
import { validateSubagentOutput } from './subagent-output-validation.ts';
import type { AttachmentService } from './attachment.ts';
import type { WorktreeService } from './worktree.ts';
import type { MoveWorkItemServiceInput, WorkItemService } from './work-item.ts';

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
  /** WS broadcast. Used by:
   *
   *  - the approval dispatcher → `approval-required` / `review-pending` envelopes;
   *  - the subagent failure path → `event` wrappers around D10 SubagentFailureSignals;
   *  - the work-items mirror → `work-items-changed` on stage moves;
   *  - **Section 4e.3 / D52** — every run-state transition fires
   *    `{ type: 'workflow-run-changed', projectId, workflowId, runId, status, nodeOutputs }`.
   *    Invariant: broadcast immediately AFTER each `dbPersistRun(run)` call inside this
   *    class (use `persistAndBroadcast`) so subscribers only ever see envelopes that
   *    reflect the row as-persisted. The runs drawer (4e.5) subscribes on open and
   *    filters by workflowId; the envelope carries enough state to merge into the
   *    list / detail views without a refetch. */
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
  /** Factory for per-dispatch session data dirs. Section 4d's subagent
   *  spawner writes `stop-markers.txt` / `events.jsonl` / `transcript.log`
   *  inside the returned dir; the runtime mkdirs it before spawn. ProjectRuntime
   *  provides one that returns `<dataPath>/sessions/<pcSessionId>`. Without
   *  this, subagent dispatch fails at the boundary with a clear error. */
  subagentSessionDirFor?: (pcSessionId: string) => string;
  /** Override the spawner implementation. Defaults to the real `spawnSubagent`
   *  from `@pc/runtime`. Tests inject a stub that resolves synthetic results
   *  without booting claude.exe. */
  subagentSpawner?: typeof defaultSpawnSubagent;
  /** Root of CC's per-project JSONL dirs. Used by the spawner-input path to
   *  snapshot already-claimed JSONL files in the helper's worktree, so two
   *  parallel dispatches in the same worktree don't latch onto each other's
   *  JSONL. Defaults to `<homedir>/.claude/projects`. Override for tests. */
  claudeProjectsDir?: string;
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
  /** Per-workflow typed-edge map (4h.5). Carried so loop bodies can resolve
   *  their inner nodes' typed wires (same flat map covers nested loop nodes
   *  per the typed parser's recursive walk). */
  edges: Readonly<Record<string, NodeEdges>>;
  evaluateBoolean: EvaluateBoolean;
  /** Node-bound substituter (4h.5). `{{ name }}` placeholders resolve from
   *  this node's `wire:` block; legacy `$X.Y` patterns fall through to the
   *  raw substituter until 4h.9 drops the latter. */
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
  private readonly subagentSessionDirFor: ((pcSessionId: string) => string) | null;
  private readonly subagentSpawnerImpl: typeof defaultSpawnSubagent;
  private readonly claudeProjectsDir: string;
  /** Section 4d. Per-(runId:nodeId) memory of the spawned helper's transcript
   *  path, populated synchronously at dispatch time off the spawn handle and
   *  read back when broadcasting D10 subagent-failure signals. Cleared once
   *  the node settles (complete / failed). Replaces the pre-4d
   *  `subagentTranscriptLookup` callback which sourced from the orchestrator's
   *  SubagentStop hook (dead path now — orchestrator no longer dispatches
   *  helpers). */
  private readonly subagentTranscriptsByNode: Map<string, string> = new Map();
  /** Section 4d. In-flight spawn handles keyed by `${runId}:${nodeId}`. Kept
   *  so a future cancel-run path (4f) can kill helpers mid-flight. Cleared
   *  once the node settles. */
  private readonly inflightSubagentHandles: Map<string, SubagentSpawnHandle> = new Map();
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
    this.subagentSessionDirFor = opts.subagentSessionDirFor ?? null;
    this.subagentSpawnerImpl = opts.subagentSpawner ?? defaultSpawnSubagent;
    this.claudeProjectsDir = opts.claudeProjectsDir ?? join(homedir(), '.claude', 'projects');
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

  /** Section 4e.3 / D52. Persist run state, then fire the
   *  `workflow-run-changed` envelope. ALL in-class persistence of a run goes
   *  through here — direct `dbPersistRun(run)` calls would silently skip the
   *  broadcast and leave the drawer (4e.5) stale until a refetch. The
   *  envelope is fire-and-forget; broadcast failures must not unwind the
   *  persisted state. */
  private persistAndBroadcast(run: WorkflowRun): void {
    dbPersistRun(run);
    this.broadcastRunChanged(run);
  }

  private broadcastRunChanged(run: WorkflowRun): void {
    try {
      this.broadcast({
        type: 'workflow-run-changed',
        projectId: this.projectId,
        workflowId: run.workflowId,
        runId: run.id,
        status: run.status,
        nodeOutputs: run.nodeOutputs,
      });
    } catch (err) {
      console.warn(
        `[workflow-runtime] workflow-run-changed broadcast failed for ${run.id}: ${(err as Error).message}`,
      );
    }
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
   * matches, fire it. Thin wrapper around `moveAndFire` preserved for the
   * chat/MCP path which doesn't have a `version` to check (callers route
   * through `WorkflowRuntime.moveWorkItem(id, toStage)` historically).
   */
  async moveWorkItem(id: string, toStage: string): Promise<WorkItem> {
    return this.moveAndFire({ id, toStage });
  }

  /**
   * Shared move + workflow-firing path used by both the drag endpoint and the
   * chat/MCP move endpoint (4c.3 / D36 / D37). Four-case lookup mirrors the 8b
   * contract:
   *   none    → pure move, status reset to pending
   *   one     → ensure worktree, version-checked move, lock to in-progress,
   *             createRun + tick
   *   many    → throw "ambiguous trigger" (caller maps to HTTP 409)
   *   invalid → throw "no valid workflow" (caller maps to HTTP 409)
   *
   * Pre-checks (ambiguity / invalid / ensureWorktree) run BEFORE any DB write
   * so the work item stays put on dispatch failure. When `expectedVersion` is
   * supplied the move routes through `WorkItemService.move()` which throws
   * `WorkItemVersionConflictError` on mismatch — the card stays put in that
   * case too (the conflict throws after pre-checks but before any state
   * change). After the version-checked move succeeds, workflow firing
   * (lock + createRun + tick) is committed atomically — the card never sits
   * in the target stage with no workflow run attached when one was expected.
   */
  async moveAndFire(args: {
    id: string;
    toStage: string;
    expectedVersion?: number;
    position?: number;
  }): Promise<WorkItem> {
    const { id, toStage, expectedVersion, position } = args;
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

    // 4f / D62. Disabled workflows behave as if no workflow matched the
    // stage — the move is a pure move with no firing. Treating disabled as
    // `kind=none` (vs. throwing) keeps the user's drag-and-drop unbroken
    // even when the workflow they expected to fire has been paused.
    const disabled = match.kind === 'one' && match.entry.workflow.disabled === true;

    // ensureWorktree before any move so a worktree-provision failure leaves
    // the work item where it was.
    let worktreePath: string | null = null;
    if (match.kind === 'one' && !disabled && match.entry.workflow.worktree !== 'none') {
      worktreePath = await this.ensureWorktree(id);
    }

    // Commit the move — version-checked when `expectedVersion` is supplied.
    const moved = this.commitMove(id, toStage, expectedVersion, position);

    if (match.kind === 'none' || disabled) return moved;

    // Workflow firing is committed atomically with the lock.
    updateWorkItemStatus(id as ULID, 'in-progress', null);

    // Work Contract Layer 1 (2026-05-19, see docs/design/work-contract.md):
    // the on_enter fire-path has natural context (workItemId + stageId). Fill
    // run.inputs for whichever keys the workflow declared. Principle:
    // declarations are the contract; fire-path fills natural context only for
    // declared inputs. No magic — caller-explicit and workflow-declared.
    const onEnterInputs = pickDeclaredInputs(match.entry.workflow, {
      workItemId: id,
      stageId: toStage,
    });

    const run = this.createRun({
      workflow: match.entry.workflow,
      yamlText: match.entry.yamlText,
      trigger: 'on_enter',
      workItemId: id,
      stageId: toStage,
      worktreePath,
      ...(Object.keys(onEnterInputs).length > 0 ? { inputs: onEnterInputs } : {}),
    });
    void this.tick(run.id).catch((err) => {
      console.error('[workflow-runtime] stage-move tick failed:', (err as Error).message);
    });

    const final = getWorkItem(id as ULID);
    if (!final) throw new Error(`work item disappeared mid-move: ${id}`);
    this.broadcast({ type: 'work-items-changed', change: 'moved', workItem: final });
    return final;
  }

  /** Commits the stage move. Routes through `WorkItemService.move()` (which
   *  does version-check + broadcast) when `expectedVersion` is provided.
   *  Falls back to the raw repo path used by the legacy chat/MCP move route
   *  when no expectedVersion is supplied. */
  private commitMove(
    id: string,
    toStage: string,
    expectedVersion: number | undefined,
    position: number | undefined,
  ): WorkItem {
    if (expectedVersion !== undefined && this.workItemSvc) {
      const input: MoveWorkItemServiceInput = { expectedVersion, stageId: toStage };
      if (position !== undefined) input.position = position;
      return this.workItemSvc.move(id as ULID, input);
    }
    const moved = moveWorkItemStage(id as ULID, toStage);
    if (!moved) throw new Error(`unknown work item: ${id}`);
    return moved;
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
    /** Seed nodeOutputs — used by retry-from to carry forward complete
     *  steps from the prior run. Defaults to every node at `pending`. */
    nodeOutputs?: Record<string, NodeOutput>;
    /** Section 4e.2. Free-form metadata captured at row creation. Used for
     *  retry-from lineage today. */
    metadata?: Record<string, unknown>;
  }): WorkflowRun {
    const seededOutputs = args.nodeOutputs;
    const nodeOutputs: Record<string, NodeOutput> = {};
    for (const node of args.workflow.nodes) {
      nodeOutputs[node.id] = seededOutputs?.[node.id] ?? { status: 'pending' };
    }
    const id = (args.id ?? newId()) as ULID;
    const run = dbCreateRun({
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
      ...(args.metadata ? { metadata: args.metadata } : {}),
    });
    // 4e.3 / D52. Initial-state envelope so the runs drawer sees the new
    // row appear in real time without waiting on the first tick to land.
    this.broadcastRunChanged(run);
    return run;
  }

  /** Read all workflow runs — used by the UI's run history pane (when it lands). */
  readRuns(): WorkflowRun[] {
    return dbListRuns();
  }

  /** Read this project's workflow runs (recent first). */
  readRunsForProject(): WorkflowRun[] {
    return dbListRunsByProject(this.projectId);
  }

  /** Section 4e.1. Read one run, scoped to this project. Returns null when
   *  the run doesn't exist OR belongs to a different project (treated
   *  identically — 404 from the HTTP layer either way). The full
   *  `nodeOutputs` map is included, unlike the list endpoint. */
  readRunForProject(runId: string): WorkflowRun | null {
    return dbGetRunForProject(runId as ULID, this.projectId);
  }

  /** Section 4e.2 / D53. Re-fire a failed run from a specific failed node.
   *  Creates a NEW run row (history-preserving — the original failure stays
   *  intact for inspection). Lineage metadata + carry-forward semantics:
   *
   *   - Same workflowId, same inputs, same workItemId / stageId.
   *   - `metadata.reFiredFromRunId` + `metadata.reFiredFromNodeId` point
   *     back at the source.
   *   - Any node currently `complete` in the prior run keeps its output
   *     (we don't pay to re-run already-successful work). Everything else
   *     resets to `{ status: 'pending' }` — the target failed node and any
   *     downstream pending/skipped/cancelled nodes re-run on the next tick.
   *   - `attempt` counter resets to 1 in the new run; the D17 same-run
   *     retry counter stays scoped to its own run.
   *   - Original run's `lastReason` gets a " · re-fired as <new-run-id>"
   *     suffix appended so the UI can surface the lineage on both ends.
   *
   *  Validation: target run must be `failed` or `cancelled`, target node
   *  must be `failed` in that run. Mismatches return { ok: false, error }
   *  for the HTTP layer to surface as 400. Cross-project + unknown run
   *  return 404 via the route. */
  async retryFromFailedNode(
    runId: string,
    nodeId: string,
  ): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
    const prior = dbGetRunForProject(runId as ULID, this.projectId);
    if (!prior) return { ok: false, error: `unknown run: ${runId}` };
    if (prior.status !== 'failed' && prior.status !== 'cancelled') {
      return {
        ok: false,
        error: `run is "${prior.status}", retry-from requires "failed" or "cancelled"`,
      };
    }
    const priorNodeOutput = prior.nodeOutputs[nodeId];
    if (!priorNodeOutput) {
      return { ok: false, error: `unknown nodeId in run: ${nodeId}` };
    }
    if (priorNodeOutput.status !== 'failed') {
      return {
        ok: false,
        error: `node "${nodeId}" is "${priorNodeOutput.status}", retry-from requires "failed"`,
      };
    }

    const parsed = parseWorkflowText(prior.workflowYamlSnapshot, {
      expectedId: prior.workflowId,
    });
    if (!parsed.ok || !parsed.workflow) {
      return {
        ok: false,
        error: `frozen YAML snapshot failed to parse: ${parsed.errors
          .map((e) => `${e.path}: ${e.message}`)
          .join('; ')}`,
      };
    }
    const workflow = parsed.workflow;

    // Carry-forward seed: any `complete` node in the prior run keeps its
    // output (drop attempt so it presents as a clean first attempt in the
    // new run). The runtime's tick() will treat these as already-done deps.
    const seededOutputs: Record<string, NodeOutput> = {};
    for (const node of workflow.nodes) {
      const prev = prior.nodeOutputs[node.id];
      if (prev?.status === 'complete') {
        const carried: NodeOutput = {
          status: 'complete',
          ...(prev.output !== undefined ? { output: prev.output } : {}),
          ...(prev.startedAt ? { startedAt: prev.startedAt } : {}),
          ...(prev.completedAt ? { completedAt: prev.completedAt } : {}),
          ...(prev.transcriptPath ? { transcriptPath: prev.transcriptPath } : {}),
        };
        seededOutputs[node.id] = carried;
      } else {
        seededOutputs[node.id] = { status: 'pending' };
      }
    }

    const newRun = this.createRun({
      workflow,
      yamlText: prior.workflowYamlSnapshot,
      trigger: 'callable',
      ...(prior.workItemId ? { workItemId: prior.workItemId } : {}),
      ...(prior.stageId ? { stageId: prior.stageId } : {}),
      worktreePath: prior.worktreePath,
      ...(prior.inputs ? { inputs: prior.inputs } : {}),
      nodeOutputs: seededOutputs,
      metadata: {
        ...(prior.metadata ?? {}),
        reFiredFromRunId: prior.id,
        reFiredFromNodeId: nodeId,
      },
    });

    // Append the lineage suffix to the prior run's lastReason so the
    // "open old failed run" surface can show "re-fired as <new-id>".
    const lineageSuffix = ` · re-fired as ${newRun.id}`;
    const refreshedPrior = dbGetRunForProject(prior.id as ULID, this.projectId);
    if (refreshedPrior) {
      const existing = refreshedPrior.lastReason ?? '';
      refreshedPrior.lastReason = existing.includes(lineageSuffix)
        ? existing
        : `${existing}${lineageSuffix}`;
      this.persistAndBroadcast(refreshedPrior);
    }

    setImmediate(() => {
      void this.tick(newRun.id).catch((err) => {
        console.error(
          '[workflow-runtime] retryFromFailedNode tick failed:',
          (err as Error).message,
        );
      });
    });

    return { ok: true, runId: newRun.id };
  }

  /**
   * Section 4f / D60. Return every in-flight run (pending / in-progress /
   * paused) for a given workflow id in this project. The DELETE endpoint
   * uses this to surface a 409 with the run-id list when the user tries to
   * delete a workflow with live runs attached.
   */
  inFlightRunsForWorkflow(workflowId: string): WorkflowRun[] {
    const all = listActiveRuns().filter(
      (r) => r.workflowId === workflowId,
    );
    // The active-runs query is global; scope to this project by reading
    // each row's projectId via dbGetRunForProject (the in-memory shape
    // doesn't carry projectId). One round-trip per in-flight row is cheap —
    // a workflow rarely has many simultaneous active runs.
    return all.filter(
      (r) => dbGetRunForProject(r.id as ULID, this.projectId) !== null,
    );
  }

  /**
   * Section 4f / D60. Externally-triggered cancel for an in-flight run.
   * Marks the run cancelled, kills any in-flight subagent helpers, persists
   * the new state, broadcasts, unlocks the attached work item. Idempotent:
   * a run already in a terminal state returns { ok: false, error: ... }
   * (the caller distinguishes "already done" from "cancelled now"). Used by
   * the cancel-runs-then-delete escape path.
   */
  async cancelRunExternal(
    runId: string,
    reason: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const run = dbGetRunForProject(runId as ULID, this.projectId);
    if (!run) return { ok: false, error: `unknown run: ${runId}` };
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return { ok: false, error: `run is already ${run.status}` };
    }
    // Kill any in-flight subagent helpers for this run before flipping
    // status. Spawn handles are keyed `${runId}:${nodeId}`; iterate-by-prefix.
    const killPrefix = `${runId}:`;
    for (const [key, handle] of this.inflightSubagentHandles) {
      if (!key.startsWith(killPrefix)) continue;
      try {
        handle.kill('cancelled');
      } catch (err) {
        console.warn(
          `[workflow-runtime] cancelRunExternal: kill ${key} failed: ${(err as Error).message}`,
        );
      }
      this.inflightSubagentHandles.delete(key);
    }
    const completedAt = new Date().toISOString();
    // Mark any non-terminal node outputs as cancelled so the run-detail
    // view reads coherently. Completed nodes stay completed.
    for (const [nodeId, output] of Object.entries(run.nodeOutputs)) {
      if (output.status === 'complete' || output.status === 'failed') continue;
      run.nodeOutputs[nodeId] = {
        ...output,
        status: 'cancelled',
        error: reason,
        completedAt,
      };
    }
    run.status = 'cancelled';
    run.lastReason = reason;
    run.completedAt = completedAt;
    this.persistAndBroadcast(run);
    if (run.workItemId && !run.parentRunId) this.unlockWorkItem(run);
    return { ok: true };
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
    // 4f / D62. External fire-paths (orchestrator-callable + future manual-
    // fire) refuse a disabled workflow. Nested `call-workflow` is exempt by
    // intent — a parent already running can finish out a chain it started.
    if (entry.workflow.disabled === true) {
      throw new Error(`workflow "${name}" is disabled`);
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
   * Section 4f.3 / D64. User-initiated manual fire from the WorkflowList
   * "Run now" menu. Looks up by workflow id (not name); enforces D62 (no
   * disabled) + D67/D71 Work Contract; locks the attached card on the same
   * symmetric `in-progress → unlockWorkItem` lifecycle used by the on_enter
   * (drag-fire) path; merges natural context (workItemId + stageId) for
   * declared `inputs:` keys + layers user-supplied inputs on top.
   *
   * Error shapes are caller-readable strings; the HTTP route maps them to
   * 4xx codes. Fire-time required-inputs check (D71) lands with 4f.4 — this
   * method enforces the Work Contract surface only.
   */
  async fireManually(args: {
    workflowId: string;
    workItemId?: string;
    inputs?: Record<string, unknown>;
  }): Promise<WorkflowRun> {
    if (!this.registry) {
      throw new Error(`workflow registry not configured`);
    }
    this.registry.reload();
    const snapshot = this.registry.snapshot();
    const validHits = snapshot.valid.filter((e) => e.workflow.id === args.workflowId);
    if (validHits.length === 0) {
      const invalidHits = snapshot.invalid.filter((e) =>
        e.fileName.startsWith(`${args.workflowId}.`),
      );
      if (invalidHits.length > 0) {
        throw new Error(
          `no valid workflow for id "${args.workflowId}" (${invalidHits.length} invalid file(s))`,
        );
      }
      throw new Error(`unknown workflow: "${args.workflowId}"`);
    }
    if (validHits.length > 1) {
      throw new Error(
        `ambiguous workflow id: ${validHits.length} files declare id "${args.workflowId}"`,
      );
    }
    const entry = validHits[0]!;
    const workflow = entry.workflow;

    if (workflow.disabled === true) {
      throw new Error(`workflow "${args.workflowId}" is disabled`);
    }

    const attached = workflow.attached_to_work_item ?? 'optional';
    if (attached === 'required' && !args.workItemId) {
      throw new Error(`workflow "${args.workflowId}" requires a work item to run`);
    }
    if (attached === 'forbidden' && args.workItemId) {
      throw new Error(`workflow "${args.workflowId}" cannot be attached to a work item`);
    }

    // Resolve the attached card (when present) and check the lock. Matches
    // moveAndFire's drag-fire guard so two fire-paths can't double-dispatch
    // on the same card.
    let stageId: string | undefined;
    if (args.workItemId) {
      const wi = getWorkItem(args.workItemId as ULID);
      if (!wi) {
        throw new Error(`unknown work item: ${args.workItemId}`);
      }
      if (wi.status === 'in-progress') {
        throw new Error(`work item ${args.workItemId} is locked: workflow in progress`);
      }
      stageId = wi.stageId;
    }

    // Build run.inputs: natural context (workItemId + stageId) filtered to
    // declared keys, then user-supplied inputs layered on top. Caller-
    // explicit wins; the natural context is a courtesy fill for declared
    // keys that match. 4f.4 will add the fire-time required-keys check.
    const naturalInputs = pickDeclaredInputs(workflow, {
      ...(args.workItemId ? { workItemId: args.workItemId } : {}),
      ...(stageId ? { stageId } : {}),
    });
    const userInputs =
      args.inputs && typeof args.inputs === 'object' && !Array.isArray(args.inputs)
        ? args.inputs
        : {};
    const inputs: Record<string, unknown> = { ...naturalInputs, ...userInputs };

    const runId = randomUUID();
    let worktreePath: string | null = null;
    if (workflow.worktree !== 'none') {
      worktreePath = await this.ensureWorktree(
        args.workItemId ?? `run-${runId.slice(0, 8)}`,
      );
    }

    // Lock the attached card so concurrent fire-paths see the in-progress
    // status guard. Symmetric with moveAndFire — unlockWorkItem releases on
    // terminal run status (success → pending; failure / cancel → blocked).
    if (args.workItemId) {
      updateWorkItemStatus(args.workItemId as ULID, 'in-progress', null);
    }

    const run = this.createRun({
      id: runId,
      workflow,
      yamlText: entry.yamlText,
      trigger: 'manual',
      ...(args.workItemId ? { workItemId: args.workItemId } : {}),
      ...(stageId ? { stageId } : {}),
      worktreePath,
      ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
    });
    setImmediate(() => {
      void this.tick(run.id).catch((err) => {
        console.error('[workflow-runtime] fireManually tick failed:', (err as Error).message);
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

    const parsed = parseTypedWorkflowText(run.workflowYamlSnapshot, { expectedId: run.workflowId });
    if (!parsed.ok || !parsed.workflow) {
      run.status = 'failed';
      run.completedAt = new Date().toISOString();
      run.lastReason = `frozen YAML snapshot failed to parse: ${parsed.errors
        .map((e) => `${e.path}: ${e.message}`)
        .join('; ')}`;
      this.persistAndBroadcast(run);
      return run;
    }
    const workflow = parsed.workflow;
    const edges = parsed.edges ?? {};

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
      const results = await Promise.all(ready.map((node) => this.dispatch(node, run, workflow, edges)));

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
    this.persistAndBroadcast(run);

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
    this.persistAndBroadcast(parent);
    await this.tick(parent.id);
  }

  // ── Async node callbacks (subagent + approval) ────────────────────────────

  /** Shared failure-settlement path for an async-complete node that
   *  passed `pc_complete_node` but failed a post-completion contract
   *  (output_schema mismatch / done_when violation). Tries retry first;
   *  on no retry, marks the node failed with `reason`, persists, and
   *  broadcasts the subagent-failure envelope when applicable. */
  private async failCompletedNode(
    run: WorkflowRun,
    node: DagNode,
    reason: string,
  ): Promise<'retried' | 'failed'> {
    const cause = detectRetryCause(reason);
    const retried = await this.tryRetry(run, node, cause);
    if (retried) {
      this.persistAndBroadcast(run);
      return 'retried';
    }
    run.nodeOutputs[node.id] = {
      ...run.nodeOutputs[node.id]!,
      status: 'failed',
      error: reason,
      completedAt: new Date().toISOString(),
    };
    this.persistAndBroadcast(run);
    if (node.kind === 'subagent') {
      this.broadcastSubagentFailure(run, node.id, 'agent-self-failed', reason);
    }
    return 'failed';
  }

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
    const node = lookupNode(run, nodeId);
    // 4h.6 / D78. Validate subagent output against the author-declared
    // output_schema BEFORE done_when. A shape mismatch is a more fundamental
    // contract break — done_when can't meaningfully check for a missing
    // field that should never have type-mismatched in the first place.
    if (node && node.kind === 'subagent') {
      const ne = lookupNodeEdges(run, nodeId);
      if (ne?.output_schema) {
        const check = validateSubagentOutput(output, ne.output_schema);
        if (!check.ok) {
          await this.failCompletedNode(run, node, check.message);
          await this.tick(runId);
          return { ok: true };
        }
      }
    }
    // 4a.9 fix #3. Enforce done_when on async complete too. Subagents call
    // pc_complete_node when they think they're done; the contract still has
    // to hold.
    if (node) {
      const check = this.enforceDoneWhen(run, node);
      if (!check.ok) {
        await this.failCompletedNode(run, node, check.error ?? 'done_when violated');
        await this.tick(runId);
        return { ok: true };
      }
    }
    this.persistAndBroadcast(run);
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
        this.persistAndBroadcast(run);
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
    this.persistAndBroadcast(run);
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
      transcriptPath: this.subagentTranscriptsByNode.get(transcriptKey(run.id, nodeId)) ?? null,
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
    this.persistAndBroadcast(run);
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
   * Pre-4d: turn-end safety net that scanned in-progress runs and failed any
   * subagent node still 'running' after the orchestrator's turn ended. The
   * orchestrator was the dispatcher then, so its turn-end was the right
   * cleanup signal. Post-4d (D40 / D41) the workflow runtime owns subagent
   * dispatch via `spawnSubagent`; completion is detected from the spawned
   * helper's own Stop hook + JSONL turn-end, with D47 idle + wall-clock
   * timers as the failure signals. The orchestrator's turn-end is no longer
   * load-bearing for any subagent node, so this method is a no-op. Kept on
   * the class because PtySession still calls it on every orchestrator
   * `turn-end`; dropping the wire would need a coordinated change in
   * `apps/server/src/index.ts`.
   */
  async onTurnEnd(): Promise<void> {
    /* intentionally empty — see jsdoc */
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
    edges: Readonly<Record<string, NodeEdges>>,
  ): Promise<DispatchResult> {
    // 4h.5 — apply typed-port edges + bind the template substituter for
    // this node. Both calls short-circuit cheaply when the node has no
    // edges registered (un-migrated YAML path).
    const ctx: TypedRefContext = { run, projectId: this.projectId, edges };
    const effectiveNode = applyTypedPortEdges(node, ctx);
    const boundSubstitute = makeNodeBoundSubstituter(
      node.id,
      ctx,
      this.substituteOutputs,
    );
    const dispatcher = this.dispatchers[node.kind];
    return dispatcher({
      node: effectiveNode,
      run,
      workflow,
      edges,
      evaluateBoolean: this.evaluateBoolean,
      substituteOutputs: boundSubstitute,
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
          ready.map((bodyNode) => this.dispatch(bodyNode, fakeRun, ctx.workflow, ctx.edges)),
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

  /** Section 4d / D40–D47. The workflow runtime spawns its own helper for
   *  every subagent node via `spawnSubagent`. Pre-4d this method built a
   *  channel envelope and asked the orchestrator to spawn the helper via its
   *  Task tool; that path is removed (no orchestrator-routed dispatch
   *  remains). Completion + failure detection happen in `wireSpawnHandle`
   *  below — this method just kicks the spawn and returns `async`. */
  private async dispatchSubagent(ctx: DispatchContext): Promise<DispatchResult> {
    const node = ctx.node as SubagentNode;
    const rendered = ctx.substituteOutputs(node.prompt, ctx.run);
    // 4a.2 / D16: agent name may be `$inputs.<key>` — resolve at dispatch.
    // Empty / whitespace-only after substitution means the caller didn't
    // pass the input the workflow declared; fail fast with a clear reason.
    const resolvedAgent = ctx.substituteOutputs(node.subagent, ctx.run).trim();
    if (!resolvedAgent) {
      return failedSync(
        `agent name resolved to empty (raw: "${node.subagent}"; check the workflow's inputs and the caller's input map)`,
        new Date().toISOString(),
      );
    }
    if (!this.subagentSessionDirFor) {
      return failedSync(
        `subagent dispatch requires a subagentSessionDirFor factory; runtime was not configured with one`,
        new Date().toISOString(),
      );
    }

    const worktreeDir = ctx.run.worktreePath ?? this.opts.workspaceDir;
    const attempt = ctx.run.nodeOutputs[node.id]?.attempt ?? 1;
    // Short, human-readable enough that the corresponding session dir is
    // greppable; the random suffix avoids retry-attempt collisions.
    const runIdSuffix = ctx.run.id.slice(-8);
    const pcSessionId = `sub-${runIdSuffix}-${node.id}-a${attempt}-${randomUUID().slice(0, 8)}`;
    let sessionDataDir: string;
    try {
      sessionDataDir = this.subagentSessionDirFor(pcSessionId);
      mkdirSync(sessionDataDir, { recursive: true });
    } catch (err) {
      return failedSync(
        `subagent session dir mkdir failed: ${(err as Error).message}`,
        new Date().toISOString(),
      );
    }

    const initialInput = buildSubagentInitialInput({
      runId: ctx.run.id,
      nodeId: node.id,
      worktreePath: ctx.run.worktreePath,
      prompt: rendered,
    });

    const spawnReq: SubagentSpawnRequest = {
      agentName: resolvedAgent,
      worktreeDir,
      initialInput,
      sessionDataDir,
      pcSessionId,
      excludeJsonlPaths: this.snapshotExistingJsonl(worktreeDir),
      idleTimeoutMs: node.timeout,
    };

    let handle: SubagentSpawnHandle;
    try {
      handle = this.subagentSpawnerImpl(spawnReq);
    } catch (err) {
      // spawnSubagent's defined contract never throws; this guards a custom
      // injected spawner that does. Fail the node sync so the executor's
      // recompute drives downstream skip / retry logic.
      return failedSync(`subagent spawn threw: ${(err as Error).message}`, new Date().toISOString());
    }

    const key = transcriptKey(ctx.run.id, node.id);
    this.inflightSubagentHandles.set(key, handle);
    this.subagentTranscriptsByNode.set(key, handle.transcriptPath());

    this.wireSpawnHandle(ctx.run.id, node.id, handle);
    return { kind: 'async' };
  }

  /** Section 4d / D41. Bridge the spawn handle's `done` resolution into the
   *  runtime's nodeComplete / nodeFailed paths. The helper MAY also have
   *  called `pc_complete_node` / `pc_node_failed` during its turn, which
   *  hits the same runtime methods via the MCP server — in that case the
   *  node has already settled and this handler short-circuits.
   *
   *  Settlement is deferred via `setImmediate` so the dispatching tick fully
   *  unwinds before nodeComplete/nodeFailed re-enter the runtime. Without
   *  this, a synchronously-resolved spawner (test fakes; or any real spawn
   *  whose turn-end races the dispatch path's own awaits) lets the
   *  microtask-fired nodeComplete mutate the run, then the still-in-flight
   *  outer tick `dbPersistRun`s its STALE `run` snapshot and undoes the
   *  completion. */
  private wireSpawnHandle(
    runId: string,
    nodeId: string,
    handle: SubagentSpawnHandle,
  ): void {
    const key = transcriptKey(runId, nodeId);
    void handle.done.then((result) => {
      setImmediate(async () => {
        try {
          // Refresh the JSONL path on the transcripts map — discovery may
          // have resolved between dispatch and this handler firing.
          const finalJsonl = handle.jsonlPath();
          if (finalJsonl) this.subagentTranscriptsByNode.set(key, finalJsonl);

          const current = this.tryGetRun(runId);

          // 4e / D55. Persist the spawned-session JSONL path onto the node
          // output so the run-detail view's "View transcript" link survives
          // past the in-flight `subagentTranscriptsByNode` map (cleared on
          // finally). dbPersistRun BEFORE nodeComplete / nodeFailed — each
          // of those re-reads the run from sqlite, so in-memory mutation
          // on `current` alone is lost; we must commit transcriptPath to
          // the DB first so their { ...current } spread picks it up.
          if (current && finalJsonl) {
            const cur = current.nodeOutputs[nodeId];
            if (cur) {
              current.nodeOutputs[nodeId] = { ...cur, transcriptPath: finalJsonl };
              this.persistAndBroadcast(current);
            }
          }

          const status = current?.nodeOutputs[nodeId]?.status;
          if (status !== 'running') {
            // Helper already closed the node via pc_complete_node /
            // pc_node_failed during its turn — transcriptPath was persisted
            // above (if known); nothing else to do.
            return;
          }
          if (result.kind === 'success') {
            const output = result.pcCompletePayload ?? result.lastAssistantText;
            await this.nodeComplete(runId, nodeId, output);
          } else {
            await this.nodeFailed(runId, nodeId, formatSpawnFailure(result));
          }
        } catch (err) {
          console.error(
            `[workflow-runtime] subagent done-handler failed for ${runId}/${nodeId}: ${(err as Error).message}`,
          );
        } finally {
          this.inflightSubagentHandles.delete(key);
          this.subagentTranscriptsByNode.delete(key);
        }
      });
    });
  }

  /** Synchronous snapshot of `.jsonl` paths already living in CC's per-
   *  worktree session dir. Threaded into the spawner so discovery doesn't
   *  latch onto a sibling parallel dispatch's JSONL. Best-effort: the dir
   *  doesn't exist on the very first dispatch in a given worktree, which is
   *  fine. */
  private snapshotExistingJsonl(worktreeDir: string): string[] {
    const encoded = encodeCwdForClaude(worktreeDir);
    const wtDir = join(this.claudeProjectsDir, encoded);
    try {
      return readdirSync(wtDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => join(wtDir, f));
    } catch {
      return [];
    }
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

/** Look up the typed-edge data for a node (Section 4h / 4h.6). Returns
 *  undefined when the YAML snapshot fails to reparse or no edges were
 *  registered for `nodeId`. Used by `nodeComplete` to find a subagent's
 *  author-declared `output_schema` for D78 validation. */
function lookupNodeEdges(run: WorkflowRun, nodeId: string): NodeEdges | undefined {
  const parsed = parseTypedWorkflowText(run.workflowYamlSnapshot, { expectedId: run.workflowId });
  if (!parsed.ok || !parsed.edges) return undefined;
  return parsed.edges[nodeId];
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

/** Work Contract Layer 1 (2026-05-19): given a workflow and a map of natural
 *  context values from a fire-path, return the subset of context values that
 *  the workflow declared in its `inputs:` block. Fire-paths fill natural
 *  context for declared inputs only — declarations are the contract. */
function pickDeclaredInputs(
  workflow: Workflow,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const declared = workflow.inputs;
  if (!declared) return {};
  const picked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (key in declared && value !== undefined && value !== null) {
      picked[key] = value;
    }
  }
  return picked;
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

/** Section 4d / D40. Initial input piped into a spawned subagent helper after
 *  it reaches banner-ready. The helper IS the agent (--agent <name> loads its
 *  prompt + tools), so this envelope carries only the rendered prompt + the
 *  tokens the helper needs if it chooses to call `pc_complete_node` /
 *  `pc_node_failed` for a structured output override. Per D41 those calls are
 *  optional — the runtime auto-completes from the helper's natural turn-end
 *  if neither is called. */
export function buildSubagentInitialInput(args: {
  runId: string;
  nodeId: string;
  worktreePath: string | null;
  prompt: string;
}): string {
  const wtToken = args.worktreePath ? ` [worktree: ${args.worktreePath}]` : '';
  return [
    args.prompt,
    ``,
    `[workflowRunId: ${args.runId}] [nodeId: ${args.nodeId}]${wtToken}`,
    ``,
    `When you finish, your final reply becomes this node's output automatically. If you have a structured result the next workflow step should consume, call pc_complete_node({ workflowRunId, nodeId, output: { ... } }) instead — that payload overrides the text fallback. Call pc_node_failed({ workflowRunId, nodeId, reason }) for hard failures.`,
  ].join('\n');
}

function failedSync(error: string, completedAt: string): DispatchResult {
  return {
    kind: 'sync',
    output: { status: 'failed', error, completedAt },
  };
}

/** Per-(runId:nodeId) key for the runtime's transcript + inflight maps. */
function transcriptKey(runId: string, nodeId: string): string {
  return `${runId}:${nodeId}`;
}

/** D47 failure result → `nodeFailed` reason string. Preserves the timeout
 *  prefix so `detectRetryCause` can route timeouts into the retry policy's
 *  separate `on: ['timeout']` opt-in. */
function formatSpawnFailure(
  result: import('@pc/runtime').SubagentSpawnFailure,
): string {
  switch (result.cause) {
    case 'idle-timeout':
    case 'wall-clock-timeout':
      return `timeout (${result.message})`;
    case 'spawn-error':
      return `spawn error: ${result.message}`;
    case 'empty-turn':
      return `empty turn: ${result.message}`;
    case 'mcp-tool-error':
      return result.message;
    case 'killed':
      return `killed: ${result.message}`;
  }
}
