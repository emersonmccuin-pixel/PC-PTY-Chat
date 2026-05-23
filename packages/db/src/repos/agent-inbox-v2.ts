// Section 25 Session 7 — agent_inbox_v2 + agent_delivery_audit_v2 repo.
//
// Lives alongside v1's `agent-inbox.ts` during the parallel-build phase. Same
// shape as v1 (enqueue + listPending + markDelivered) but against the v2
// tables and with the slimmer audit contract (one audit row per successful
// delivery, written at flip time with definite driver + latency).
//
// Status flip + audit insert happen in one transaction so observers never see
// a delivered inbox row without its audit partner.

import { and, asc, eq } from 'drizzle-orm';

import type {
  AgentDeliveryAuditRowV2,
  AgentInboxDriverV2,
  AgentInboxEventKindV2,
  AgentInboxRowV2,
  ULID,
} from '@pc/domain';

import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { agentDeliveryAudit, agentInbox } from '../schema-v2.ts';

export interface EnqueueInboxRowV2Input {
  projectId: ULID;
  pcSessionId: string;
  kind: AgentInboxEventKindV2;
  body: string;
  now: number;
}

/** Insert one pending inbox row. No audit stub — audit is written only on
 *  successful delivery. Returns the freshly inserted row. */
export function enqueueInboxRowV2(input: EnqueueInboxRowV2Input): AgentInboxRowV2 {
  const row: AgentInboxRowV2 = {
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
export function listPendingForSessionV2(pcSessionId: string): AgentInboxRowV2[] {
  return getDb()
    .select()
    .from(agentInbox)
    .where(and(eq(agentInbox.pcSessionId, pcSessionId), eq(agentInbox.status, 'pending')))
    .orderBy(asc(agentInbox.createdAt))
    .all();
}

/** Single-row read for diagnostics + tests. */
export function getInboxRowV2(id: ULID): AgentInboxRowV2 | null {
  const row = getDb().select().from(agentInbox).where(eq(agentInbox.id, id)).get();
  return row ?? null;
}

export interface MarkInboxDeliveredV2Input {
  inboxId: ULID;
  deliveredAt: number;
  driver: AgentInboxDriverV2;
}

/** Atomic `pending → delivered` flip + audit row insert in one transaction.
 *  Returns `true` if the row was flipped (i.e. THIS call delivered it),
 *  `false` if it was already delivered by a concurrent drain. Idempotent —
 *  second drain on the same row is a no-op + does NOT write a duplicate
 *  audit row. */
export function markInboxDeliveredV2(input: MarkInboxDeliveredV2Input): boolean {
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
export function getAuditForInboxV2(inboxId: ULID): AgentDeliveryAuditRowV2 | null {
  const row = getDb()
    .select()
    .from(agentDeliveryAudit)
    .where(eq(agentDeliveryAudit.inboxId, inboxId))
    .get();
  return row ?? null;
}
