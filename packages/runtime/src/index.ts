export { encodeCwdForClaude, PtySession, stripAnsi } from './pty-session.ts';
export type { PtySessionOptions, SessionState } from './pty-session.ts';
export { JsonlTailer } from './jsonl-tailer.ts';
export type { JsonlEvent, JsonlTailerOptions } from './jsonl-tailer.ts';
export { spawnSubagent } from './subagent-spawner.ts';
export type {
  SubagentSessionLike,
  SubagentSpawnerDeps,
  SubagentSpawnFailure,
  SubagentSpawnFailureCause,
  SubagentSpawnHandle,
  SubagentSpawnRequest,
  SubagentSpawnResult,
  SubagentSpawnSuccess,
} from './subagent-spawner.ts';
// Section 25 Session 10 — v2 workflow subagent spawner (LowLevelSpawn-based).
// Drop-in replacement for `spawnSubagent`. Will become the only spawner once
// the v1 path is ripped at Phase D.
export { spawnSubagentV2 } from './subagent-spawner-v2.ts';
export type { SubagentSpawnerV2Deps } from './subagent-spawner-v2.ts';
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
