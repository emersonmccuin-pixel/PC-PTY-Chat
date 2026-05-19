// Typed-edge YAML parser (Section 4h / 4h.3).
//
// Reads workflow YAML in the new D77 shape and produces a TypedWorkflow:
// the legacy Workflow shape (unchanged) plus a flat `edges` map keyed by
// node id that captures the structured wires.
//
// The legacy parser (`parseWorkflowText` in validator.ts) still runs first to
// produce the structural Workflow. This parser walks the same YAML a second
// time to extract:
//   - typed-port wires under each kind's body (D77 A — `'@X.Y'` compact refs
//     on fields named in NODE_PORT_SCHEMAS[kind].inputs.ports)
//   - `wire:` block entries under each node (D77 B — local placeholder names
//     for template-text fields)
//   - `output_schema:` on subagent nodes (D78)
//
// Wire-resolution + type-compatibility checks live in 4h.4. This parser only
// fails on structural shape errors (malformed `output_schema:` type, etc.).
//
// Loop bodies are walked recursively so inner nodes' edges land in the same
// flat map.

import { load as yamlLoad } from 'js-yaml';

import {
  CATALOG_TYPES,
  NODE_PORT_SCHEMAS,
  isCompactEdgeRef,
  parseEdgeRef,
} from '@pc/domain';
import type {
  CatalogType,
  DagNode,
  EdgeRef,
  NodeEdges,
  Workflow,
} from '@pc/domain';

import { parseWorkflowText } from './validator.ts';
import type { ValidationError } from './validator.ts';

export interface TypedWorkflow {
  readonly workflow: Workflow;
  /** Per-node typed-edge data, keyed by node id. Flat across loop bodies. */
  readonly edges: Readonly<Record<string, NodeEdges>>;
}

export interface TypedValidationResult {
  readonly ok: boolean;
  readonly workflow?: Workflow;
  readonly edges?: Readonly<Record<string, NodeEdges>>;
  readonly errors: readonly ValidationError[];
  readonly partialStageId?: string;
}

/** Body-field name per kind. Flat kinds (subagent, bash, …) read ports from
 *  the top-level node object; nested kinds read from `node[kindName]`. */
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

const TYPE_BODY_FIELDS: readonly DagNode['kind'][] = [
  'subagent',
  'bash',
  'http',
  'script',
  'approval',
  'cancel',
  'workflow',
  'loop',
  'attach-to-work-item',
  'create-work-item',
  'update-work-item',
  'write-to-worktree',
  'orchestrator-review',
];

const CATALOG_TYPE_SET: ReadonlySet<string> = new Set(CATALOG_TYPES);

/** Parse + extract typed edges from raw YAML text. Used by the registry once
 *  4h.8 wires it in; for now exposed for tests + later sub-phases. */
export function parseTypedWorkflowText(
  yamlText: string,
  opts: { expectedId: string },
): TypedValidationResult {
  const legacy = parseWorkflowText(yamlText, opts);
  if (!legacy.ok || !legacy.workflow) {
    return {
      ok: false,
      errors: legacy.errors,
      partialStageId: legacy.partialStageId,
    };
  }

  let raw: unknown;
  try {
    raw = yamlLoad(yamlText);
  } catch (err) {
    return {
      ok: false,
      errors: [{ path: '', message: `yaml parse failed: ${(err as Error).message}` }],
      partialStageId: legacy.partialStageId,
    };
  }

  const errors: ValidationError[] = [];
  const edges: Record<string, NodeEdges> = {};
  if (isObj(raw) && Array.isArray(raw.nodes)) {
    extractFromNodeArray(raw.nodes, 'nodes', edges, errors);
  }

  if (errors.length > 0) {
    return { ok: false, errors, partialStageId: legacy.partialStageId };
  }

  return {
    ok: true,
    workflow: legacy.workflow,
    edges,
    errors: [],
    partialStageId: legacy.partialStageId,
  };
}

function extractFromNodeArray(
  rawNodes: unknown[],
  basePath: string,
  edges: Record<string, NodeEdges>,
  errors: ValidationError[],
): void {
  rawNodes.forEach((rawNode, i) => {
    const path = `${basePath}[${i}]`;
    if (!isObj(rawNode)) return;
    const id = typeof rawNode.id === 'string' ? rawNode.id : undefined;
    if (!id) return;
    const kind = pickKind(rawNode);
    if (!kind) return;

    const nodeEdges = extractEdgesForNode(rawNode, kind, path, errors);
    if (
      nodeEdges.inputs !== undefined ||
      nodeEdges.wire !== undefined ||
      nodeEdges.output_schema !== undefined
    ) {
      edges[id] = nodeEdges;
    }

    // Recurse into loop bodies.
    if (kind === 'loop' && isObj(rawNode.loop) && Array.isArray(rawNode.loop.body)) {
      extractFromNodeArray(rawNode.loop.body, `${path}.loop.body`, edges, errors);
    }
  });
}

/** Pick the kind discriminator by looking at which type-body field is set on
 *  the raw node. Honors the same legacy aliases the validator normalizes
 *  (`agent:` → `subagent:`, `human-review:` → `approval:`). */
function pickKind(raw: Record<string, unknown>): DagNode['kind'] | undefined {
  const present: DagNode['kind'][] = [];
  for (const k of TYPE_BODY_FIELDS) {
    if (raw[k] !== undefined) present.push(k);
  }
  if (raw.agent !== undefined && raw.subagent === undefined && !present.includes('subagent')) {
    present.push('subagent');
  }
  if (
    raw['human-review'] !== undefined &&
    raw.approval === undefined &&
    !present.includes('approval')
  ) {
    present.push('approval');
  }
  // Exactly one kind = good. Zero or many = legacy parser already errored.
  return present.length === 1 ? present[0] : undefined;
}

function extractEdgesForNode(
  rawNode: Record<string, unknown>,
  kind: DagNode['kind'],
  path: string,
  errors: ValidationError[],
): NodeEdges {
  const schema = NODE_PORT_SCHEMAS[kind];
  const result: { -readonly [K in keyof NodeEdges]: NodeEdges[K] } = {};

  // (1) Typed-port wires from the kind's body.
  if (schema.inputs.mode === 'fixed') {
    const bodyField = KIND_BODY_FIELD[kind];
    const body = bodyField ? rawNode[bodyField] : rawNode;
    if (isObj(body)) {
      const inputs: Record<string, EdgeRef> = {};
      for (const port of schema.inputs.ports) {
        const val = body[port.name];
        if (isCompactEdgeRef(val)) {
          const ref = parseEdgeRef(val);
          if (ref) {
            inputs[port.name] = ref;
          } else {
            errors.push({
              path: `${pathForPort(path, bodyField, port.name)}`,
              message: `malformed edge ref "${val}" (expected '@<source>.<field>')`,
            });
          }
        }
      }
      if (Object.keys(inputs).length > 0) result.inputs = inputs;
    }
  }

  // (2) `wire:` block — local placeholder names for template-text fields.
  if (rawNode.wire !== undefined) {
    if (!isObj(rawNode.wire)) {
      errors.push({
        path: `${path}.wire`,
        message: 'must be a name → @ref map if provided',
      });
    } else {
      const wire: Record<string, EdgeRef> = {};
      for (const [localName, val] of Object.entries(rawNode.wire)) {
        if (typeof val !== 'string') {
          errors.push({
            path: `${path}.wire.${localName}`,
            message: 'must be a string edge ref (e.g. \'@nodeId.output\')',
          });
          continue;
        }
        const ref = parseEdgeRef(val);
        if (!ref) {
          errors.push({
            path: `${path}.wire.${localName}`,
            message: `malformed edge ref "${val}" (expected '@<source>.<field>')`,
          });
          continue;
        }
        wire[localName] = ref;
      }
      if (Object.keys(wire).length > 0) result.wire = wire;
    }
  }

  // (3) `output_schema:` — subagent only (D78).
  if (kind === 'subagent' && rawNode.output_schema !== undefined) {
    if (!isObj(rawNode.output_schema)) {
      errors.push({
        path: `${path}.output_schema`,
        message: 'must be a name → type map if provided',
      });
    } else {
      const schemaMap: Record<string, CatalogType> = {};
      for (const [fieldName, type] of Object.entries(rawNode.output_schema)) {
        if (typeof type !== 'string' || !CATALOG_TYPE_SET.has(type)) {
          errors.push({
            path: `${path}.output_schema.${fieldName}`,
            message: `type must be one of ${CATALOG_TYPES.join(', ')}`,
          });
          continue;
        }
        schemaMap[fieldName] = type as CatalogType;
      }
      if (Object.keys(schemaMap).length > 0) result.output_schema = schemaMap;
    }
  }

  return result;
}

function pathForPort(
  nodePath: string,
  bodyField: string | null,
  portName: string,
): string {
  return bodyField ? `${nodePath}.${bodyField}.${portName}` : `${nodePath}.${portName}`;
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
