// Workflow registry. Scans workspace/.project-companion/workflows/ for *.yaml,
// parses + validates each (via the M4 validator), exposes valid/invalid state
// for the UI, and offers `findByName` lookup the M12 nested-workflow
// dispatcher uses. M14 brings back `findByStageEnter` for the work-item-move
// trigger path.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

import type { NodeEdges, Workflow } from '@pc/domain';

import { parseTypedWorkflowText } from './typed-parser.ts';
import { type ValidationError } from './validator.ts';
import { isV2WorkflowText } from './serialize-v2.ts';

export interface ValidWorkflowEntry {
  filePath: string;
  fileName: string;
  workflow: Workflow;
  /** Per-node typed-edge data (4h). Keyed by node id. Empty object when the
   *  workflow declares no typed wires (rare post-migration; subagents always
   *  carry at least `output_schema`). */
  edges: Readonly<Record<string, NodeEdges>>;
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

      // Section 19.x — v2 workflow files coexist in the same dir. Skip them
      // here so the v1 registry doesn't surface a v2 YAML as a v1-validator
      // failure (which then poisons WorkflowList rendering: v2 schemas don't
      // map to v1's ValidationError {path,message} shape downstream). The v2
      // registry handles these via WorkflowV2Registry.reload(). Surfaced live
      // in the 19.10 UI walk: publishing a v2 workflow crashed React because
      // the v1 registry was treating it as an invalid v1 file.
      if (isV2WorkflowText(yamlText)) continue;

      const result = parseTypedWorkflowText(yamlText, { expectedId });
      if (result.ok && result.workflow) {
        next.valid.push({
          filePath,
          fileName,
          workflow: result.workflow,
          edges: result.edges ?? {},
          yamlText,
        });
      } else {
        next.invalid.push({
          filePath,
          fileName,
          errors: [...result.errors],
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
