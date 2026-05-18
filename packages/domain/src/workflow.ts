// Workflow + DagNode domain types (Slice 9 M3).
//
// A workflow is a YAML file declaring a graph of nodes. Each node has a
// type-specific body (`subagent:` / `bash:` / `script:` / `approval:` /
// `cancel:` / `workflow:` / `loop:`) — exactly one. The validator (M4) reads
// which type-body field is present and tags the parsed node with `kind:`
// for TS narrowing downstream. The `kind` field never appears in the YAML
// itself — it's a post-parse discriminator.
//
// Base fields (id, depends_on, when, trigger_rule, done_when, timeout) live
// on every node. `done_when` is optional everywhere; in practice subagent
// nodes opt in and bash/script rely on exit codes (per DESIGN-WORKFLOWS-V2
// "Calls I'm making" §1).

/** Dependency-completion semantics for a node. Default = `all_success`. */
export type TriggerRule =
  | 'all_success'
  | 'one_success'
  | 'all_done'
  | 'none_failed_min_one_success';

/**
 * Completion contract. Same shape as 8b's DoneWhen.
 *
 * `files-non-empty`: worktree-relative paths or globs; each match must exist
 *   and be >0 bytes.
 * `output-fields-non-empty`: keys in the output object that must be present
 *   and non-empty. `null`, `undefined`, trimmed-empty strings, `[]`, and `{}`
 *   are "empty". `0` and `false` pass.
 */
export interface DoneWhen {
  'files-non-empty'?: string[];
  'output-fields-non-empty'?: string[];
}

/** Per-node retry policy (4a.7 / D17). Plumbing ships, default is no retry —
 *  `max_attempts: 1` (single attempt, fail-fast). Workflow author opts in per
 *  step. `on` defaults to `['failed']` — both 'failed' and 'timeout' causes
 *  flow through nodeOutput.status === 'failed', but dispatchers tag the
 *  cause via the error string ("timeout (...)") so authors can opt into
 *  retrying just timeouts. */
export type RetryCause = 'failed' | 'timeout';

export interface RetryPolicy {
  /** Total attempts including the first one. Default 1. */
  max_attempts: number;
  /** Causes that trigger a retry. Default `['failed']` (covers both failed
   *  and timeout when the policy is opted in). */
  on?: RetryCause[];
  /** Wait this many ms between attempts. Default 0. */
  delay_ms?: number;
}

/** Fields shared by every node, regardless of `kind`. */
export interface BaseNode {
  id: string;
  depends_on?: string[];
  /** Expression evaluated before dispatch. If false, the node is skipped. */
  when?: string;
  trigger_rule?: TriggerRule;
  done_when?: DoneWhen;
  /** Hard ceiling in ms. Bash/script only in v1; ignored elsewhere. */
  timeout?: number;
  /** Per-step retry policy. Omitted = no retry. */
  retry?: RetryPolicy;
}

export interface SubagentNode extends BaseNode {
  kind: 'subagent';
  /** Subagent name — matches a file under `workspace/.claude/agents/`. */
  subagent: string;
  /** Prompt body. Supports `$<node-id>.output[.field]` substitution. */
  prompt: string;
}

export interface BashNode extends BaseNode {
  kind: 'bash';
  /** Command body. Supports `$<node-id>.output[.field]` substitution. */
  bash: string;
}

/** HTTP request step (4a.4 / D20). Workflow authors reach external services
 *  via raw HTTP. Auth lives in headers via `$ENV.NAME` substitution; no
 *  in-app secrets vault in v1. Output is the response; 4xx/5xx don't auto-
 *  fail the step — downstream `when:` / `trigger_rule:` decide. */
export interface HttpNode extends BaseNode {
  kind: 'http';
  http: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
    /** Absolute URL. Supports `$inputs.*`, `$<stepId>.output.*`, `$ENV.*`. */
    url: string;
    /** Request headers. Values support the same substitution grammar. */
    headers?: Record<string, string>;
    /** Request body (string). JSON is encoded by the author. */
    body?: string;
    /** Per-step timeout in ms. Defaults to 30 000 when unset. */
    timeout?: number;
  };
}

export interface ScriptNode extends BaseNode {
  kind: 'script';
  script: string;
  runtime: 'node' | 'python';
}

export interface ApprovalNode extends BaseNode {
  kind: 'approval';
  approval: {
    /** Message shown on the approval card + chat bubble. */
    message: string;
    /** Optional guidance shown to the user when they reject. */
    on_reject?: { prompt: string };
  };
}

export interface CancelNode extends BaseNode {
  kind: 'cancel';
  /** Reason recorded on the cancelled run; surfaced in the UI. */
  cancel: string;
}

export interface NestedWorkflowNode extends BaseNode {
  kind: 'workflow';
  /** Workflow id (the `id:` field of the target workflow file) to call. */
  workflow: string;
  /** Inputs to pass to the child run. Values may be expressions like `$x.output`. */
  inputs?: Record<string, string>;
}

export interface LoopNode extends BaseNode {
  kind: 'loop';
  loop: {
    /** Sub-graph evaluated per iteration. */
    body: DagNode[];
    /** Expression evaluated after each iteration; loop stops when true. */
    until: string;
    /** Hard cap; exceeded → node fails with reason "max iterations reached". */
    max_iterations: number;
  };
}

/** 4a.6 review step. Pauses the run + posts a channel event to the orchestrator
 *  with the review prompt. Orchestrator decides (approve / reject / revise)
 *  and calls `pc_complete_node({ workflowRunId, nodeId, output: { decision,
 *  notes? } })`. `on_revise.prompt` is guidance shown to the orchestrator
 *  about how to suggest revisions; the workflow author handles the revise
 *  decision via downstream `trigger_rule` / `depends_on`. */
export interface OrchestratorReviewNode extends BaseNode {
  kind: 'orchestrator-review';
  'orchestrator-review': {
    /** What the orchestrator should review. Supports substitution. */
    prompt: string;
    /** Optional artifact reference (e.g. work-item id, attachment id) included
     *  in the channel body. Supports substitution. */
    artifact?: string;
    /** Optional revise-path guidance shown to the orchestrator. */
    on_revise?: { prompt: string };
  };
}

/** 4a.5 routing step. Attach an inline payload to a work item via the
 *  AttachmentService. Provenance fields (source='agent', agentName,
 *  workflowRunId, nodeId) are filled by the runtime from run context — the
 *  workflow author doesn't set them. agentName is derived by scanning
 *  `depends_on` for the first subagent node; null when no subagent ancestor. */
export interface AttachToWorkItemNode extends BaseNode {
  kind: 'attach-to-work-item';
  'attach-to-work-item': {
    /** WI to attach onto. Supports `$inputs.*`, `$<stepId>.output.*`. */
    workItemId: string;
    /** Attachment name (filename-ish). Supports substitution. */
    name: string;
    /** Inline payload. Supports substitution. */
    content: string;
    /** Free-form kind tag (default `text`). */
    kind?: string;
    /** Optional MIME-ish content type. */
    contentType?: string;
  };
}

/** 4a.5 routing step. Create a new work item via WorkItemService.create.
 *  Stage defaults to the project's first stage when unset. */
export interface CreateWorkItemNode extends BaseNode {
  kind: 'create-work-item';
  'create-work-item': {
    /** Title. Supports substitution. */
    title: string;
    /** Body. Supports substitution. */
    body?: string;
    /** Stage id. Defaults to the first stage on the project. */
    stage?: string;
    /** Parent WI id (string). Supports substitution. */
    parentId?: string;
  };
}

/** 4a.5 routing step. Patch an existing work item via WorkItemService.patch.
 *  Reads current version, then applies the patch. `fields` is shallow-merged
 *  into the WI's existing fields; pass an empty value to clear a key. */
export interface UpdateWorkItemNode extends BaseNode {
  kind: 'update-work-item';
  'update-work-item': {
    /** WI to patch. Supports substitution. */
    workItemId: string;
    /** Optional title replacement. */
    title?: string;
    /** Optional body replacement. */
    body?: string;
    /** Optional stage move. */
    stage?: string;
    /** Optional partial fields patch. */
    fields?: Record<string, unknown>;
  };
}

/** 4a.5 routing step. Write a file inside the run's worktree. Path must
 *  resolve under `run.worktreePath`; escapes fail the step. No git side-
 *  effect — pair with a follow-on `bash` step for `git add && commit`. */
export interface WriteToWorktreeNode extends BaseNode {
  kind: 'write-to-worktree';
  'write-to-worktree': {
    /** Worktree-relative path. Supports substitution. */
    path: string;
    /** Content. Supports substitution. */
    content: string;
    /** `overwrite` (default) replaces the file; `append` adds to the end. */
    mode?: 'overwrite' | 'append';
  };
}

export type DagNode =
  | SubagentNode
  | BashNode
  | HttpNode
  | ScriptNode
  | ApprovalNode
  | CancelNode
  | NestedWorkflowNode
  | LoopNode
  | AttachToWorkItemNode
  | CreateWorkItemNode
  | UpdateWorkItemNode
  | WriteToWorktreeNode
  | OrchestratorReviewNode;

/** Trigger conditions for a workflow. */
export interface WorkflowTriggers {
  /** Fires when a work item enters the named stage. */
  on_enter?: { stage_id: string };
  /** Set true to let the orchestrator call this workflow via `pc_run_workflow`. */
  callable?: boolean;
}

export interface Workflow {
  id: string;
  description?: string;
  triggers?: WorkflowTriggers;
  /** Declared inputs (name → type string). Documentation; runtime doesn't enforce. */
  inputs?: Record<string, string>;
  /** Declared outputs (name → type string). Documentation; runtime doesn't enforce. */
  outputs?: Record<string, string>;
  /** `auto` = runtime creates/reuses a worktree; `none` = no worktree binding. */
  worktree?: 'auto' | 'none';
  nodes: DagNode[];
}
