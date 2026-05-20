// Section 17a.4 — Pod audit-log writes + reads.
//
// Every pod mutation lands an `agent_audit` row in the SAME transaction as
// the mutation itself. The audit log powers the History tab (17d) — per-row
// + per-changeset revert, filter by actor / field, diff display. Always-on
// in v1; retention = forever (rows are tiny, prune if pathological).
//
// Architecture:
//   - `buildAuditRow(input, now)` is a pure value builder. Returns the row
//     shape ready for `.values()`. Mutators in `pods.ts` build the row, then
//     wrap mutation + audit insert in `getDb().transaction((tx) => ...)`.
//   - `listAgentAudit(opts)` is the read path for the History tab. Newest-
//     first with optional pagination cursor + actor / field filters.
//
// Why a value builder (not a write helper that takes tx)? Drizzle's
// transaction callback `tx` is typed as `SQLiteTransaction`, NOT `DB`. A
// single helper that works in both contexts would need a wider type. Value
// builder dodges the issue — the mutator owns the tx-scoped insert.
//
// Secrets: prior_value + new_value stay NULL. Field_ref carries the env var
// name so the History tab can still render "user added the X env var" or
// "orchestrator removed the Y env var" without ever logging the value.
//
// Restore (un-soft-delete) is intentionally NOT audited in v1 — agent goes
// from `deleted_at != NULL` to `deleted_at = NULL`, which is already visible
// in the agent row state. The History tab's revert button for the original
// `'deleted'` row is the canonical path. If a "restored" event ever needs
// first-class visibility, add `'restored'` to PodAuditField — additive,
// non-breaking, no schema migration.

import { and, desc, eq, lt } from 'drizzle-orm';
import type {
  PodAuditActor,
  PodAuditField,
  PodAuditRow,
  ULID,
} from '@pc/domain';
import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { agentAudit } from '../schema.ts';

/** Caller-supplied actor + optional reason + optional change-set group. Every
 *  mutating pod call accepts one of these. */
export interface AuditInput {
  actor: PodAuditActor;
  /** Optional one-line "why" surfaced in the History tab. */
  reason?: string | null;
  /** Group with sibling audit rows for the same logical change. Null = solo
   *  edit. Caller mints the ULID before the transaction starts (so all rows
   *  in a multi-statement tx share the same id). */
  changeSetId?: ULID | null;
}

export interface BuildAuditRowInput {
  agentId: ULID;
  field: PodAuditField;
  /** Disambiguator for list-shaped fields (knowledge row id, secret env-var
   *  name, mcp server name). Null for scalar fields. */
  fieldRef?: string | null;
  /** Pre-edit value. Caller serialises (JSON.stringify for complex shapes).
   *  Always Null for `secret` rows. */
  priorValue?: string | null;
  /** Post-edit value. Same serialisation rules. */
  newValue?: string | null;
  audit: AuditInput;
}

/** Row shape ready for `tx.insert(agentAudit).values(...)`. The mutator owns
 *  the tx-scoped insert; this helper just builds the values. */
export interface AuditRowValues {
  id: ULID;
  agentId: ULID;
  changeSetId: ULID | null;
  actor: PodAuditActor;
  field: PodAuditField;
  fieldRef: string | null;
  priorValue: string | null;
  newValue: string | null;
  reason: string | null;
  createdAt: number;
}

export function buildAuditRow(input: BuildAuditRowInput, now: number): AuditRowValues {
  return {
    id: newId() as ULID,
    agentId: input.agentId,
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

export interface ListAgentAuditOptions {
  agentId: ULID;
  /** Newest-first cap. Default 100. */
  limit?: number;
  /** Pagination cursor — return rows with `createdAt < this`. Pair with the
   *  last row's createdAt for backward pagination. */
  beforeCreatedAt?: number;
  /** Filter to a specific actor. */
  actor?: PodAuditActor;
  /** Filter to a specific field. */
  field?: PodAuditField;
}

/** Read newest-first audit rows for an agent. The History tab uses this; the
 *  client groups by `changeSetId` when rendering multi-field edits as one card. */
export function listAgentAudit(opts: ListAgentAuditOptions): PodAuditRow[] {
  const conditions = [eq(agentAudit.agentId, opts.agentId)];
  if (opts.beforeCreatedAt !== undefined) {
    conditions.push(lt(agentAudit.createdAt, opts.beforeCreatedAt));
  }
  if (opts.actor !== undefined) conditions.push(eq(agentAudit.actor, opts.actor));
  if (opts.field !== undefined) conditions.push(eq(agentAudit.field, opts.field));

  const limit = opts.limit ?? 100;
  const rows = getDb()
    .select()
    .from(agentAudit)
    .where(and(...conditions))
    .orderBy(desc(agentAudit.createdAt), desc(agentAudit.id))
    .limit(limit)
    .all();

  return rows.map(rowToAudit);
}

function rowToAudit(row: typeof agentAudit.$inferSelect): PodAuditRow {
  return {
    id: row.id as ULID,
    agentId: row.agentId as ULID,
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
