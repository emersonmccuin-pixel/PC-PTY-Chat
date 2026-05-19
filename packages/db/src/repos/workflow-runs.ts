import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import type {
  NodeOutput,
  ULID,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowRunTrigger,
} from '@pc/domain';
import { getDb } from '../connection.ts';
import { workflowRuns } from '../schema.ts';

interface WorkflowRunRow {
  id: ULID;
  workflowId: string;
  workflowName: string;
  projectId: ULID;
  workItemId: ULID | null;
  parentRunId: ULID | null;
  parentNodeId: string | null;
  stageId: string | null;
  trigger: WorkflowRunTrigger;
  triggeredBySessionId: ULID | null;
  status: WorkflowRunStatus;
  workflowYamlSnapshot: string;
  worktreePath: string | null;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  nodeOutputs: Record<string, NodeOutput>;
  metadata: Record<string, unknown>;
  lastReason: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  lastActivityAt: number | null;
}

/** Map row → existing v2 WorkflowRun domain type (rig shape, ISO timestamps).
 *  The runtime constructs the rig-shape object; repos convert at read time. */
function toDomain(row: WorkflowRunRow): WorkflowRun {
  const run: WorkflowRun = {
    id: row.id,
    workflowId: row.workflowId,
    workflowYamlSnapshot: row.workflowYamlSnapshot,
    status: row.status,
    startedAt: row.startedAt != null ? new Date(row.startedAt).toISOString() : new Date(row.createdAt).toISOString(),
    worktreePath: row.worktreePath,
    nodeOutputs: row.nodeOutputs,
  };
  if (row.endedAt != null) run.completedAt = new Date(row.endedAt).toISOString();
  if (row.workItemId) run.workItemId = row.workItemId;
  if (row.stageId) run.stageId = row.stageId;
  if (row.parentRunId) run.parentRunId = row.parentRunId;
  if (row.parentNodeId) run.parentNodeId = row.parentNodeId;
  if (Object.keys(row.inputs).length > 0) run.inputs = row.inputs;
  if (Object.keys(row.outputs).length > 0) run.outputs = row.outputs;
  if (row.lastReason) run.lastReason = row.lastReason;
  if (Object.keys(row.metadata).length > 0) run.metadata = row.metadata;
  return run;
}

export interface CreateRunInput {
  id: ULID;
  workflowId: string;
  workflowName: string;
  projectId: ULID;
  workflowYamlSnapshot: string;
  trigger: WorkflowRunTrigger;
  status?: WorkflowRunStatus;
  workItemId?: ULID | null;
  stageId?: string | null;
  parentRunId?: ULID | null;
  parentNodeId?: string | null;
  triggeredBySessionId?: ULID | null;
  worktreePath?: string | null;
  inputs?: Record<string, unknown>;
  nodeOutputs?: Record<string, NodeOutput>;
  /** Section 4e.2. Free-form metadata captured at row creation. Used today
   *  for retry-from lineage (`reFiredFromRunId`, `reFiredFromNodeId`); open
   *  shape for future fire-paths. Stored as a JSON blob on the row. */
  metadata?: Record<string, unknown>;
}

export function createRun(input: CreateRunInput): WorkflowRun {
  const now = Date.now();
  const row: WorkflowRunRow = {
    id: input.id,
    workflowId: input.workflowId,
    workflowName: input.workflowName,
    projectId: input.projectId,
    workItemId: input.workItemId ?? null,
    parentRunId: input.parentRunId ?? null,
    parentNodeId: input.parentNodeId ?? null,
    stageId: input.stageId ?? null,
    trigger: input.trigger,
    triggeredBySessionId: input.triggeredBySessionId ?? null,
    status: input.status ?? 'pending',
    workflowYamlSnapshot: input.workflowYamlSnapshot,
    worktreePath: input.worktreePath ?? null,
    inputs: input.inputs ?? {},
    outputs: {},
    nodeOutputs: input.nodeOutputs ?? {},
    metadata: input.metadata ?? {},
    lastReason: null,
    createdAt: now,
    startedAt: null,
    endedAt: null,
    lastActivityAt: now,
  };
  getDb().insert(workflowRuns).values(row).run();
  return toDomain(row);
}

export function getRun(id: ULID): WorkflowRun | null {
  const row = getDb()
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, id))
    .get() as WorkflowRunRow | undefined;
  return row ? toDomain(row) : null;
}

export function listRuns(): WorkflowRun[] {
  const rows = getDb()
    .select()
    .from(workflowRuns)
    .orderBy(asc(workflowRuns.createdAt))
    .all() as WorkflowRunRow[];
  return rows.map(toDomain);
}

const TERMINAL: ReadonlySet<WorkflowRunStatus> = new Set(['complete', 'failed', 'cancelled']);

/** All runs not in a terminal state. */
export function listActiveRuns(): WorkflowRun[] {
  const rows = getDb()
    .select()
    .from(workflowRuns)
    .where(inArray(workflowRuns.status, ['pending', 'in-progress', 'paused']))
    .orderBy(asc(workflowRuns.createdAt))
    .all() as WorkflowRunRow[];
  return rows.map(toDomain);
}

export function listRunsByWorkItem(workItemId: ULID): WorkflowRun[] {
  const rows = getDb()
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.workItemId, workItemId))
    .orderBy(asc(workflowRuns.createdAt))
    .all() as WorkflowRunRow[];
  return rows.map(toDomain);
}

export function listRunsByProject(projectId: ULID): WorkflowRun[] {
  const rows = getDb()
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.projectId, projectId))
    .orderBy(asc(workflowRuns.createdAt))
    .all() as WorkflowRunRow[];
  return rows.map(toDomain);
}

/** Section 4e.1. Read one run by id and confirm it belongs to `projectId`.
 *  Returns null when the row doesn't exist OR the projectId doesn't match —
 *  both surface as 404 from the HTTP layer (no info leak about cross-project
 *  ids). */
export function getRunForProject(id: ULID, projectId: ULID): WorkflowRun | null {
  const row = getDb()
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.id, id), eq(workflowRuns.projectId, projectId)))
    .get() as WorkflowRunRow | undefined;
  return row ? toDomain(row) : null;
}

/** Persist a full WorkflowRun back to the row. Used by tick to capture all
 *  changes (status, nodeOutputs, lastReason, timestamps) in one write. */
export function persistRun(run: WorkflowRun): void {
  const startedAtMs = run.startedAt ? Date.parse(run.startedAt) : null;
  const endedAtMs = run.completedAt ? Date.parse(run.completedAt) : null;
  const patch: Partial<WorkflowRunRow> = {
    status: run.status,
    nodeOutputs: run.nodeOutputs,
    outputs: run.outputs ?? {},
    worktreePath: run.worktreePath,
    lastReason: run.lastReason ?? null,
    metadata: run.metadata ?? {},
    startedAt: startedAtMs,
    endedAt: endedAtMs,
    lastActivityAt: Date.now(),
  };
  if (TERMINAL.has(run.status) && endedAtMs == null) {
    patch.endedAt = Date.now();
  }
  getDb().update(workflowRuns).set(patch).where(eq(workflowRuns.id, run.id as ULID)).run();
}

/** Get the most recent in-progress run for a work item (used by the safety net). */
export function getActiveRunForWorkItem(workItemId: ULID): WorkflowRun | null {
  const row = getDb()
    .select()
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workItemId, workItemId),
        inArray(workflowRuns.status, ['pending', 'in-progress', 'paused']),
        isNotNull(workflowRuns.id),
      ),
    )
    .orderBy(asc(workflowRuns.createdAt))
    .get() as WorkflowRunRow | undefined;
  return row ? toDomain(row) : null;
}
