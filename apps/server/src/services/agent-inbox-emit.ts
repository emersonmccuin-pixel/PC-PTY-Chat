// Section 18.3 — Hybrid emit primitive. Bridges the inbox repo (durability
// layer of the hybrid transport) and the channel-server (best-effort wake-up
// layer). Every agent → orchestrator event goes through here: row written
// first, channel push attempted second, audit updated either way. If the
// push lands on a live registrant, the row immediately flips to delivered
// (driver = 'autonomous'). If it doesn't, the row stays pending until the
// UserPromptSubmit hook (18.4) drains it on the next user prompt (driver =
// 'user-prompt').
//
// `PC_DELIVERY_TRANSPORT` env flag is an emergency kill switch (locked in
// 18.3 per the buildout doc's open-question list):
//   - unset / 'hybrid'  — write inbox + best-effort push (default)
//   - 'inbox-only'      — skip channel push (force user-prompt drain — useful
//                         for isolating autonomy bugs from hook-drain bugs)
//   - 'channel-only'    — skip inbox writes (raw emit, no durability — pure
//                         pre-18.3 behaviour; emergency revert path)

import {
  enqueueInboxRow,
  listPendingForSession,
  markInboxDelivered,
  recordChannelPushAttempt,
} from '@pc/db';
import type { AgentInboxEventKind, ULID } from '@pc/domain';

import type { ChannelServer } from './channel-server.ts';

export type DeliveryTransportMode = 'hybrid' | 'inbox-only' | 'channel-only';

export function readTransportMode(): DeliveryTransportMode {
  const raw = (process.env.PC_DELIVERY_TRANSPORT ?? '').trim().toLowerCase();
  if (raw === 'inbox-only' || raw === 'channel-only') return raw;
  return 'hybrid';
}

export interface EnqueueAndPushInput {
  projectId: ULID;
  recipientSessionId: string;
  eventKind: AgentInboxEventKind;
  slug: string;
  source: string;
  body: string;
  sender?: string;
}

export interface EnqueueAndPushResult {
  /** ULID of the inbox row written, or null when transport='channel-only'
   *  bypassed the inbox (diagnosis-only mode). */
  inboxId: ULID | null;
  /** Whether the channel push landed on a live registrant. False when
   *  transport='inbox-only', no registrant matched, or the WS was closed. */
  channelDelivered: boolean;
}

/** Single primitive every agent → orchestrator emit point uses. Writes the
 *  inbox row + attempts the channel push + records the audit outcome. Returns
 *  immediately; never throws on push failure (caller doesn't need to retry —
 *  the user-prompt drain catches the row on next prompt). */
export function enqueueAndPush(
  channelServer: ChannelServer,
  input: EnqueueAndPushInput,
): EnqueueAndPushResult {
  const transport = readTransportMode();

  if (transport === 'channel-only') {
    const delivered = channelServer.emitToSession({
      projectId: input.projectId,
      recipientSessionId: input.recipientSessionId,
      slug: input.slug,
      source: input.source,
      body: input.body,
      sender: input.sender,
    });
    return { inboxId: null, channelDelivered: delivered };
  }

  const row = enqueueInboxRow({
    projectId: input.projectId,
    recipientSessionId: input.recipientSessionId,
    eventKind: input.eventKind,
    payloadBody: input.body,
    now: Date.now(),
  });

  if (transport === 'inbox-only') {
    return { inboxId: row.id, channelDelivered: false };
  }

  // Hybrid: best-effort push, audit, flip row when delivered.
  const attemptedAt = Date.now();
  const delivered = channelServer.emitToSession({
    projectId: input.projectId,
    recipientSessionId: input.recipientSessionId,
    slug: input.slug,
    source: input.source,
    body: input.body,
    sender: input.sender,
  });
  recordChannelPushAttempt({
    inboxId: row.id,
    attemptedAt,
    succeeded: delivered,
  });
  if (delivered) {
    markInboxDelivered({
      inboxId: row.id,
      deliveredAt: Date.now(),
      driver: 'autonomous',
    });
  }
  return { inboxId: row.id, channelDelivered: delivered };
}

export interface DrainResult {
  /** Number of inbox rows whose `pending → delivered` flip succeeded under
   *  the auto-flush. Excludes rows already delivered by a concurrent drain
   *  (idempotent guard in `markInboxDelivered`). */
  drained: number;
  /** Total pending rows considered. `drained + (attempted - drained)` =
   *  attempted; the delta is rows where push failed OR a concurrent drain
   *  already flipped them. */
  attempted: number;
}

/** Auto-flush all pending inbox rows for a recipient session. Called from
 *  channel-server's `onRegister` hook when a fresh bridge connects (post-
 *  restart, post-respawn) so the orchestrator catches up autonomously
 *  without waiting on a user prompt.
 *
 *  Decision (open question from buildout doc): drain ALL pending rows for
 *  the session, not only those created after registration. A fresh bridge
 *  generally implies the prior CC for this sessionId is gone — anything
 *  still pending for this session is by definition undelivered. */
export function drainPendingForSession(
  channelServer: ChannelServer,
  projectId: ULID,
  recipientSessionId: string,
  slug: string,
): DrainResult {
  const transport = readTransportMode();
  if (transport === 'channel-only') {
    // No inbox writes in channel-only mode — nothing to drain.
    return { drained: 0, attempted: 0 };
  }

  const pending = listPendingForSession(recipientSessionId);
  let drained = 0;
  let attempted = 0;
  for (const row of pending) {
    // Defensive — sessionId is globally unique, but listPendingForSession
    // doesn't filter by project. Skip foreign-project rows in case a stale
    // sessionId ever recurs across projects.
    if (row.projectId !== projectId) continue;
    attempted += 1;
    const attemptedAt = Date.now();
    const delivered = channelServer.emitToSession({
      projectId,
      recipientSessionId,
      slug,
      source: 'agent',
      body: row.payloadBody,
      sender: 'pc',
    });
    recordChannelPushAttempt({
      inboxId: row.id,
      attemptedAt,
      succeeded: delivered,
    });
    if (delivered) {
      const flipped = markInboxDelivered({
        inboxId: row.id,
        deliveredAt: Date.now(),
        driver: 'autonomous',
      });
      if (flipped) drained += 1;
    }
  }
  return { drained, attempted };
}
