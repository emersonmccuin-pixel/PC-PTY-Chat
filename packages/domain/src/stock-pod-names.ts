// Canonical roster of stock pod names.
//
// One source of truth for "is this pod stock?" / "what stock pods exist?"
// checks across the codebase. The actual seed content (prompts, tool lists,
// model defaults) lives in apps/server/src/services/{stock-pod-seed,
// orchestrator-pod-content}.ts and is keyed off these names. A boot-time
// drift assertion in stock-pod-seed.ts verifies the seeded names match this
// list, so adding a new stock pod here without seeding it (or vice versa)
// fails fast.

/** Ordered tuple form — use when iteration order matters or you need a
 *  literal-union type via `(typeof STOCK_POD_NAME_LIST)[number]`. */
export const STOCK_POD_NAME_LIST = [
  'orchestrator',
  'researcher',
  'writer',
  'code-writer',
  'reviewer',
  'planner',
  'extractor',
  'agent-designer',
  'quick-tasks-pm',
  // 2026-05-25: in-app specialist seeded by Section 36 (commit 78751c4 +
  // the stashed WIP at stash@{0}). Added here as a server-boot unblock —
  // the rest of Section 36's surface (origin column wiring, pod-routes
  // shape, pod-defaults, etc.) is still parked in stash@{0}.
  'caisson',
  // 2026-05-25: v2 workflow-builder pod (Section 19.9). Mirrors agent-designer
  // structurally — transient session, replaces CC's default identity, drives
  // the "+ New workflow" modal. v2-schema-aware: 5 node kinds, $-refs,
  // reject-only kick-back primitive. Distinct from the v1 `workflow-creator`
  // pod (which targets the typed-edges + inputs: schema and stays alive until
  // Section 19.12 culls it).
  'workflow-builder',
] as const;

export type StockPodName = (typeof STOCK_POD_NAME_LIST)[number];

/** Set form for membership checks (`STOCK_POD_NAMES.has(name)`). The default
 *  shape consumers reach for — matches the existing inline call sites. */
export const STOCK_POD_NAMES: ReadonlySet<string> = new Set(STOCK_POD_NAME_LIST);

/** Stock pods the orchestrator can dispatch — everyone except orchestrator
 *  itself (can't dispatch to itself) and `quick-tasks-pm` (the PM for the
 *  Quick Tasks special project, not a worker — only ever loaded as the
 *  spawn target for that project's chat). */
export const DISPATCHABLE_STOCK_PODS: ReadonlySet<string> = new Set(
  STOCK_POD_NAME_LIST.filter(
    (name) => name !== 'orchestrator' && name !== 'quick-tasks-pm',
  ),
);
