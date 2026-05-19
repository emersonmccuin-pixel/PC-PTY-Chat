// Closed-world variable catalog (Section 4h / D75).
//
// The fixed list of well-known variable names a workflow can reference. The
// system owns the list; authors / orchestrator / runtime never invent names.
// Every port in every node-kind's port schema (4h.2) and every wire in every
// workflow YAML (4h.3 / 4h.4) must resolve to a key on this catalog.
//
// Type vocabulary per D78: primitives only — no optionality, no nesting, no
// unions. `object` and `array` are escape hatches the save-time validator
// can't drill past. Adding entries later is an additive, non-breaking change;
// removing or renaming is breaking and requires a YAML migration pass.

/** Primitive types carried by catalog entries + node-port schemas. */
export type CatalogType =
  | 'ulid'
  | 'string'
  | 'text'
  | 'int'
  | 'bool'
  | 'object'
  | 'array';

/** Const list of catalog types, for runtime enumeration / save-time checks. */
export const CATALOG_TYPES: readonly CatalogType[] = Object.freeze([
  'ulid',
  'string',
  'text',
  'int',
  'bool',
  'object',
  'array',
] as const);

/** Where a catalog entry's value originates. A name may carry more than one
 *  source (e.g. `workItemId` flows in from a fire-trigger context OR a
 *  `create-work-item` node's output). The save-time validator + graph editor
 *  use this to decide which sockets a wire can attach to. */
export type CatalogSource = 'trigger' | 'runtime' | 'node-output';

export interface CatalogEntry {
  /** Identifier — authors reference this verbatim in YAML. */
  readonly name: string;
  /** Primitive type per D78. */
  readonly type: CatalogType;
  /** Origins this name can carry. */
  readonly sources: readonly CatalogSource[];
  /** Plain-English description; surfaces in editor port tooltips for SDR +
   *  PM views. Keep terse, no technical jargon. */
  readonly description: string;
}

/** The catalog. Single source of truth. */
export const WORKFLOW_CATALOG = {
  workItemId: {
    name: 'workItemId',
    type: 'ulid',
    sources: ['trigger', 'node-output'],
    description: 'The work item this workflow run is acting on.',
  },
  stageId: {
    name: 'stageId',
    type: 'string',
    sources: ['trigger'],
    description: 'The stage a work item entered to fire this workflow.',
  },
  projectId: {
    name: 'projectId',
    type: 'ulid',
    sources: ['runtime'],
    description: 'The current project. Always available.',
  },
  runId: {
    name: 'runId',
    type: 'ulid',
    sources: ['runtime'],
    description: 'This workflow run. Always available.',
  },
  sessionId: {
    name: 'sessionId',
    type: 'string',
    sources: ['runtime'],
    description: "The dispatched subagent's session id. Present only inside subagent nodes.",
  },
  worktreePath: {
    name: 'worktreePath',
    type: 'string',
    sources: ['runtime'],
    description: "Absolute path to this run's worktree. Present when worktree mode is auto.",
  },
  webhookBody: {
    name: 'webhookBody',
    type: 'text',
    sources: ['trigger'],
    description: 'The webhook request body. Webhook-triggered workflows only.',
  },
  webhookQuery: {
    name: 'webhookQuery',
    type: 'object',
    sources: ['trigger'],
    description: 'The webhook request query parameters. Webhook-triggered workflows only.',
  },
  webhookHeaders: {
    name: 'webhookHeaders',
    type: 'object',
    sources: ['trigger'],
    description: 'The webhook request headers. Webhook-triggered workflows only.',
  },
  webhookSource: {
    name: 'webhookSource',
    type: 'string',
    sources: ['trigger'],
    description: 'Which integration sent the webhook. Webhook-triggered workflows only.',
  },
} as const satisfies Record<string, CatalogEntry>;

/** Union of every catalog name. Narrowing-friendly. */
export type CatalogName = keyof typeof WORKFLOW_CATALOG;

/** Array form of the catalog names, for runtime iteration. */
export const WORKFLOW_CATALOG_NAMES: readonly CatalogName[] = Object.freeze(
  Object.keys(WORKFLOW_CATALOG) as CatalogName[],
);

/** Type-guard: is `name` a valid catalog name? */
export function isCatalogName(name: string): name is CatalogName {
  return Object.prototype.hasOwnProperty.call(WORKFLOW_CATALOG, name);
}

/** Look up a catalog entry by name. Returns undefined for unknown names. */
export function getCatalogEntry(name: string): CatalogEntry | undefined {
  return isCatalogName(name) ? WORKFLOW_CATALOG[name] : undefined;
}

/** True if this name can originate from the given source kind. Convenience
 *  for the save-time validator + editor UI. */
export function catalogNameHasSource(name: string, source: CatalogSource): boolean {
  const entry = getCatalogEntry(name);
  return entry ? entry.sources.includes(source) : false;
}
