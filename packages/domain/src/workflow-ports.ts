// Per-node-kind port schemas (Section 4h / 4h.2).
//
// Each DagNode discriminant declares its wirable inputs, templated text
// fields, and output shape. Port types are drawn from the closed-world
// catalog's primitive vocabulary (D78). Where a port name happens to match a
// catalog entry (e.g., `workItemId`), the port's type MUST equal the catalog
// entry's type — the 4h.4 save-time validator enforces this.
//
// This file is data + types only. No runtime behavior change. 4h.3 reads YAML
// against these schemas; 4h.4 validates wires; 4h.5 rewrites runtime
// substitution to walk the typed shape.
//
// Two field flavors per kind:
//  - **Typed input ports** (`inputs.ports[]`): single-value fields. YAML
//    carries either a literal or a structured wire (compact `'@X.Y'`).
//  - **Template-text fields** (`templates[]`): long-form text bodies with
//    `{{ name }}` placeholders. Each node grows a `wire:` block mapping
//    placeholder names to typed refs (D77 B).
//
// Output shape per kind: fixed list, author-declared (subagent's
// `output_schema:`), or nested-workflow (inherits the called workflow's IO).

import type { CatalogType } from './workflow-catalog.ts';
import type { DagNode } from './workflow.ts';

/** A typed input or output port on a node. */
export interface PortSpec {
  /** Port name. Kind-local; need not be a catalog name. When it IS a catalog
   *  name, `type` must equal the catalog entry's type. */
  readonly name: string;
  /** Primitive type per D78. */
  readonly type: CatalogType;
  /** Required ports must be wired (or supplied as a literal) for the node to
   *  be savable. Optional ports may be omitted. */
  readonly required: boolean;
  /** Plain-English description; surfaces in editor port tooltips. */
  readonly description: string;
}

/** A long-form text field on a node body. Author fills it with literal text
 *  containing `{{ name }}` placeholders, plus a node-level `wire:` block
 *  mapping each placeholder to a typed ref (D77 B). */
export interface TemplateFieldSpec {
  /** Field name as it appears in the YAML body. Dotted names denote nested
   *  fields on the kind's body (e.g., `on_reject.prompt`). */
  readonly name: string;
  /** Required template fields must be present for the node to be savable. */
  readonly required: boolean;
  /** Form-editor hint: render as single-line input rather than multi-line
   *  textarea. Default false. */
  readonly singleLine?: boolean;
  /** Plain-English description. */
  readonly description: string;
}

/** How a node kind's inputs or outputs are shaped. */
export type PortShape =
  /** A fixed list of ports baked into the kind. Empty array = no ports. */
  | { readonly mode: 'fixed'; readonly ports: readonly PortSpec[] }
  /** Author-declared via `output_schema:` (subagent kind, per D78). */
  | { readonly mode: 'author-declared' }
  /** Inherited from a called workflow's declared IO (workflow kind). */
  | { readonly mode: 'nested-workflow' };

export interface NodePortSchema {
  readonly kind: DagNode['kind'];
  readonly inputs: PortShape;
  readonly templates: readonly TemplateFieldSpec[];
  readonly outputs: PortShape;
}

function fixed(ports: readonly PortSpec[]) {
  return { mode: 'fixed' as const, ports };
}

/** Single source of truth for per-kind port schemas. */
export const NODE_PORT_SCHEMAS = {
  subagent: {
    kind: 'subagent',
    inputs: fixed([
      {
        name: 'subagent',
        type: 'string',
        required: true,
        description: 'Which subagent to dispatch (literal name or wired from upstream).',
      },
    ]),
    templates: [
      {
        name: 'prompt',
        required: true,
        description: 'The prompt sent to the subagent. Use {{ name }} placeholders + the wire: block.',
      },
    ],
    outputs: { mode: 'author-declared' },
  },

  bash: {
    kind: 'bash',
    inputs: fixed([]),
    templates: [
      { name: 'bash', required: true, description: 'Shell command body.' },
    ],
    outputs: fixed([
      { name: 'exitCode', type: 'int', required: true, description: 'Process exit code.' },
      { name: 'stdout', type: 'text', required: true, description: 'Captured stdout.' },
      { name: 'stderr', type: 'text', required: true, description: 'Captured stderr.' },
    ]),
  },

  http: {
    kind: 'http',
    inputs: fixed([
      {
        name: 'method',
        type: 'string',
        required: true,
        description: 'HTTP verb (GET / POST / PUT / PATCH / DELETE / HEAD).',
      },
      { name: 'url', type: 'string', required: true, description: 'Absolute request URL.' },
      {
        name: 'headers',
        type: 'object',
        required: false,
        description: 'Request headers. Use @env.NAME refs for auth secrets.',
      },
    ]),
    templates: [
      {
        name: 'body',
        required: false,
        description: 'Request body. JSON is encoded by the author.',
      },
    ],
    outputs: fixed([
      { name: 'status', type: 'int', required: true, description: 'Response status code.' },
      { name: 'body', type: 'text', required: true, description: 'Response body as text.' },
    ]),
  },

  script: {
    kind: 'script',
    inputs: fixed([]),
    templates: [
      {
        name: 'script',
        required: true,
        description: "Script body. The kind's runtime: config selects node or python.",
      },
    ],
    outputs: fixed([
      { name: 'exitCode', type: 'int', required: true, description: 'Process exit code.' },
      { name: 'stdout', type: 'text', required: true, description: 'Captured stdout.' },
      { name: 'stderr', type: 'text', required: true, description: 'Captured stderr.' },
    ]),
  },

  approval: {
    kind: 'approval',
    inputs: fixed([]),
    templates: [
      { name: 'message', required: true, description: 'The message shown to the human reviewer.' },
      {
        name: 'on_reject.prompt',
        required: false,
        description: 'Optional guidance shown when the reviewer rejects.',
      },
    ],
    outputs: fixed([
      {
        name: 'decision',
        type: 'string',
        required: true,
        description: 'Reviewer decision (approve / reject).',
      },
      {
        name: 'notes',
        type: 'text',
        required: true,
        description: 'Reviewer notes (may be empty).',
      },
    ]),
  },

  cancel: {
    kind: 'cancel',
    inputs: fixed([]),
    templates: [
      {
        name: 'cancel',
        required: true,
        description: 'Cancellation reason; surfaced in the run UI.',
      },
    ],
    outputs: fixed([]),
  },

  workflow: {
    kind: 'workflow',
    inputs: { mode: 'nested-workflow' },
    templates: [],
    outputs: { mode: 'nested-workflow' },
  },

  loop: {
    kind: 'loop',
    inputs: fixed([]),
    templates: [],
    outputs: fixed([]),
  },

  'attach-to-work-item': {
    kind: 'attach-to-work-item',
    inputs: fixed([
      {
        name: 'workItemId',
        type: 'ulid',
        required: true,
        description: 'The work item to attach onto.',
      },
      { name: 'name', type: 'string', required: true, description: 'Attachment filename.' },
    ]),
    templates: [
      { name: 'content', required: true, description: 'Inline attachment payload.' },
    ],
    outputs: fixed([]),
  },

  'create-work-item': {
    kind: 'create-work-item',
    inputs: fixed([
      {
        name: 'stage',
        type: 'string',
        required: false,
        description: "Stage id to land the new card in. Defaults to the project's first stage.",
      },
      {
        name: 'parentId',
        type: 'ulid',
        required: false,
        description: 'Parent work item id (for child cards).',
      },
    ]),
    templates: [
      { name: 'title', required: true, singleLine: true, description: 'Card title.' },
      { name: 'body', required: false, description: 'Card body / description.' },
    ],
    outputs: fixed([
      {
        name: 'workItemId',
        type: 'ulid',
        required: true,
        description: "The new card's id.",
      },
    ]),
  },

  'update-work-item': {
    kind: 'update-work-item',
    inputs: fixed([
      {
        name: 'workItemId',
        type: 'ulid',
        required: true,
        description: 'The work item to patch.',
      },
      {
        name: 'stage',
        type: 'string',
        required: false,
        description: 'New stage id. Omit to leave unchanged.',
      },
      {
        name: 'fields',
        type: 'object',
        required: false,
        description: "Partial fields patch; shallow-merged into the card's existing fields.",
      },
    ]),
    templates: [
      {
        name: 'title',
        required: false,
        singleLine: true,
        description: 'New title. Omit to leave unchanged.',
      },
      { name: 'body', required: false, description: 'New body. Omit to leave unchanged.' },
    ],
    outputs: fixed([]),
  },

  'write-to-worktree': {
    kind: 'write-to-worktree',
    inputs: fixed([
      {
        name: 'path',
        type: 'string',
        required: true,
        description: 'Worktree-relative file path.',
      },
    ]),
    templates: [
      { name: 'content', required: true, description: 'File contents.' },
    ],
    outputs: fixed([]),
  },

  'orchestrator-review': {
    kind: 'orchestrator-review',
    inputs: fixed([
      {
        name: 'artifact',
        type: 'string',
        required: false,
        description: 'Optional artifact reference (work-item id, attachment id, etc.).',
      },
    ]),
    templates: [
      { name: 'prompt', required: true, description: 'What the orchestrator should review.' },
      {
        name: 'on_revise.prompt',
        required: false,
        description: 'Optional revise-path guidance.',
      },
    ],
    outputs: fixed([
      {
        name: 'decision',
        type: 'string',
        required: true,
        description: 'Orchestrator decision (approve / reject / revise).',
      },
      { name: 'notes', type: 'text', required: true, description: 'Orchestrator notes.' },
    ]),
  },
} as const satisfies Record<DagNode['kind'], NodePortSchema>;

/** Look up a port schema by kind. Type-narrows through the kind union. */
export function getPortSchema<K extends DagNode['kind']>(
  kind: K,
): (typeof NODE_PORT_SCHEMAS)[K] {
  return NODE_PORT_SCHEMAS[kind];
}
