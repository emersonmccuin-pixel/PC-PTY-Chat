// Section 25 — agent_inbox + agent_delivery_audit repo.
//
// Enqueue + listPending + markDelivered against the bare-named tables, with
// the slim audit contract (one audit row per successful delivery, written at
// flip time with definite driver + latency).
//
// Status flip + audit insert happen in one transaction so observers never see
// a delivered inbox row without its audit partner.

import { and, asc, eq } from 'drizzle-orm';

import type {
  AgentDeliveryAuditRow,
  AgentInboxDriver,
  AgentInboxEventKind,
  AgentInboxRow,
  ULID,
} from '@pc/domain';

import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { agentDeliveryAudit, agentInbox } from '../schema-agent-system.ts';

export interface EnqueueInboxRowInput {
  projectId: ULID;
  pcSessionId: string;
  kind: AgentInboxEventKind;
  body: string;
  now: number;
}

/** Insert one pending inbox row. No audit stub — audit is written only on
 *  successful delivery. Returns the freshly inserted row. */
export function enqueueInboxRow(input: EnqueueInboxRowInput): AgentInboxRow {
  const row: AgentInboxRow = {
    id: newId(),
    projectId: input.projectId,
    pcSessionId: input.pcSessionId,
    kind: input.kind,
    body: input.body,
    status: 'pending',
    driver: null,
    createdAt: input.now,
    deliveredAt: null,
  };
  getDb().insert(agentInbox).values(row).run();
  return row;
}

/** Pending rows for a recipient session, oldest first. Used by both the
 *  bridge-auto-flush path and the UserPromptSubmit hook drain. */
export function listPendingForSession(pcSessionId: string): AgentInboxRow[] {
  return getDb()
    .select()
    .from(agentInbox)
    .where(and(eq(agentInbox.pcSessionId, pcSessionId), eq(agentInbox.status, 'pending')))
    .orderBy(asc(agentInbox.createdAt))
    .all();
}

/** Single-row read for diagnostics + tests. */
export function getInboxRow(id: ULID): AgentInboxRow | null {
  const row = getDb().select().from(agentInbox).where(eq(agentInbox.id, id)).get();
  return row ?? null;
}

export interface MarkInboxDeliveredInput {
  inboxId: ULID;
  deliveredAt: number;
  driver: AgentInboxDriver;
}

/** Atomic `pending → delivered` flip + audit row insert in one transaction.
 *  Returns `true` if the row was flipped (i.e. THIS call delivered it),
 *  `false` if it was already delivered by a concurrent drain. Idempotent —
 *  second drain on the same row is a no-op + does NOT write a duplicate
 *  audit row. */
export function markInboxDelivered(input: MarkInboxDeliveredInput): boolean {
  const db = getDb();
  return db.transaction((tx) => {
    // Read first to compute latency without making the UPDATE conditional on
    // the read (atomicity comes from the WHERE status='pending' guard).
    const row = tx
      .select()
      .from(agentInbox)
      .where(eq(agentInbox.id, input.inboxId))
      .get();
    if (!row) return false;
    if (row.status !== 'pending') return false;

    const res = tx
      .update(agentInbox)
      .set({
        status: 'delivered',
        driver: input.driver,
        deliveredAt: input.deliveredAt,
      })
      .where(and(eq(agentInbox.id, input.inboxId), eq(agentInbox.status, 'pending')))
      .run();
    if (res.changes === 0) return false;

    const latencyMs = Math.max(0, input.deliveredAt - row.createdAt);
    tx.insert(agentDeliveryAudit)
      .values({
        id: newId(),
        inboxId: input.inboxId,
        driver: input.driver,
        deliveredAt: input.deliveredAt,
        latencyMs,
      })
      .run();
    return true;
  });
}

/** Single audit-row read for diagnostics. Multiple audit rows can in principle
 *  exist if a future retry path lands; returns the most recent. */
export function getAuditForInbox(inboxId: ULID): AgentDeliveryAuditRow | null {
  const row = getDb()
    .select()
    .from(agentDeliveryAudit)
    .where(eq(agentDeliveryAudit.inboxId, inboxId))
    .get();
  return row ?? null;
}
