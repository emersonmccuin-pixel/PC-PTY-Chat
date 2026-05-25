// Section 19.7 — stage-on-entry trigger matching (pure, I/O-free). Given a stage
// move + a set of v2 workflows, decide which should fire. Stage-on-entry fires
// on FORWARD moves only by default (lock 2); opt into backward moves via
// `also_fire_on_regression: true`. Manual / orchestrator-call fire through
// pc_run_workflow (not here); schedule + event register elsewhere (cron lib /
// webhook route). The live registry injects the workflow list + stage order;
// this module is the decision core, unit-testable without a store.

import type { WorkflowV2 } from '@pc/domain';

export interface StageMove {
  /** Stage the card came from. null = created directly in `toStageId`. */
  fromStageId: string | null;
  toStageId: string;
}

type StageOrder = readonly { id: string; order?: number }[];

/**
 * A move is "forward" when the target stage's order is strictly greater than
 * the source's. A create-in-place (no `from`) is forward — it's an entry, not a
 * regression. Unknown stage ids fail OPEN (treated as forward → fire); the save
 * validator already guards `trigger.stage` against the project's real stages.
 */
export function isForwardStageMove(stages: StageOrder, move: StageMove): boolean {
  if (move.fromStageId === null) return true;
  const orderOf = (id: string): number | undefined => stages.find((s) => s.id === id)?.order;
  const from = orderOf(move.fromStageId);
  const to = orderOf(move.toStageId);
  if (from === undefined || to === undefined) return true;
  return to > from;
}

/** True if this workflow has a stage-on-entry trigger that fires for this move.
 *  Disabled workflows never fire. */
export function firesOnStageEntry(
  workflow: WorkflowV2.Workflow,
  move: StageMove,
  forward: boolean
): boolean {
  if (workflow.disabled) return false;
  for (const t of workflow.triggers ?? []) {
    if (t.kind !== 'stage-on-entry') continue;
    if (t.stage !== move.toStageId) continue;
    if (forward || t.also_fire_on_regression === true) return true;
  }
  return false;
}

/** All enabled workflows whose stage-on-entry trigger matches this move. The
 *  caller (19.7 wiring) decides policy for >1 match (fire all vs. flag). */
export function selectStageEntryWorkflows(
  workflows: readonly WorkflowV2.Workflow[],
  stages: StageOrder,
  move: StageMove
): WorkflowV2.Workflow[] {
  const forward = isForwardStageMove(stages, move);
  return workflows.filter((w) => firesOnStageEntry(w, move, forward));
}
