// update-work-item step dispatcher (4a.5). Reads the WI to get the current
// version, then calls WorkItemService.patch with the substituted body fields.
// `fields` is shallow-merged into the WI's existing fields by the service.
//
// Status changes (status / statusReason) are NOT part of this step's surface
// because WorkItemService.patch doesn't expose them — they're driven by
// workflow lifecycle (run terminal → service.applyRunOutcome). Add a
// dedicated `set-status` step kind later if a workflow author needs it.

import type {
  NodeOutput,
  Project,
  UpdateWorkItemNode,
  ULID,
  WorkflowRun,
} from '@pc/domain';

import type { WorkItemService } from './work-item.ts';
import type { SubstituteTemplate } from './typed-substitution.ts';

export interface UpdateWorkItemStepResult {
  kind: 'sync';
  output: NodeOutput;
}

export interface UpdateWorkItemStepDeps {
  workItemService: WorkItemService;
  substituteTemplate: SubstituteTemplate;
  /** Section 27 — Required for `toFlag` resolution. Other paths still work
   *  without it (the step short-circuits when `toFlag` is set but the
   *  resolver isn't wired). */
  getProject?: () => Project;
}

export async function runUpdateWorkItemStep(
  node: UpdateWorkItemNode,
  _run: WorkflowRun,
  deps: UpdateWorkItemStepDeps,
): Promise<UpdateWorkItemStepResult> {
  const completedAt = () => new Date().toISOString();
  const cfg = node['update-work-item'];
  // Section 27 — config-validation runs before any state lookup so the error
  // is deterministic regardless of WI existence.
  if (cfg.stage !== undefined && cfg.toFlag !== undefined) {
    return failedSync(`pass exactly one of stage / toFlag (not both)`, completedAt());
  }
  const workItemId = deps.substituteTemplate(cfg.workItemId).trim();
  if (!workItemId) {
    return failedSync(
      `workItemId resolved to empty (raw: "${cfg.workItemId}")`,
      completedAt(),
    );
  }

  const current = deps.workItemService.get(workItemId as ULID);
  if (!current) {
    return failedSync(`unknown work item: ${workItemId}`, completedAt());
  }

  const patchInput: Parameters<WorkItemService['patch']>[1] = {
    expectedVersion: current.version,
  };
  if (cfg.title !== undefined) {
    patchInput.title = deps.substituteTemplate(cfg.title);
  }
  if (cfg.body !== undefined) {
    patchInput.body = deps.substituteTemplate(cfg.body);
  }
  if (cfg.stage !== undefined) {
    const stageId = deps.substituteTemplate(cfg.stage).trim();
    if (!stageId) {
      return failedSync(`stage resolved to empty (raw: "${cfg.stage}")`, completedAt());
    }
    patchInput.stageId = stageId;
  } else if (cfg.toFlag !== undefined) {
    if (!deps.getProject) {
      return failedSync(
        `toFlag requires getProject on step deps (runtime mis-wired)`,
        completedAt(),
      );
    }
    const flagKey =
      cfg.toFlag === 'done' ? 'isDone' : cfg.toFlag === 'cancelled' ? 'isCancelled' : 'isNew';
    const match = deps.getProject().stages.find((s) => s[flagKey]);
    if (!match) {
      return failedSync(`no stage in project carries is_${cfg.toFlag}`, completedAt());
    }
    patchInput.stageId = match.id;
  }
  if (cfg.fields !== undefined) {
    const substituted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cfg.fields)) {
      substituted[k] = typeof v === 'string' ? deps.substituteTemplate(v) : v;
    }
    patchInput.fields = substituted;
  }

  try {
    const updated = deps.workItemService.patch(workItemId as ULID, patchInput);
    return {
      kind: 'sync',
      output: {
        status: 'complete',
        output: {
          id: updated.id,
          version: updated.version,
          stageId: updated.stageId,
        },
        completedAt: completedAt(),
      },
    };
  } catch (err) {
    return failedSync(`update failed: ${(err as Error).message}`, completedAt());
  }
}

function failedSync(error: string, completedAt: string): UpdateWorkItemStepResult {
  return {
    kind: 'sync',
    output: { status: 'failed', error, completedAt },
  };
}
