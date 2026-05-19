// Save-time validator for typed-edge workflows (Section 4h / 4h.4).
//
// Runs after the typed parser (4h.3) has produced a TypedWorkflow. Catches
// the structural mistakes that today's free-form `$node.field` substitution
// silently swallows at fire-time:
//
//   1. Wire-target resolution — every EdgeRef points at a real source:
//        • node ref → node exists + has the named output port
//          (fixed schema, or author-declared output_schema for subagent)
//        • trigger ref → output is in the workflow's trigger-exposed set,
//          accounting for multi-trigger intersection (D76)
//        • env ref → no check (env vars are external)
//   2. Type compatibility (D79) — only for typed-port wires; wire-block
//      entries feed template placeholders and stringify, no type concern.
//   3. Optional Work Contract + workItemId trigger wire (D76) — if any wire
//      consumes @trigger.workItemId, attached_to_work_item must be required.
//   4. Combined-graph cycle (D79) — depends_on + wires form one DAG.
//
// Wire-resolution paths use the shape `edges.<nodeId>.inputs.<portName>` or
// `edges.<nodeId>.wire.<localName>` — keys are stable across YAML
// formatting + match the in-memory NodeEdges shape.

import {
  NODE_PORT_SCHEMAS,
  WORKFLOW_CATALOG,
  isCatalogName,
} from '@pc/domain';
import type {
  AttachedToWorkItem,
  CatalogType,
  DagNode,
  EdgeRef,
  NodeEdges,
  Workflow,
} from '@pc/domain';

import type { ValidationError } from './validator.ts';
import type { TypedWorkflow } from './typed-parser.ts';

/** Run save-time checks against a TypedWorkflow. Empty array = OK. */
export function validateTypedWorkflow(
  typed: TypedWorkflow,
): readonly ValidationError[] {
  const errors: ValidationError[] = [];

  const allNodes = collectNodes(typed.workflow.nodes);
  const nodesById = new Map(allNodes.map((n) => [n.id, n]));
  const triggerExposed = computeTriggerExposedSet(typed.workflow);

  checkOptionalContractRule(typed, errors);

  const ctx: Ctx = {
    nodesById,
    typedEdges: typed.edges,
    triggerExposed,
  };

  for (const [nodeId, ne] of Object.entries(typed.edges)) {
    const node = nodesById.get(nodeId);
    if (!node) continue; // unknown nodeId — legacy parser would have failed first

    if (ne.inputs) {
      for (const [portName, ref] of Object.entries(ne.inputs)) {
        const portType = getInputPortType(node.kind, portName);
        checkTypedPortEdge(ref, portType, nodeId, portName, ctx, errors);
      }
    }

    if (ne.wire) {
      for (const [localName, ref] of Object.entries(ne.wire)) {
        const path = `edges.${nodeId}.wire.${localName}`;
        resolveSourceType(ref, ctx, errors, path);
      }
    }
  }

  checkCombinedCycles(typed, errors);

  return errors;
}

// --- helpers ----------------------------------------------------------------

interface Ctx {
  readonly nodesById: ReadonlyMap<string, DagNode>;
  readonly typedEdges: Readonly<Record<string, NodeEdges>>;
  readonly triggerExposed: ReadonlySet<string>;
}

function collectNodes(nodes: readonly DagNode[]): DagNode[] {
  const out: DagNode[] = [];
  for (const n of nodes) {
    out.push(n);
    if (n.kind === 'loop') out.push(...collectNodes(n.loop.body));
  }
  return out;
}

/** Per D76: what `@trigger.X` outputs are exposed given the workflow's
 *  trigger set + Work Contract. Always-on runtime vars are unconditional;
 *  per-trigger names are intersected when more than one trigger is declared
 *  (worst-case visibility — validator can't know which fire-path runs). */
function computeTriggerExposedSet(wf: Workflow): Set<string> {
  const exposed = new Set<string>();

  // Always-on runtime (D76 — bundled on the same root node for visual simplicity).
  exposed.add('projectId');
  exposed.add('runId');
  if (wf.worktree !== 'none') {
    // Default `worktree` mode is `auto` when missing; only `none` opts out.
    exposed.add('worktreePath');
  }

  const contract: AttachedToWorkItem = wf.attached_to_work_item ?? 'optional';
  const perTrigger: Set<string>[] = [];

  if (wf.triggers?.on_enter) {
    perTrigger.push(new Set(['workItemId', 'stageId']));
  }
  if (wf.triggers?.callable) {
    if (contract === 'required') {
      perTrigger.push(new Set(['workItemId']));
    } else {
      perTrigger.push(new Set()); // forbidden or optional → nothing card-related
    }
  }

  if (perTrigger.length > 0) {
    const first = perTrigger[0]!;
    for (const k of first) {
      if (perTrigger.every((s) => s.has(k))) exposed.add(k);
    }
  }

  return exposed;
}

function getInputPortType(
  kind: DagNode['kind'],
  portName: string,
): CatalogType | undefined {
  const schema = NODE_PORT_SCHEMAS[kind];
  if (schema.inputs.mode !== 'fixed') return undefined;
  return schema.inputs.ports.find((p) => p.name === portName)?.type;
}

function checkTypedPortEdge(
  ref: EdgeRef,
  portType: CatalogType | undefined,
  nodeId: string,
  portName: string,
  ctx: Ctx,
  errors: ValidationError[],
): void {
  const path = `edges.${nodeId}.inputs.${portName}`;
  const sourceType = resolveSourceType(ref, ctx, errors, path);
  if (sourceType === undefined || portType === undefined) return;

  if (!typesCompatible(sourceType, portType)) {
    errors.push({
      path,
      message: `type mismatch: source is ${sourceType}, port expects ${portType}`,
    });
  }
}

/** Resolve where a ref points + return its inferred type. Pushes a structured
 *  error and returns undefined if the ref can't be resolved. */
function resolveSourceType(
  ref: EdgeRef,
  ctx: Ctx,
  errors: ValidationError[],
  path: string,
): CatalogType | undefined {
  switch (ref.kind) {
    case 'node': {
      const src = ctx.nodesById.get(ref.nodeId);
      if (!src) {
        errors.push({
          path,
          message: `wires from unknown node "${ref.nodeId}"`,
        });
        return undefined;
      }
      return resolveNodeOutputType(src, ref.output, ctx, errors, path);
    }
    case 'trigger': {
      if (!ctx.triggerExposed.has(ref.output)) {
        errors.push({
          path,
          message: `wires from @trigger.${ref.output}, which this workflow's triggers do not expose`,
        });
        return undefined;
      }
      if (isCatalogName(ref.output)) {
        return WORKFLOW_CATALOG[ref.output].type;
      }
      return undefined;
    }
    case 'env':
      return 'string'; // env values are always strings
  }
}

function resolveNodeOutputType(
  src: DagNode,
  output: string,
  ctx: Ctx,
  errors: ValidationError[],
  path: string,
): CatalogType | undefined {
  const schema = NODE_PORT_SCHEMAS[src.kind];

  if (schema.outputs.mode === 'fixed') {
    const port = schema.outputs.ports.find((p) => p.name === output);
    if (!port) {
      errors.push({
        path,
        message: `node "${src.id}" (kind ${src.kind}) has no output "${output}"`,
      });
      return undefined;
    }
    return port.type;
  }

  if (schema.outputs.mode === 'author-declared') {
    const declared = ctx.typedEdges[src.id]?.output_schema;
    if (!declared) {
      errors.push({
        path,
        message: `subagent node "${src.id}" has no output_schema; declare one to wire from it`,
      });
      return undefined;
    }
    const t = declared[output];
    if (!t) {
      errors.push({
        path,
        message: `subagent node "${src.id}" output_schema does not declare "${output}"`,
      });
      return undefined;
    }
    return t;
  }

  // nested-workflow — can't statically resolve called workflow's outputs;
  // defer to dispatch-time. Skip type-check.
  return undefined;
}

/** Type compatibility per D79: same-type matches; ulid widens to string +
 *  text (constrained string → any string container); text ⇄ string
 *  bidirectional; everything else exact-match only. */
function typesCompatible(source: CatalogType, target: CatalogType): boolean {
  if (source === target) return true;
  if (source === 'ulid' && (target === 'string' || target === 'text')) return true;
  if (source === 'text' && target === 'string') return true;
  if (source === 'string' && target === 'text') return true;
  return false;
}

/** D76: if any wire reads @trigger.workItemId, the workflow must declare
 *  attached_to_work_item: required. Otherwise the fire-path isn't guaranteed
 *  to supply a card. */
function checkOptionalContractRule(
  typed: TypedWorkflow,
  errors: ValidationError[],
): void {
  const contract = typed.workflow.attached_to_work_item ?? 'optional';
  if (contract === 'required') return;

  for (const [nodeId, ne] of Object.entries(typed.edges)) {
    if (ne.inputs) {
      for (const [portName, ref] of Object.entries(ne.inputs)) {
        if (ref.kind === 'trigger' && ref.output === 'workItemId') {
          errors.push({
            path: `edges.${nodeId}.inputs.${portName}`,
            message:
              'this workflow uses the work item via @trigger.workItemId — change attached_to_work_item to required, or remove the wire',
          });
        }
      }
    }
    if (ne.wire) {
      for (const [localName, ref] of Object.entries(ne.wire)) {
        if (ref.kind === 'trigger' && ref.output === 'workItemId') {
          errors.push({
            path: `edges.${nodeId}.wire.${localName}`,
            message:
              'this workflow uses the work item via @trigger.workItemId — change attached_to_work_item to required, or remove the wire',
          });
        }
      }
    }
  }
}

/** D79: cycles rejected at save-time, combining explicit depends_on edges
 *  with implicit wire-derived edges. The legacy validator already catches
 *  depends_on-only cycles; this run catches cycles introduced by wires. */
function checkCombinedCycles(
  typed: TypedWorkflow,
  errors: ValidationError[],
): void {
  const allNodes = collectNodes(typed.workflow.nodes);
  const ids = new Set(allNodes.map((n) => n.id));
  const adj = new Map<string, Set<string>>();
  for (const n of allNodes) {
    adj.set(
      n.id,
      new Set((n.depends_on ?? []).filter((d) => ids.has(d))),
    );
  }

  for (const [nodeId, ne] of Object.entries(typed.edges)) {
    const set = adj.get(nodeId);
    if (!set) continue;
    const addRefDep = (ref: EdgeRef): void => {
      if (ref.kind === 'node' && ids.has(ref.nodeId) && ref.nodeId !== nodeId) {
        set.add(ref.nodeId);
      }
    };
    if (ne.inputs) for (const ref of Object.values(ne.inputs)) addRefDep(ref);
    if (ne.wire) for (const ref of Object.values(ne.wire)) addRefDep(ref);
  }

  const color = new Map<string, 'white' | 'gray' | 'black'>();
  for (const n of allNodes) color.set(n.id, 'white');
  const cycles: string[][] = [];

  const dfs = (id: string, stack: string[]): void => {
    color.set(id, 'gray');
    stack.push(id);
    for (const next of adj.get(id) ?? []) {
      const c = color.get(next);
      if (c === 'gray') {
        const startIdx = stack.indexOf(next);
        cycles.push([...stack.slice(startIdx), next]);
      } else if (c === 'white') {
        dfs(next, stack);
      }
    }
    stack.pop();
    color.set(id, 'black');
  };
  for (const n of allNodes) {
    if (color.get(n.id) === 'white') dfs(n.id, []);
  }

  const seen = new Set<string>();
  for (const c of cycles) {
    const norm = c.slice(0, -1).join(',');
    if (seen.has(norm)) continue;
    seen.add(norm);
    errors.push({
      path: 'nodes',
      message: `cycle (depends_on + wires): ${c.join(' → ')}`,
    });
  }
}
