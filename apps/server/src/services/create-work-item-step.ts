// create-work-item step dispatcher (4a.5). Calls WorkItemService.create with
// substituted fields. Stage defaults to the project's first stage when unset.
// Output is `{ id, version, stageId }` so downstream steps can address the new
// WI via `$<stepId>.output.id`.

import type {
  CreateWorkItemNode,
  NodeOutput,
  Project,
  ULID,
  WorkflowRun,
} from '@pc/domain';

import type { WorkItemService } from './work-item.ts';

import type { SubstituteTemplate } from './typed-substitution.ts';

export interface CreateWorkItemStepResult {
  kind: 'sync';
  output: NodeOutput;
}

export interface CreateWorkItemStepDeps {
  workItemService: WorkItemService;
  getProject: () => Project;
  substituteTemplate: SubstituteTemplate;
}

export async function runCreateWorkItemStep(
  node: CreateWorkItemNode,
  _run: WorkflowRun,
  deps: CreateWorkItemStepDeps,
): Promise<CreateWorkItemStepResult> {
  const completedAt = () => new Date().toISOString();
  const cfg = node['create-work-item'];
  const title = deps.substituteTemplate(cfg.title).trim();
  if (!title) {
    return failedSync(`title resolved to empty (raw: "${cfg.title}")`, completedAt());
  }

  let stageId: string;
  if (cfg.stage) {
    stageId = deps.substituteTemplate(cfg.stage).trim();
    if (!stageId) {
      return failedSync(`stage resolved to empty (raw: "${cfg.stage}")`, completedAt());
    }
  } else {
    const firstStage = deps.getProject().stages[0]?.id;
    if (!firstStage) {
      return failedSync(`project has no stages; cannot default stage`, completedAt());
    }
    stageId = firstStage;
  }

  const body = cfg.body !== undefined ? deps.substituteTemplate(cfg.body) : undefined;
  let parentId: ULID | undefined;
  if (cfg.parentId) {
    const raw = deps.substituteTemplate(cfg.parentId).trim();
    if (!raw) {
      return failedSync(
        `parentId resolved to empty (raw: "${cfg.parentId}")`,
        completedAt(),
      );
    }
    parentId = raw as ULID;
  }

  try {
    const created = deps.workItemService.create({
      title,
      stageId,
      ...(body !== undefined ? { body } : {}),
      ...(parentId !== undefined ? { parentId } : {}),
    });
    return {
      kind: 'sync',
      output: {
        status: 'complete',
        output: {
          id: created.id,
          version: created.version,
          stageId: created.stageId,
        },
        completedAt: completedAt(),
      },
    };
  } catch (err) {
    return failedSync(`create failed: ${(err as Error).message}`, completedAt());
  }
}

function failedSync(error: string, completedAt: string): CreateWorkItemStepResult {
  return {
    kind: 'sync',
    output: { status: 'failed', error, completedAt },
  };
}
