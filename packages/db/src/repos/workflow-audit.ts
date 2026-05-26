// Section 19.16 — Workflow audit-log writes + reads. Mirror of pod-audit.ts.
//
// Every workflow mutation in repos/workflows.ts lands an `workflow_audit` row
// in the SAME transaction as the mutation itself. Powers the future History
// tab on the workflow detail pane (see workflow-page-rebuild.md).
//
// Pure value builder pattern (same reason as pod-audit.ts): drizzle's `tx`
// type isn't assignable to `DB`, so the mutator owns the tx-scoped insert and
// this helper just shapes the row.
//
// Restore is intentionally NOT audited — workflow goes from `deleted_at != NULL`
// to `deleted_at = NULL`, which the row state already reflects. Matches the
// agents pattern. If a `'restored'` event ever needs first-class visibility
// it's already in the WorkflowAuditField enum.

import { and, desc, eq, lt } from 'drizzle-orm';
import type {
  PodAuditActor,
  ULID,
  WorkflowAuditField,
  WorkflowAuditRow,
} from '@pc/domain';
import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { workflowAudit } from '../schema.ts';

/** Caller-supplied actor + optional reason + optional change-set group. */
export interface WorkflowAuditInput {
  actor: PodAuditActor;
  reason?: string | null;
  changeSetId?: ULID | null;
}

export interface BuildWorkflowAuditRowInput {
  workflowId: ULID;
  field: WorkflowAuditField;
  fieldRef?: string | null;
  priorValue?: string | null;
  newValue?: string | null;
  audit: WorkflowAuditInput;
}

export interface WorkflowAuditRowValues {
  id: ULID;
  workflowId: ULID;
  changeSetId: ULID | null;
  actor: PodAuditActor;
  field: WorkflowAuditField;
  fieldRef: string | null;
  priorValue: string | null;
  newValue: string | null;
  reason: string | null;
  createdAt: number;
}

export function buildWorkflowAuditRow(
  input: BuildWorkflowAuditRowInput,
  now: number,
): WorkflowAuditRowValues {
  return {
    id: newId() as ULID,
    workflowId: input.workflowId,
    changeSetId: input.audit.changeSetId ?? null,
    actor: input.audit.actor,
    field: input.field,
    fieldRef: input.fieldRef ?? null,
    priorValue: input.priorValue ?? null,
    newValue: input.newValue ?? null,
    reason: input.audit.reason ?? null,
    createdAt: now,
  };
}

export interface ListWorkflowAuditOptions {
  workflowId: ULID;
  limit?: number;
  beforeCreatedAt?: number;
  actor?: PodAuditActor;
  field?: WorkflowAuditField;
}

export function listWorkflowAudit(opts: ListWorkflowAuditOptions): WorkflowAuditRow[] {
  const conditions = [eq(workflowAudit.workflowId, opts.workflowId)];
  if (opts.beforeCreatedAt !== undefined) {
    conditions.push(lt(workflowAudit.createdAt, opts.beforeCreatedAt));
  }
  if (opts.actor !== undefined) conditions.push(eq(workflowAudit.actor, opts.actor));
  if (opts.field !== undefined) conditions.push(eq(workflowAudit.field, opts.field));

  const limit = opts.limit ?? 100;
  const rows = getDb()
    .select()
    .from(workflowAudit)
    .where(and(...conditions))
    .orderBy(desc(workflowAudit.createdAt), desc(workflowAudit.id))
    .limit(limit)
    .all();

  return rows.map(rowToAudit);
}

function rowToAudit(row: typeof workflowAudit.$inferSelect): WorkflowAuditRow {
  return {
    id: row.id as ULID,
    workflowId: row.workflowId,
    changeSetId: (row.changeSetId ?? null) as ULID | null,
    actor: row.actor,
    field: row.field,
    fieldRef: row.fieldRef ?? null,
    priorValue: row.priorValue ?? null,
    newValue: row.newValue ?? null,
    reason: row.reason ?? null,
    createdAt: row.createdAt,
  };
}
