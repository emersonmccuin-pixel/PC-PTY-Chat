import type {
  CreateProjectMode,
  CreateProjectRequest,
  ProjectChangedRefetchEnvelope,
  ProjectDto,
  ProjectMutationReason,
  ReorderProjectsRequest,
  UpdateProjectRequest,
  ULID as ContractULID,
} from '@pc/contracts';
import { buildProjectChangedRefetchEnvelope } from '@pc/contracts';
import type { Project, ProjectSettings, Stage, ULID as DomainULID } from '@pc/domain';
import {
  getProjectById as defaultGetProjectById,
  listProjects as defaultListProjects,
  reorderProjects as defaultReorderProjects,
  softDeleteProject as defaultSoftDeleteProject,
  updateProjectMeta as defaultUpdateProjectMeta,
} from '@pc/db';

export interface ProjectRepositoryPort {
  listProjects(options?: { includeDeleted?: boolean }): Project[];
  getProjectById(projectId: ContractULID): Project | null;
  updateProjectMeta(
    projectId: ContractULID,
    input: { name?: string; gitRemote?: string | null },
  ): Project | null;
  reorderProjects(orderedIds: ContractULID[]): void;
  softDeleteProject(projectId: ContractULID): Project | null;
}

export interface ProjectCreateFlowInput {
  name: string;
  folderPath: string;
  mode: CreateProjectMode;
  gitRemote?: string | null;
}

export type ProjectCreateFlowPort = (input: ProjectCreateFlowInput) => Promise<Project>;

export type ProjectServiceResult<T extends object> =
  | ({ ok: true } & T)
  | { ok: false; error: string; code: 'NOT_FOUND' | 'INTERNAL' };

export type ProjectMutationResult<T extends object> = ProjectServiceResult<
  T & { event: ProjectChangedRefetchEnvelope }
>;

const defaultRepo: ProjectRepositoryPort = {
  listProjects: defaultListProjects,
  getProjectById: (projectId) => defaultGetProjectById(projectId as DomainULID),
  updateProjectMeta: (projectId, input) => defaultUpdateProjectMeta(projectId as DomainULID, input),
  reorderProjects: (orderedIds) => defaultReorderProjects(orderedIds as DomainULID[]),
  softDeleteProject: (projectId) => defaultSoftDeleteProject(projectId as DomainULID),
};

export class ProjectService {
  constructor(private readonly repo: ProjectRepositoryPort = defaultRepo) {}

  listProjects(options: { includeDeleted?: boolean } = {}): { projects: ProjectDto[] } {
    return {
      projects: this.repo.listProjects(options).map(toProjectDto),
    };
  }

  getProject(projectId: ContractULID): ProjectServiceResult<{ project: ProjectDto }> {
    const project = this.repo.getProjectById(projectId);
    if (!project) return notFound(projectId);
    return { ok: true, project: toProjectDto(project) };
  }

  async createProject(
    request: CreateProjectRequest,
    createProject: ProjectCreateFlowPort,
  ): Promise<ProjectMutationResult<{ project: ProjectDto }>> {
    const created = await createProject({
      name: request.name,
      folderPath: request.folder_path,
      mode: request.mode,
      gitRemote: request.git_remote ?? null,
    });
    const project = toProjectDto(created);
    return {
      ok: true,
      project,
      event: projectChanged('created', project),
    };
  }

  updateProjectMeta(
    projectId: ContractULID,
    request: UpdateProjectRequest,
  ): ProjectMutationResult<{ project: ProjectDto }> {
    const updated = this.repo.updateProjectMeta(projectId, {
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.git_remote !== undefined ? { gitRemote: request.git_remote } : {}),
    });
    if (!updated) return notFound(projectId);
    const project = toProjectDto(updated);
    return {
      ok: true,
      project,
      event: projectChanged('metadata-updated', project),
    };
  }

  reorderProjects(
    request: ReorderProjectsRequest,
  ): ProjectMutationResult<{ projects: ProjectDto[] }> {
    this.repo.reorderProjects(request.orderedIds);
    return {
      ok: true,
      projects: this.repo.listProjects().map(toProjectDto),
      event: buildProjectChangedRefetchEnvelope({ reason: 'reordered' }),
    };
  }

  softDeleteProject(projectId: ContractULID): ProjectMutationResult<{ project: ProjectDto }> {
    const deleted = this.repo.softDeleteProject(projectId);
    if (!deleted) return notFound(projectId);
    const project = toProjectDto(deleted);
    return {
      ok: true,
      project,
      event: projectChanged('soft-deleted', project),
    };
  }
}

export function toProjectDto(project: Project): ProjectDto {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    stages: project.stages.map(toStageDto),
    folderPath: project.folderPath,
    gitRemote: project.gitRemote,
    settings: toProjectSettingsDto(project.settings),
    callsignSeq: project.callsignSeq ?? 0,
  };
}

function toStageDto(stage: Stage): ProjectDto['stages'][number] {
  return {
    id: stage.id,
    name: stage.name,
    order: stage.order,
    ...(stage.isDone !== undefined ? { isDone: stage.isDone } : {}),
    ...(stage.isCancelled !== undefined ? { isCancelled: stage.isCancelled } : {}),
    ...(stage.isNew !== undefined ? { isNew: stage.isNew } : {}),
    ...(stage.rev !== undefined ? { rev: stage.rev } : {}),
  };
}

function toProjectSettingsDto(settings: ProjectSettings): ProjectDto['settings'] {
  const cancelledVisibility = settings.cancelledVisibility;
  return {
    cancelledVisibility:
      cancelledVisibility === 'force-visible' ||
      cancelledVisibility === 'force-hidden' ||
      cancelledVisibility === 'use-global'
        ? cancelledVisibility
        : 'use-global',
  };
}

function projectChanged(
  reason: ProjectMutationReason,
  project: ProjectDto,
): ProjectChangedRefetchEnvelope {
  return buildProjectChangedRefetchEnvelope({
    reason,
    projectIdChanged: project.id,
    project,
  });
}

function notFound(projectId: ContractULID): ProjectServiceResult<never> {
  return { ok: false, error: `unknown project: ${projectId}`, code: 'NOT_FOUND' };
}
