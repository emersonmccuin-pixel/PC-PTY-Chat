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
