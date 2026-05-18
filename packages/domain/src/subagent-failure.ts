// Failure-signal shape for subagent node failures (Section 3 / D10).
//
// Emitted by the workflow runtime whenever a subagent node terminates with a
// non-success status: the subagent itself called `pc_node_failed`, the
// orchestrator's turn ended without the subagent closing the node (turn-end
// safety net), or dispatch failed before the subagent even started.
//
// Section 3 owns the SHAPE. Section 4 owns retry policy (decides whether a
// signal even reaches the user vs. gets swallowed by a retry). Section 6
// (Activity panel) and Section 7 (Human Review) consume the user-visible
// rendering.

/** Machine-readable category. Drives retry policy + UI tone. */
export type SubagentFailureCause =
  /** Subagent called pc_node_failed with a reason — agent recognized the failure
   *  and surfaced it. The `surfaceError` carries the agent's reason text. */
  | 'agent-self-failed'
  /** Orchestrator's turn ended without the subagent calling pc_complete_node
   *  or pc_node_failed. The runtime's onTurnEnd safety net fired. Usually
   *  means the agent gave up silently or crashed mid-run. */
  | 'agent-returned-without-closing'
  /** The dispatch path itself failed (couldn't post to channel, worktree
   *  missing, etc.). The agent never actually ran. */
  | 'dispatch-error'
  /** Future use — node-level timeout exceeded. Section 4 wires this when it
   *  adds timeouts to subagent nodes. */
  | 'timeout';

export interface SubagentFailureSignal {
  workflowRunId: string;
  nodeId: string;
  /** The agent definition name (e.g. `researcher`, `reviewer`) — same value as
   *  the `subagent:` field on the workflow node. */
  agentName: string;
  /** 1-indexed attempt counter. Section 4 wires retries; for now every signal
   *  is attempt 1. */
  attemptNumber: number;
  cause: SubagentFailureCause;
  /** Human-readable error string for the chat bubble. Always present, even
   *  when the cause is a generic safety-net trip. */
  surfaceError: string;
  /** Absolute path to the agent's per-run JSONL transcript (CC writes one per
   *  Task tool invocation under `~/.claude/projects/<encoded>/...`). Optional
   *  because dispatch-error failures happen before the agent starts a session
   *  and `agent-returned-without-closing` may fire before any SubagentStop
   *  hook captured the path. */
  transcriptPath?: string | null;
  /** Optional last-N tool-call summary. Reserved for Section 4 / Section 6 —
   *  populated when those sections grow the per-run tool-call recorder. The
   *  shape is intentionally loose so producers can iterate without breaking
   *  this contract. */
  lastToolCalls?: unknown[];
}
