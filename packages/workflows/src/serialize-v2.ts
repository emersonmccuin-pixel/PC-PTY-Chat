// Section 19 — v2 workflow YAML serialize/parse. Pure (no I/O). v2 definitions
// live as YAML files alongside v1 in `.project-companion/workflows/`; a top-level
// `version: 2` marker discriminates them (the v1 registry skips version:2 files;
// the v2 registry skips everything else). Unlike v1, the node `kind:` field IS
// on-disk for v2 (it's the schema discriminator the parser reads).

import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import type { WorkflowV2 } from '@pc/domain';
import { validateWorkflowV2 } from './dag/validate.ts';

/** Marker written at the top of every v2 workflow file. */
export const WORKFLOW_V2_VERSION = 2;

/** Cheap check: is this YAML text a v2 workflow (top-level `version: 2`)? Used
 *  to keep the v1 boot migration from touching v2 files in the shared dir. */
export function isV2WorkflowText(yamlText: string): boolean {
  try {
    const doc = yamlLoad(yamlText);
    return doc !== null && typeof doc === 'object' && (doc as Record<string, unknown>).version === WORKFLOW_V2_VERSION;
  } catch {
    return false;
  }
}

/** Serialize a v2 workflow to round-trippable YAML. Fixed key order keeps the
 *  on-disk shape human-readable + diff-friendly. */
export function serializeWorkflowV2(workflow: WorkflowV2.Workflow): string {
  const out: Record<string, unknown> = { version: WORKFLOW_V2_VERSION, id: workflow.id, name: workflow.name };
  if (workflow.description !== undefined) out.description = workflow.description;
  if (workflow.worktree !== undefined) out.worktree = workflow.worktree;
  if (workflow.max_concurrency !== undefined) out.max_concurrency = workflow.max_concurrency;
  if (workflow.disabled === true) out.disabled = true;
  out.triggers = workflow.triggers;
  out.nodes = workflow.nodes;
  return yamlDump(out, { lineWidth: 0, noRefs: true });
}

export type ParseV2Result =
  | { ok: true; workflow: WorkflowV2.Workflow }
  /** File parsed but isn't a v2 workflow (no `version: 2`). Registry skips it. */
  | { ok: false; notV2: true }
  /** File IS v2 but failed YAML parse or graph validation. Registry flags it. */
  | { ok: false; notV2?: false; errors: string[]; partialStageId?: string };

/**
 * Parse + validate a v2 workflow YAML document. Returns `notV2` for non-v2 files
 * (so the registry skips v1 quietly), validation `errors` for malformed v2 files
 * (surfaced in the UI), or the typed workflow. `expectedId` (from the filename)
 * is authoritative for `id` — the body's id is coerced to match.
 */
export function parseWorkflowV2Text(yamlText: string, opts: { expectedId?: string } = {}): ParseV2Result {
  let doc: unknown;
  try {
    doc = yamlLoad(yamlText);
  } catch (err) {
    return { ok: false, errors: [`YAML parse error: ${(err as Error).message}`] };
  }
  if (doc === null || typeof doc !== 'object') {
    return { ok: false, notV2: true };
  }
  const raw = doc as Record<string, unknown>;
  if (raw.version !== WORKFLOW_V2_VERSION) {
    return { ok: false, notV2: true };
  }

  const { version: _v, ...rest } = raw;
  if (opts.expectedId) rest.id = opts.expectedId;
  const workflow = rest as unknown as WorkflowV2.Workflow;

  const result = validateWorkflowV2(workflow);
  if (!result.ok) {
    // Best-effort: surface the first stage-on-entry stage even on invalid files,
    // so a partially-broken file can still report what it would have triggered on.
    const triggers = Array.isArray(raw.triggers) ? (raw.triggers as Record<string, unknown>[]) : [];
    const stage = triggers.find((t) => t.kind === 'stage-on-entry')?.stage;
    return {
      ok: false,
      errors: result.errors,
      ...(typeof stage === 'string' ? { partialStageId: stage } : {}),
    };
  }
  return { ok: true, workflow };
}
