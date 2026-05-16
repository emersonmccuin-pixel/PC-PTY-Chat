// Workflow registry. Scans workspace/.project-companion/workflows/ for *.yaml,
// parses + validates each (via the M4 validator), exposes valid/invalid state
// for the UI, and offers `findByName` lookup the M12 nested-workflow
// dispatcher uses. M14 brings back `findByStageEnter` for the work-item-move
// trigger path.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';

import type { Workflow } from '@pc/domain';

import { validateWorkflow, type ValidationError } from './validator.ts';

export interface ValidWorkflowEntry {
  filePath: string;
  fileName: string;
  workflow: Workflow;
  /** Raw YAML text — snapshotted into WorkflowRun at dispatch. */
  yamlText: string;
}

export interface InvalidWorkflowEntry {
  filePath: string;
  fileName: string;
  errors: ValidationError[];
  /** Stage the file would have triggered on, when extractable from invalid YAML. */
  partialStageId?: string;
}

export interface RegistryState {
  valid: ValidWorkflowEntry[];
  invalid: InvalidWorkflowEntry[];
}

export class WorkflowRegistry {
  private state: RegistryState = { valid: [], invalid: [] };

  constructor(private readonly workflowsDir: string) {}

  /** Re-scan workflowsDir from scratch. Cheap — small set of YAML files. */
  reload(): RegistryState {
    if (!existsSync(this.workflowsDir)) {
      this.state = { valid: [], invalid: [] };
      return this.state;
    }

    const next: RegistryState = { valid: [], invalid: [] };
    const files = readdirSync(this.workflowsDir).filter(
      (f) => extname(f) === '.yaml' || extname(f) === '.yml',
    );

    for (const fileName of files) {
      const filePath = join(this.workflowsDir, fileName);
      const expectedId = basename(fileName, extname(fileName));

      let yamlText = '';
      try {
        yamlText = readFileSync(filePath, 'utf-8');
      } catch (err) {
        next.invalid.push({
          filePath,
          fileName,
          errors: [{ path: '', message: `read failed: ${(err as Error).message}` }],
        });
        continue;
      }

      let parsed: unknown;
      try {
        parsed = yamlLoad(yamlText);
      } catch (err) {
        next.invalid.push({
          filePath,
          fileName,
          errors: [{ path: '', message: `yaml parse failed: ${(err as Error).message}` }],
        });
        continue;
      }

      const result = validateWorkflow(parsed, { expectedId });
      if (result.ok && result.workflow) {
        next.valid.push({ filePath, fileName, workflow: result.workflow, yamlText });
      } else {
        next.invalid.push({
          filePath,
          fileName,
          errors: result.errors,
          partialStageId: result.partialStageId,
        });
      }
    }

    this.state = next;
    return this.state;
  }

  /** Last-known state without re-scanning. */
  snapshot(): RegistryState {
    return this.state;
  }

  /** Look up a workflow by its `id:`. Reloads so live edits surface. */
  findByName(name: string): ValidWorkflowEntry | undefined {
    this.reload();
    return this.state.valid.find((e) => e.workflow.id === name);
  }

  /**
   * Look up workflows whose `triggers.on_enter.stage_id` matches. Same
   * four-case rule the runtime uses to decide what to do on a work-item move:
   *   none    → silent pure move
   *   one     → fire the workflow
   *   many    → reject move with "ambiguous trigger"
   *   invalid → reject move with "no valid workflow"
   */
  findByStageEnter(stageId: string): StageMatch {
    this.reload();
    const validHits = this.state.valid.filter(
      (e) => e.workflow.triggers?.on_enter?.stage_id === stageId,
    );
    if (validHits.length > 1) return { kind: 'many', count: validHits.length };
    if (validHits.length === 1) return { kind: 'one', entry: validHits[0]! };

    const invalidHits = this.state.invalid.filter((e) => e.partialStageId === stageId);
    if (invalidHits.length > 0) return { kind: 'invalid', count: invalidHits.length };

    return { kind: 'none' };
  }
}

/** Outcome of `findByStageEnter`. */
export type StageMatch =
  | { kind: 'none' }
  | { kind: 'one'; entry: ValidWorkflowEntry }
  | { kind: 'many'; count: number }
  | { kind: 'invalid'; count: number };
