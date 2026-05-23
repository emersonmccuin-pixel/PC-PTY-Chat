export { encodeCwdForClaude, PtySession, stripAnsi } from './pty-session.ts';
export type { PtySessionOptions, SessionState } from './pty-session.ts';
export { JsonlTailer } from './jsonl-tailer.ts';
export type { JsonlEvent, JsonlTailerOptions } from './jsonl-tailer.ts';
// Section 25 Phase D — v2 workflow subagent spawner is the only spawner.
export { spawnSubagentV2 } from './subagent-spawner-v2.ts';
export type {
  SubagentSessionLike,
  SubagentSpawnerV2Deps,
  SubagentSpawnFailure,
  SubagentSpawnFailureCause,
  SubagentSpawnHandle,
  SubagentSpawnRequest,
  SubagentSpawnResult,
  SubagentSpawnSuccess,
} from './subagent-spawner-v2.ts';
export {
  attachWorktree,
  createWorktree,
  destroyWorktree,
  listWorktrees,
  pruneWorktrees,
} from './worktree.ts';
export type { WorktreeEntry } from './worktree.ts';
export {
  buildEnvMap,
  expandToolWildcards,
  materializePod,
  renderAgentMd,
  renderMcpConfig,
} from './pod-materializer.ts';
export type { MaterializePodOptions, MaterializedPod } from './pod-materializer.ts';

// Section 25 — agent system v2. Both v1 + v2 surfaces coexist throughout
// Phase A (Sessions 5–8). Cutover in Phase D (Session 11).
export * as v2 from './v2/index.ts';
