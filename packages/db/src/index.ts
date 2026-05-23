export { getDb, closeDb } from './connection.ts';
export type { DB } from './connection.ts';
export { newId } from './id.ts';
export { runMigrations } from './migrate.ts';

export {
  createProject,
  getProjectById,
  getProjectBySlug,
  listProjects,
  reorderProjects,
  softDeleteProject,
  updateProjectMeta,
  updateProjectStages,
} from './repos/projects.ts';
export type {
  CreateProjectInput,
  ListProjectsOptions,
  UpdateProjectMetaInput,
} from './repos/projects.ts';

export {
  appendWorkItemHistory,
  applyRunOutcome,
  countWorkItemsInStage,
  createWorkItem,
  getWorkItem,
  getWorkItemIncludingArchived,
  listArchivedWorkItems,
  listWorkItems,
  moveWorkItemStage,
  patchWorkItem,
  reassignStage,
  restoreWorkItem,
  softDeleteWorkItem,
  updateWorkItemFields,
  updateWorkItemStatus,
  WorkItemVersionConflictError,
} from './repos/work-items.ts';
export type { CreateWorkItemInput, PatchWorkItemInput } from './repos/work-items.ts';

export {
  createAttachment,
  deleteAttachment,
  getAttachment,
  listAttachmentsForWorkItem,
} from './repos/attachments.ts';
export type { CreateAttachmentInput } from './repos/attachments.ts';

export { listFieldSchemas, replaceFieldSchemas } from './repos/field-schemas.ts';
export type { ReplaceFieldSchemasInput } from './repos/field-schemas.ts';

export {
  createRun,
  getActiveRunForWorkItem,
  getRun,
  getRunForProject,
  listActiveRuns,
  listRuns,
  listRunsByProject,
  listRunsByWorkItem,
  persistRun,
} from './repos/workflow-runs.ts';
export type { CreateRunInput } from './repos/workflow-runs.ts';

export {
  getActiveWorktreeByName,
  listActiveWorktrees,
  markWorktreeDestroyed,
  upsertWorktree,
} from './repos/worktrees.ts';
export type { UpsertWorktreeInput } from './repos/worktrees.ts';

export { getGlobalSettings, setGlobalSettings } from './repos/settings.ts';

export {
  cloneAgentToProject,
  createAgent,
  createKnowledge,
  createMcpServer,
  createSecret,
  deleteKnowledge,
  deleteMcpServer,
  deleteSecret,
  getAgentById,
  getAgentByName,
  getKnowledge,
  getKnowledgeByName,
  getMcpServer,
  getMcpServerByName,
  getPodForSpawn,
  getSecret,
  getSecretByEnvVarName,
  listAgents,
  listKnowledge,
  listMcpServers,
  listSecrets,
  promoteAgentToGlobal,
  restoreAgent,
  softDeleteAgent,
  updateAgent,
  updateKnowledge,
} from './repos/pods.ts';
export type {
  CloneAgentResult,
  CloneAgentToProjectInput,
  CreateAgentInput,
  CreateKnowledgeInput,
  CreateMcpServerInput,
  CreateSecretInput,
  GetAgentByNameInput,
  GetKnowledgeByNameInput,
  GetMcpServerByNameInput,
  GetSecretByEnvInput,
  ListAgentsOptions,
  ListKnowledgeOptions,
  ListMcpServersOptions,
  ListSecretsOptions,
  UpdateAgentInput,
  UpdateKnowledgeInput,
} from './repos/pods.ts';
export { buildAuditRow, listAgentAudit } from './repos/pod-audit.ts';
export type {
  AuditInput,
  AuditRowValues,
  BuildAuditRowInput,
  ListAgentAuditOptions,
} from './repos/pod-audit.ts';

export {
  dismissFailedRun,
  listFailedRunDismissalsForProject,
  listFailedRunDismissalsForRuns,
} from './repos/failed-run-dismissals.ts';

export {
  createPendingAsk,
  getPendingAsk,
  listWaitingPendingAsksForProject,
  listWaitingPendingAsksForSession,
  markPendingAskAnswered,
  markPendingAskCancelled,
} from './repos/pending-asks.ts';
export type { AnswerPendingAskInput, CreatePendingAskInput } from './repos/pending-asks.ts';

export {
  enqueueInboxRow,
  getAuditForInbox,
  getInboxRow,
  listPendingForSession,
  markInboxDelivered,
  recordChannelPushAttempt,
} from './repos/agent-inbox.ts';
export type {
  EnqueueInboxRowInput,
  MarkInboxDeliveredInput,
  RecordChannelPushAttemptInput,
} from './repos/agent-inbox.ts';

// Section 25 — v2 inbox repo (parallel build alongside v1).
export {
  enqueueInboxRowV2,
  getAuditForInboxV2,
  getInboxRowV2,
  listPendingForSessionV2,
  markInboxDeliveredV2,
} from './repos/agent-inbox-v2.ts';
export type {
  EnqueueInboxRowV2Input,
  MarkInboxDeliveredV2Input,
} from './repos/agent-inbox-v2.ts';

// Section 25 Session 8 — v2 pending-asks repo.
export {
  createPendingAskV2,
  getPendingAskV2,
  listOpenPendingAsksV2ForProject,
  listOpenPendingAsksV2ForSession,
  markPendingAskAnsweredV2,
  markPendingAskCancelledV2,
} from './repos/pending-asks-v2.ts';
export type {
  AnswerPendingAskV2Input,
  CreatePendingAskV2Input,
} from './repos/pending-asks-v2.ts';

// Section 25 Session 8 — pod-revision helper for v2 drift detection.
export {
  computePodRevision,
  podRevisionsDiffer,
} from './repos/pod-revision.ts';
export type { ComputePodRevisionInput } from './repos/pod-revision.ts';

// Section 25 Session 8 — v2 agent-runs repo.
export {
  findActiveContinuationV2,
  getAgentRunRowV2,
  insertAgentRunRowV2,
  listActiveAgentRunsForProjectV2,
  listAgentRunsForSessionV2,
  markAgentRunTerminalV2,
  reconcileOrphanedRunningRunsV2,
  updateAgentRunStatusV2,
} from './repos/agent-runs-v2.ts';
export type {
  InsertAgentRunRowV2Input,
  ListAgentRunsForSessionV2Options,
  MarkAgentRunTerminalV2Input,
  UpdateAgentRunStatusV2Input,
} from './repos/agent-runs-v2.ts';

export {
  findActiveContinuation,
  getAgentRunRow,
  insertAgentRunRow,
  listAgentRunsForSession,
  markAgentRunTerminal,
  reconcileOrphanedRunningRuns,
} from './repos/agent-runs.ts';

export {
  cancelInstruction,
  consumeInstructionForRun,
  depositInstruction,
  findWaitingForRun,
  reconcileOrphanedInstructionDeposits,
} from './repos/instruction-deposits.ts';
export type { DepositInstructionInput } from './repos/instruction-deposits.ts';
export type {
  InsertAgentRunRowInput,
  ListAgentRunsForSessionOptions,
  MarkAgentRunTerminalInput,
} from './repos/agent-runs.ts';

export {
  createOrchestratorSession,
  endOrchestratorSession,
  getActiveOrchestratorSession,
  getOrchestratorSession,
  listOrchestratorSessionsForProject,
  reactivateOrchestratorSession,
  setOrchestratorSessionJsonlCursor,
  setOrchestratorSessionJsonlPath,
  setOrchestratorSessionTitle,
} from './repos/orchestrator-sessions.ts';
export type { CreateOrchestratorSessionInput } from './repos/orchestrator-sessions.ts';
