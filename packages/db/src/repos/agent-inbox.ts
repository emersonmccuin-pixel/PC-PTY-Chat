// Section 18.2 — Agent inbox + delivery audit. Durability layer of the
// hybrid transport: every agent → orchestrator event lands here as a row
// before any best-effort channel push. Drained by two paths:
//   1. Auto-flush on bridge registration / live channel push (18.3) →
//      `driver = 'autonomous'`.
//   2. UserPromptSubmit hook prepend (18.4) → `driver = 'user-prompt'`.
//
// Status flip + audit driver/hook fields update happen in one transaction
// so observers never see a delivered inbox row without its audit partner.

import { and, asc, eq } from 'drizzle-orm';

import type {
  AgentDeliveryAuditRow,
  AgentDeliveryDriver,
  AgentInboxEventKind,
  AgentInboxRow,
  ULID,
} from '@pc/domain';

import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { agentDeliveryAudit, agentInbox } from '../schema.ts';

export interface EnqueueInboxRowInput {
  projectId: ULID;
  recipientSessionId: string;
  eventKind: AgentInboxEventKind;
  payloadBody: string;
  now: number;
}

/** Writes the inbox row + a stub audit row in one transaction. Audit row is
 *  created up front so `recordChannelPushAttempt` is a single UPDATE; the
 *  drain paths (`markInboxDelivered`) also UPDATE the same audit row. */
export function enqueueInboxRow(input: EnqueueInboxRowInput): AgentInboxRow {
  const db = getDb();
  const row: AgentInboxRow = {
    id: newId(),
    projectId: input.projectId,
    recipientSessionId: input.recipientSessionId,
    eventKind: input.eventKind,
    payloadBody: input.payloadBody,
    status: 'pending',
    createdAt: input.now,
    deliveredAt: null,
  };
  db.transaction((tx) => {
    tx.insert(agentInbox).values(row).run();
    tx.insert(agentDeliveryAudit)
      .values({
        id: newId(),
        inboxId: row.id,
        channelPushAttemptedAt: null,
        channelPushSucceeded: null,
        hookDrainedAt: null,
        driver: 'unknown',
      })
      .run();
  });
  return row;
}

/** Pending rows for a recipient orchestrator session, oldest first. Used by
 *  both drain paths. */
export function listPendingForSession(recipientSessionId: string): AgentInboxRow[] {
  return getDb()
    .select()
    .from(agentInbox)
    .where(
      and(
        eq(agentInbox.recipientSessionId, recipientSessionId),
        eq(agentInbox.status, 'pending'),
      ),
    )
    .orderBy(asc(agentInbox.createdAt))
    .all();
}

/** Diagnostics / 18.9 validation pass. */
export function getInboxRow(id: ULID): AgentInboxRow | null {
  const row = getDb().select().from(agentInbox).where(eq(agentInbox.id, id)).get();
  return row ?? null;
}

export interface RecordChannelPushAttemptInput {
  inboxId: ULID;
  attemptedAt: number;
  succeeded: boolean;
}

/** Records the channel push outcome on the audit row. Idempotent —
 *  if the channel push is retried (e.g. registrant churn during auto-flush),
 *  the latest attempt overwrites prior values. */
export function recordChannelPushAttempt(input: RecordChannelPushAttemptInput): void {
  getDb()
    .update(agentDeliveryAudit)
    .set({
      channelPushAttemptedAt: input.attemptedAt,
      channelPushSucceeded: input.succeeded,
    })
    .where(eq(agentDeliveryAudit.inboxId, input.inboxId))
    .run();
}

export interface MarkInboxDeliveredInput {
  inboxId: ULID;
  deliveredAt: number;
  driver: AgentDeliveryDriver;
  /** Only populated when `driver === 'user-prompt'` (the UserPromptSubmit
   *  hook drained the row). Null for autonomous deliveries. */
  hookDrainedAt?: number | null;
}

/** Atomic `pending → delivered` flip + audit field update in one transaction.
 *  Returns `true` if the row was flipped, `false` if it was already
 *  delivered (concurrent drain by the other path — second drain is a no-op
 *  by design). */
export function markInboxDelivered(input: MarkInboxDeliveredInput): boolean {
  const db = getDb();
  return db.transaction((tx) => {
    const res = tx
      .update(agentInbox)
      .set({ status: 'delivered', deliveredAt: input.deliveredAt })
      .where(and(eq(agentInbox.id, input.inboxId), eq(agentInbox.status, 'pending')))
      .run();
    if (res.changes === 0) return false;
    tx.update(agentDeliveryAudit)
      .set({
        driver: input.driver,
        hookDrainedAt: input.hookDrainedAt ?? null,
      })
      .where(eq(agentDeliveryAudit.inboxId, input.inboxId))
      .run();
    return true;
  });
}

/** Diagnostics / 18.9 validation pass — read the audit row for an inbox id. */
export function getAuditForInbox(inboxId: ULID): AgentDeliveryAuditRow | null {
  const row = getDb()
    .select()
    .from(agentDeliveryAudit)
    .where(eq(agentDeliveryAudit.inboxId, inboxId))
    .get();
  return row ?? null;
}
