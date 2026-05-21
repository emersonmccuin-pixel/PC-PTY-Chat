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
  restoreAgent,
  softDeleteAgent,
  updateAgent,
  updateKnowledge,
} from './repos/pods.ts';
export type {
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
