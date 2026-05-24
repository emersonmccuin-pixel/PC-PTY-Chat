// Section 25 — runtime barrel (post-Phase-E bare names).
//
// PtySession + legacy JsonlTailer survive cutover (orchestrator + interview
// surfaces use them). The agent-system primitives (LowLevelSpawn, AgentRun,
// InteractiveSession, AgentRunJsonlTailer) sit alongside as named exports.

export { encodeCwdForClaude, PtySession, stripAnsi } from './pty-session.ts';
export type { PtySessionOptions, SessionState } from './pty-session.ts';
export { JsonlTailer } from './jsonl-tailer.ts';
export type { JsonlEvent, JsonlTailerOptions } from './jsonl-tailer.ts';

// Workflow subagent spawner — the LowLevelSpawn-based default.
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
export type {
  MaterializePodOptions,
  MaterializedPod,
  PodWorkItemContext,
} from './pod-materializer.ts';

// ── Agent-system primitives (Section 25) ──────────────────────────────────

export {
  claudeConfigDir,
  claudeProjectsRoot,
  projectDirFor,
  jsonlPathFor,
} from './path-resolver.ts';

export { IDE_INTEGRATION_ENV_KEYS, scrubIdeEnv } from './env-scrub.ts';

export {
  collapseAnsiToWhitespace,
  stripAnsiPreserveSpacing,
} from './ansi.ts';

export { ReadyGate } from './ready-gate.ts';
export type { ReadyTimestamps } from './ready-gate.ts';

export { sendBracketedPaste } from './send-protocol.ts';
export type { SendDeps, SendResult } from './send-protocol.ts';

export { LowLevelSpawn } from './low-level-spawn.ts';
export type {
  LowLevelSpawnInput,
  PodDescriptor,
  SpawnEvents,
  SpawnState,
} from './low-level-spawn.ts';

export { AgentRunRegistry } from './agent-run-registry.ts';
export type {
  AdmissionTicket,
  TicketState,
  AgentRunRegistryOptions,
} from './agent-run-registry.ts';

export { AgentRun } from './agent-run.ts';
export type {
  AgentRunState,
  AgentRunFailureCause,
  AgentRunRecord,
  AgentRunInput,
  AgentRunDeps,
  SpawnFactory,
  SpawnLike,
} from './agent-run.ts';

export { InteractiveSession } from './interactive-session.ts';
export type {
  InteractiveSessionState,
  InteractiveSessionInput,
  InteractiveSessionDeps,
} from './interactive-session.ts';

export { AgentRunJsonlTailer } from './agent-run-jsonl-tailer.ts';
export type {
  AgentRunJsonlEvent,
  AgentRunJsonlEventKind,
  JsonlTailerOptionsForAgentRun,
} from './agent-run-jsonl-tailer.ts';
