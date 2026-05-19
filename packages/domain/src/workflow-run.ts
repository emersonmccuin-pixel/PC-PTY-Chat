// WorkflowRun lifecycle types (Slice 9 M3).
//
// One run = one execution of a workflow's graph. The runtime persists runs
// to data/workflow-runs.json (rig) / sqlite (PC). NodeOutputs hold per-node
// status + output keyed by node id so the scheduler and `$<node-id>.output`
// substitution share the same source of truth.

/** Run-level status. `paused` is new in v2 (approval nodes). `cancelled` is new in v2 (cancel nodes). */
export type WorkflowRunStatus =
  | 'pending'
  | 'in-progress'
  | 'paused'
  | 'complete'
  | 'failed'
  | 'cancelled';

/** What kicked off the run. `on_enter` = work-item stage transition; `callable` =
 *  orchestrator-called via pc_run_workflow; `nested` = spawned by a parent's
 *  `workflow:` node; `manual` = user fired from the WorkflowList "Run now"
 *  menu (4f.3). Future: `cron` / `webhook` (4g). */
export type WorkflowRunTrigger = 'on_enter' | 'callable' | 'nested' | 'manual';

/** Per-node status. `pending` = waiting on deps; `running` = dispatched. */
export type NodeOutputStatus =
  | 'pending'
  | 'running'
  | 'complete'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface NodeOutput {
  status: NodeOutputStatus;
  /** Whatever the node produced. Subagents pass a structured object; bash/script give `{stdout, stderr, exitCode}`; approval gives `{approved, response}`; cancel/workflow/loop have their own shapes. */
  output?: unknown;
  /** Reason if `status` is `failed` or `cancelled`. */
  error?: string;
  startedAt?: string;
  completedAt?: string;
  /** Attempt counter (4a.7 / D17). 1 = first attempt. Only set when > 1 to
   *  keep first-attempt outputs noise-free. Final-attempt value feeds D10's
   *  SubagentFailureSignal.attemptNumber. */
  attempt?: number;
  /** Absolute path to the spawned session's JSONL transcript. Set by the
   *  workflow runtime for `subagent` kind nodes when the spawn handle reports
   *  jsonlPath (4d D48 / 4e D55). Powers the run-detail "View transcript"
   *  link. Undefined for non-subagent kinds and pre-4e rows. */
  transcriptPath?: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  /** What kicked off this run (4e surfaces this as a per-row badge so the
   *  user can distinguish drag-fired from chat-fired from cron-fired). Future
   *  trigger values (`manual` / `cron` / `webhook` per 4f / 4g) are accepted
   *  string-graceful by the UI even before they're enum-locked here. */
  trigger?: WorkflowRunTrigger;
  /** Raw YAML text snapshot at dispatch — frozen against live edits. */
  workflowYamlSnapshot: string;
  status: WorkflowRunStatus;
  startedAt: string;
  completedAt?: string;
  /** Set for stage-triggered + work-item-bound runs. */
  workItemId?: string;
  /** Set for stage-triggered runs only. */
  stageId?: string;
  /** Set when this run was spawned by a `workflow:` node in a parent. */
  parentRunId?: string;
  /** Set with parentRunId — the node id in the parent that spawned this run. */
  parentNodeId?: string;
  worktreePath: string | null;
  /** Inputs passed in (from `pc_run_workflow` args or parent's `inputs:` mapping). */
  inputs?: Record<string, unknown>;
  /** Final outputs (declared in the workflow's `outputs:` block). */
  outputs?: Record<string, unknown>;
  /** Per-node status + output, keyed by node id. */
  nodeOutputs: Record<string, NodeOutput>;
  /** Last reason associated with `failed` / `cancelled` / `paused`. */
  lastReason?: string;
  /** Section 4e.2. Free-form metadata captured at run creation / persisted
   *  through the lifecycle. Today: retry-from lineage
   *  (`reFiredFromRunId`, `reFiredFromNodeId`). Undefined when the
   *  underlying row has an empty `{}` (saves a per-row allocation in the
   *  common no-metadata case). */
  metadata?: Record<string, unknown>;
}
