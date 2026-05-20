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
