// Typed-edge runtime substitution (Section 4h / 4h.5).
//
// Replaces the regex-string substitution path for fields the typed parser
// (4h.3) was able to extract into structured edges. Sits IN FRONT of the
// legacy `substituteOutputs` so un-migrated YAMLs keep working until D80's
// boot-time migration runs (4h.7 + 4h.8) and the legacy regex is dropped
// (4h.9).
//
// Two consumer shapes per D77:
//
//   - **Typed-port single-value fields** (`workItemId`, `url`, `method`, …)
//     carry one whole value. When the parser saw `'@X.Y'`, it stripped the
//     raw string into a structured EdgeRef on `edges[nodeId].inputs[port]`.
//     `applyTypedPortEdges` walks the node body, looks up each declared
//     port, and rewrites the body value to the resolved edge value before
//     dispatch. Downstream code that reads `node.http.url` (etc.) doesn't
//     change — it sees a literal string / object / number, not a ref.
//
//   - **Template-text fields** (`prompt`, `bash`, `body`, `content`, …)
//     hold long-form text with `{{ name }}` placeholders, paired with a
//     node-level `wire:` block on `edges[nodeId].wire[name]`.
//     `makeNodeBoundSubstituter` returns a node-bound substituter that
//     first replaces `{{ name }}` from the wire block, then defers to
//     the legacy `substituteOutputs` for any remaining `$X.Y` / `$inputs.Y`
//     / `$ENV.NAME` tokens. After 4h.7/8 migration, the legacy pass becomes
//     a no-op on every file and gets removed by 4h.9.
//
// Trigger-context resolution (D76's synthetic root node) is implicit here:
// `@trigger.workItemId` reads from `run.workItemId`; `@trigger.stageId` from
// `run.stageId`; runtime-always vars (`projectId`, `runId`, `worktreePath`)
// from the natural fields. Webhook entries route through `run.inputs.*` for
// now; 4g may wire them more directly.

import type {
  DagNode,
  EdgeRef,
  NodeEdges,
  WorkflowRun,
} from '@pc/domain';

/** Same shape `output-substitution.ts:substituteOutputs` exports — duplicated
 *  inline to avoid coupling on the legacy module right before 4h.9 drops it. */
export type SubstituteOutputs = (text: string, run: WorkflowRun) => string;

/** YAML body field name per kind. Mirrors `KIND_BODY_FIELD` inside the typed
 *  parser (kept in sync intentionally — a kind whose body lives at the top
 *  level here must also be top-level there). */
const KIND_BODY_FIELD: Record<DagNode['kind'], string | null> = {
  subagent: null,
  bash: null,
  http: 'http',
  script: null,
  approval: 'approval',
  cancel: null,
  workflow: null,
  loop: 'loop',
  'attach-to-work-item': 'attach-to-work-item',
  'create-work-item': 'create-work-item',
  'update-work-item': 'update-work-item',
  'write-to-worktree': 'write-to-worktree',
  'orchestrator-review': 'orchestrator-review',
};

/** `{{ name }}` placeholder — matches a single identifier between mustaches,
 *  whitespace tolerated. Same identifier shape as the typed parser's compact
 *  edge-ref grammar (`isCompactEdgeRef` / `parseEdgeRef`). */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g;

/** Per-runtime context bundled with the run, for trigger / env / project
 *  lookups. Built once per `dispatch()` call and shared with both the port
 *  rewriter and the template substituter. */
export interface TypedRefContext {
  run: WorkflowRun;
  projectId: string;
  edges: Readonly<Record<string, NodeEdges>>;
}

/** Look up a `@trigger.<name>` value. Returns undefined when the name isn't
 *  in scope for this run; callers stringify (empty string) for templates and
 *  preserve null/object shape for typed ports. */
export function resolveTriggerValue(name: string, ctx: TypedRefContext): unknown {
  const { run, projectId } = ctx;
  switch (name) {
    case 'workItemId':
      return run.workItemId;
    case 'stageId':
      return run.stageId;
    case 'projectId':
      return projectId;
    case 'runId':
      return run.id;
    case 'worktreePath':
      return run.worktreePath ?? undefined;
    case 'sessionId':
    case 'webhookBody':
    case 'webhookQuery':
    case 'webhookHeaders':
    case 'webhookSource':
      // Forward-included in the catalog (D75); webhook entries land via the
      // future 4g fire-path through `run.inputs.<name>`. sessionId is
      // populated by the subagent-dispatch path when present.
      return run.inputs?.[name];
    default:
      return undefined;
  }
}

/** Resolve a structured EdgeRef into a concrete value. Returns undefined for
 *  missing node outputs / unknown trigger names / unset env vars. */
export function resolveEdgeRef(ref: EdgeRef, ctx: TypedRefContext): unknown {
  switch (ref.kind) {
    case 'node': {
      const nodeOut = ctx.run.nodeOutputs[ref.nodeId];
      if (!nodeOut) return undefined;
      const out = nodeOut.output;
      if (out === undefined || out === null) return undefined;
      if (typeof out !== 'object' || Array.isArray(out)) {
        // Subagents that return a primitive (e.g. plain-text result) — only
        // a singleton ref pointing at the field name "result" / "output"
        // makes sense; otherwise no field to drill into.
        return undefined;
      }
      return (out as Record<string, unknown>)[ref.output];
    }
    case 'trigger':
      return resolveTriggerValue(ref.output, ctx);
    case 'env':
      return process.env[ref.name];
  }
}

/** Format a resolved value into the string form that downstream dispatchers
 *  + legacy substituter expect. Mirrors `output-substitution.ts:stringifyValue`. */
function stringifyValue(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Rewrite a node's body so each port wired by the parser carries its
 *  resolved value (not the `'@X.Y'` literal). The result is shape-identical
 *  to the input — same kind, same body shape, same non-port fields — only
 *  the wired ports are touched.
 *
 *  Returns the original node unchanged when the node has no typed edges
 *  registered (no-op fast path; legacy YAMLs hit this branch). */
export function applyTypedPortEdges<N extends DagNode>(
  node: N,
  ctx: TypedRefContext,
): N {
  const nodeEdges = ctx.edges[node.id];
  if (!nodeEdges?.inputs) return node;

  const bodyField = KIND_BODY_FIELD[node.kind];
  const clone: Record<string, unknown> = { ...(node as unknown as Record<string, unknown>) };
  let bodyCopy: Record<string, unknown> | undefined;
  if (bodyField) {
    const body = (clone[bodyField] as Record<string, unknown> | undefined) ?? {};
    bodyCopy = { ...body };
    clone[bodyField] = bodyCopy;
  }

  for (const [portName, ref] of Object.entries(nodeEdges.inputs)) {
    const resolved = resolveEdgeRef(ref, ctx);
    // Typed ports CAN be object/array (e.g. http.headers). When the resolved
    // value isn't a string, we set it verbatim — the dispatcher reads it as
    // its declared type. When it IS a string-like (number, bool, ulid),
    // stringify so downstream legacy substituter + .trim()/etc. all work.
    const target: Record<string, unknown> = bodyField ? bodyCopy! : clone;
    if (resolved === undefined || resolved === null) {
      target[portName] = '';
    } else if (typeof resolved === 'object') {
      target[portName] = resolved;
    } else if (typeof resolved === 'string') {
      target[portName] = resolved;
    } else {
      target[portName] = String(resolved);
    }
  }

  return clone as unknown as N;
}

/** Build a `SubstituteOutputs`-compatible function bound to this node's
 *  template-field wire map. Replaces `{{ name }}` placeholders from the
 *  wire block first; then defers to the legacy substituter for any
 *  remaining `$X.Y` patterns. The legacy pass keeps un-migrated YAMLs
 *  working until 4h.7/8 boot-migration lands; 4h.9 strips it.
 *
 *  Why bind per-node: the wire-name → EdgeRef map is a per-node thing.
 *  Without binding, every dispatcher would have to pass `(text, nodeId)`
 *  through the step-file boundary, churning every call site. */
export function makeNodeBoundSubstituter(
  nodeId: string,
  ctx: TypedRefContext,
  legacy: SubstituteOutputs,
): SubstituteOutputs {
  const wire = ctx.edges[nodeId]?.wire;
  if (!wire) {
    // Fast path — no wire block for this node. Legacy passes through
    // unchanged so un-migrated YAMLs short-circuit with zero overhead.
    return legacy;
  }

  return (text: string, run: WorkflowRun): string => {
    const afterWire = text.replace(PLACEHOLDER_RE, (_match: string, name: string) => {
      const ref = wire[name];
      if (!ref) return '';
      return stringifyValue(resolveEdgeRef(ref, ctx));
    });
    return legacy(afterWire, run);
  };
}
