// Section 27.7 — auto-advance a verified work item to the project's is_done stage.
//
// Called from `agent-verification.ts` (tier-1 PASS path) + `agent-verification-
// review.ts` (approve path) after the WI's status has already flipped to
// 'complete' via `applyAgentVerification`. If the project has a stage with
// `isDone: true` AND the WI isn't already in it, this moves the card and
// appends a 'move' history entry. The auto-flip wired in 27.5 keeps the
// post-move status at 'complete'.
//
// No-op when:
//   - project has no `isDone` stage (older projects pre-backfill, or user
//     unflagged it)
//   - WI is already in the `isDone` stage (orchestrator may have moved it
//     by hand before the contract resolved)
//
// Returns the moved WorkItem (or `null` if no move happened — caller can
// proceed unchanged either way).

import { getWorkItem, moveWorkItemStage } from '@pc/db';
import type { Project, ULID, WorkItem } from '@pc/domain';

export function autoAdvanceToDoneStage(
  workItemId: ULID,
  project: Project,
): WorkItem | null {
  const doneStage = project.stages.find((s) => s.isDone);
  if (!doneStage) return null;
  const wi = getWorkItem(workItemId);
  if (!wi) return null;
  if (wi.stageId === doneStage.id) return null;
  // 27.5's auto-flip resolves the post-move status from the stage's flags,
  // so passing 'complete' here is redundant-but-correct (idempotent with the
  // resolver). Keep the explicit value so this site reads cleanly in isolation.
  return moveWorkItemStage(workItemId, doneStage.id, 'complete');
}
