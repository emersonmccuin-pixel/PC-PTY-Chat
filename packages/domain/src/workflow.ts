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

export type DagNode =
  | SubagentNode
  | BashNode
  | ScriptNode
  | ApprovalNode
  | CancelNode
  | NestedWorkflowNode
  | LoopNode;

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
