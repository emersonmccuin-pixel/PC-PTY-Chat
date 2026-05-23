// Section 25 — agent system v2.
//
// All v2 modules live under this barrel. Wrappers (AgentRun, InteractiveSession)
// ship in Session 6. Delivery / tailer / persistence ship in Session 7.
// MCP tools + orchestrator cutover ship in Session 9.

export {
  claudeConfigDir,
  claudeProjectsRoot,
  encodeCwdForClaude,
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

export { JsonlTailerV2 } from './tailer.ts';
export type {
  JsonlEventV2,
  JsonlEventV2Kind,
  JsonlTailerV2Options,
} from './tailer.ts';
