export { getDb, closeDb } from './connection.ts';
export type { DB } from './connection.ts';
export { newId } from './id.ts';
export { runMigrations } from './migrate.ts';

export {
  createProject,
  getProjectById,
  getProjectBySlug,
  listProjects,
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
  createWorkItem,
  getWorkItem,
  listWorkItems,
  moveWorkItemStage,
  updateWorkItemFields,
  updateWorkItemStatus,
} from './repos/work-items.ts';
export type { CreateWorkItemInput } from './repos/work-items.ts';

export {
  createRun,
  getActiveRunForWorkItem,
  getRun,
  listActiveRuns,
  listRuns,
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
