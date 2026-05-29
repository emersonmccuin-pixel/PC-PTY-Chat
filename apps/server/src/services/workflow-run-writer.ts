// UI Spine step 2 — announcing write-door for workflow_runs_v2.
//
// EVERY mutation of a workflow_runs_v2 row MUST go through a function here.
// Each function: (1) calls the repo write (which increments `rev`),
// (2) reads back the full row, (3) broadcasts a versioned full-snapshot WS
// delta. "Forgetting to announce" becomes structurally impossible because the
// only exported write paths are these announcing functions.
//
// The `broadcast` callback is `(event: unknown) => void` scoped to a single
// project — callers typically pass `opts.broadcast` from DagRunServiceOptions
// or a `broadcastTo(projectId, ...)` lambda.

import type { ULID, WorkflowV2 } from '@pc/domain';
import { workflowRunsV2Repo, type WorkflowRunV2Record } from '@pc/db';

export type RunBroadcast = (event: unknown) => void;

// ---------------------------------------------------------------------------
// Internal: build the WS delta envelope from a full row snapshot.
// ---------------------------------------------------------------------------

function buildDelta(row: WorkflowRunV2Record, projectId: ULID): unknown {
  return {
    type: 'workflow-v2-run-changed',
    projectId,
    run: row,
  };
}

/** Read the full row and broadcast a versioned snapshot. No-ops if the row
 *  is gone (caller's write was a no-op too). */
export function announceRun(
  id: ULID,
  projectId: ULID,
  broadcast: RunBroadcast,
): void {
  const row = workflowRunsV2Repo.getRun(id);
  if (!row) return;
  broadcast(buildDelta(row, projectId));
}

// ---------------------------------------------------------------------------
// Announcing write functions — the ONLY paths that mutate workflow_runs_v2.
// ---------------------------------------------------------------------------

/** Announce an already-created run (call right after createRun + markStarted). */
export function announceRunCreated(
  run: WorkflowRunV2Record,
  projectId: ULID,
  broadcast: RunBroadcast,
): void {
  broadcast(buildDelta(run, projectId));
}

/** setDagState + announce. */
export function writeDagState(
  id: ULID,
  dagState: WorkflowV2.WorkflowDagState,
  projectId: ULID,
  broadcast: RunBroadcast,
): void {
  workflowRunsV2Repo.setDagState(id, dagState);
  announceRun(id, projectId, broadcast);
}

/** setStatus + announce. */
export function writeRunStatus(
  id: ULID,
  status: WorkflowV2.WorkflowRunStatus,
  opts: { lastReason?: string | null },
  projectId: ULID,
  broadcast: RunBroadcast,
): void {
  workflowRunsV2Repo.setStatus(id, status, opts);
  announceRun(id, projectId, broadcast);
}

/** setDagState + setStatus + single announce (used by persist()). */
export function writeDagAndStatus(
  id: ULID,
  dagState: WorkflowV2.WorkflowDagState,
  status: WorkflowV2.WorkflowRunStatus,
  opts: { lastReason?: string },
  projectId: ULID,
  broadcast: RunBroadcast,
): void {
  workflowRunsV2Repo.setDagState(id, dagState);
  workflowRunsV2Repo.setStatus(id, status, opts);
  announceRun(id, projectId, broadcast);
}
