// Web-side mirror of the per-kind port schemas + catalog types from
// packages/domain/src/workflow-ports.ts + workflow-catalog.ts.
//
// Per the "web stays off @pc/domain" policy (3d session-log finding #2), the
// browser bundle inlines this rather than pulling @pc/domain which transitively
// drags `js-yaml` + Node-only deps. Drift risk vs. the domain copy is real;
// the domain test suite remains the contract. If this mirror grows past a
// second 4h-ish wave of features, reconsider promoting @pc/domain to a
// browser-safe subpath export.
//
// Only the bits the graph viewer needs are mirrored:
//   - per-kind output port list (name + type), or 'author-declared' marker
//     for subagent (output_schema arrives via the typed-edge envelope), or
//     'nested' marker for the workflow kind.
//   - per-kind input port list (name + type) for the SDR socket layout.
//   - per-kind template-field name list (informational; sockets for these
//     come from the node's `wire:` keys, not the kind schema).
//   - type → color class map per D79.

import type { CatalogType, WfDagNode } from '@/api/client';

export type WebPortSpec = {
  readonly name: string;
  readonly type: CatalogType;
  readonly required: boolean;
  readonly description: string;
};

export type WebPortShape =
  | { readonly mode: 'fixed'; readonly ports: readonly WebPortSpec[] }
  | { readonly mode: 'author-declared' }
  | { readonly mode: 'nested-workflow' };

export interface WebNodePortSchema {
  readonly inputs: WebPortShape;
  readonly templates: readonly string[];
  readonly outputs: WebPortShape;
}

const fixed = (ports: readonly WebPortSpec[]) => ({ mode: 'fixed' as const, ports });

export const WEB_NODE_PORTS: Record<WfDagNode['kind'], WebNodePortSchema> = {
  subagent: {
    inputs: fixed([
      { name: 'subagent', type: 'string', required: true, description: 'Which subagent to dispatch.' },
    ]),
    templates: ['prompt'],
    outputs: { mode: 'author-declared' },
  },
  bash: {
    inputs: fixed([]),
    templates: ['bash'],
    outputs: fixed([
      { name: 'exitCode', type: 'int', required: true, description: 'Process exit code.' },
      { name: 'stdout', type: 'text', required: true, description: 'Captured stdout.' },
      { name: 'stderr', type: 'text', required: true, description: 'Captured stderr.' },
    ]),
  },
  http: {
    inputs: fixed([
      { name: 'method', type: 'string', required: true, description: 'HTTP verb.' },
      { name: 'url', type: 'string', required: true, description: 'Absolute request URL.' },
      { name: 'headers', type: 'object', required: false, description: 'Request headers.' },
    ]),
    templates: ['body'],
    outputs: fixed([
      { name: 'status', type: 'int', required: true, description: 'Response status code.' },
      { name: 'body', type: 'text', required: true, description: 'Response body as text.' },
    ]),
  },
  script: {
    inputs: fixed([]),
    templates: ['script'],
    outputs: fixed([
      { name: 'exitCode', type: 'int', required: true, description: 'Process exit code.' },
      { name: 'stdout', type: 'text', required: true, description: 'Captured stdout.' },
      { name: 'stderr', type: 'text', required: true, description: 'Captured stderr.' },
    ]),
  },
  approval: {
    inputs: fixed([]),
    templates: ['message', 'on_reject.prompt'],
    outputs: fixed([
      { name: 'approved', type: 'bool', required: true, description: 'Whether the reviewer approved.' },
      { name: 'response', type: 'text', required: true, description: 'Reviewer response text.' },
    ]),
  },
  cancel: {
    inputs: fixed([]),
    templates: ['cancel'],
    outputs: fixed([]),
  },
  workflow: {
    inputs: { mode: 'nested-workflow' },
    templates: [],
    outputs: { mode: 'nested-workflow' },
  },
  loop: {
    inputs: fixed([]),
    templates: [],
    outputs: fixed([]),
  },
  'attach-to-work-item': {
    inputs: fixed([
      { name: 'workItemId', type: 'ulid', required: true, description: 'The work item to attach onto.' },
      { name: 'name', type: 'string', required: true, description: 'Attachment filename.' },
    ]),
    templates: ['content'],
    outputs: fixed([]),
  },
  'create-work-item': {
    inputs: fixed([
      { name: 'stage', type: 'string', required: false, description: 'Stage id to land the new card in.' },
      { name: 'parentId', type: 'ulid', required: false, description: 'Parent work item id.' },
    ]),
    templates: ['title', 'body'],
    outputs: fixed([
      { name: 'workItemId', type: 'ulid', required: true, description: "The new card's id." },
    ]),
  },
  'update-work-item': {
    inputs: fixed([
      { name: 'workItemId', type: 'ulid', required: true, description: 'The work item to patch.' },
      { name: 'stage', type: 'string', required: false, description: 'New stage id.' },
      { name: 'fields', type: 'object', required: false, description: 'Partial fields patch.' },
    ]),
    templates: ['title', 'body'],
    outputs: fixed([]),
  },
  'write-to-worktree': {
    inputs: fixed([
      { name: 'path', type: 'string', required: true, description: 'Worktree-relative file path.' },
    ]),
    templates: ['content'],
    outputs: fixed([]),
  },
  'orchestrator-review': {
    inputs: fixed([
      { name: 'artifact', type: 'string', required: false, description: 'Optional artifact reference.' },
    ]),
    templates: ['prompt', 'on_revise.prompt'],
    outputs: fixed([
      { name: 'decision', type: 'string', required: true, description: 'Orchestrator decision.' },
      { name: 'notes', type: 'text', required: true, description: 'Orchestrator notes.' },
    ]),
  },
};

// ── Trigger node outputs (D76 synthetic root) ──────────────────────────────
// Per-trigger-kind output shape, drawn from the closed-world catalog. The
// graph viewer uses this to know what sockets to put on the synthetic
// trigger node. Multi-trigger workflows use the INTERSECTION (D76).

export const TRIGGER_OUTPUTS = {
  'on_enter': [
    { name: 'workItemId', type: 'ulid' as CatalogType },
    { name: 'stageId', type: 'string' as CatalogType },
  ],
  callable: [
    { name: 'workItemId', type: 'ulid' as CatalogType },
  ],
} as const;

// ── Type color map (D79) ───────────────────────────────────────────────────
// Socket colors per catalog primitive. Tailwind utility classes — match the
// existing semantic color tokens already in the app.

// Bright fills so sockets are unambiguously visible on the node body.
// Type encoding still lives in these colors; D79's full color spec ships when
// PM-mode labels land in 4h.11b. For now: ulid blue · string/text neutral
// (white) · int green · bool yellow · object/array brand-yellow.
export const TYPE_COLOR_BG: Record<CatalogType, string> = {
  ulid: 'bg-info',
  string: 'bg-foreground',
  text: 'bg-foreground',
  int: 'bg-success',
  bool: 'bg-warning',
  object: 'bg-primary',
  array: 'bg-primary',
};

export const TYPE_COLOR_BORDER: Record<CatalogType, string> = {
  ulid: 'border-info',
  string: 'border-foreground',
  text: 'border-foreground',
  int: 'border-success',
  bool: 'border-warning',
  object: 'border-primary',
  array: 'border-primary',
};
