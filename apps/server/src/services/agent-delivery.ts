// Section 25 — hybrid delivery primitive.
//
// Durable inbox write first + best-effort channel push + auto-flush on bridge
// registration. Audit row is written ONLY on successful delivery (one row per
// flip, not one row per enqueue) — the inbox-row `status` field already tells
// us whether anything ever delivered, so a stub-at-enqueue audit row is noise
// without diagnostic value.
//
// - Driver values are `'channel' | 'user-prompt'` (no `'autonomous'`,
//   no `'unknown'`). Matches design §5.4's identifier set.
//
// - Renamed `recipientSessionId` → `pcSessionId` to match the identifier
//   glossary in design §1.
//
// This file is NOT wired into channel-server yet — Session 9's cutover
// swaps the v1 onRegister callback over to `drainPendingForSession`.
// During Sessions 7–8 it's reachable for tests + future MCP tool work
// (Session 8 pause/resume) but the production transport path still
// flows through v1.
//
// Emergency kill switch: `PC_DELIVERY_TRANSPORT` env var. Same values
// as v1 (hybrid | inbox-only | channel-only). Identical semantics.

import {
  enqueueInboxRow,
  listPendingForSession,
  markInboxDelivered,
} from '@pc/db';
import type { AgentInboxEventKind, AgentInboxRow, ULID } from '@pc/domain';

import type { ChannelServer } from './channel-server.ts';

export type DeliveryTransportMode = 'hybrid' | 'inbox-only' | 'channel-only';

export function readTransportMode(): DeliveryTransportMode {
  const raw = (process.env.PC_DELIVERY_TRANSPORT ?? '').trim().toLowerCase();
  if (raw === 'inbox-only' || raw === 'channel-only') return raw;
  return 'hybrid';
}

export interface EnqueueAndPushInput {
  projectId: ULID;
  pcSessionId: string;
  kind: AgentInboxEventKind;
  slug: string;
  source: string;
  body: string;
  sender?: string;
}

export interface EnqueueAndPushResult {
  /** ULID of the inbox row, or null when transport='channel-only' bypassed
   *  the inbox entirely. */
  inboxId: ULID | null;
  /** Whether the channel push landed on a live registrant. False when
   *  transport='inbox-only', no registrant matched, or the WS was closed. */
  channelDelivered: boolean;
}

/** Single primitive every agent → recipient emit point uses. Writes the
 *  inbox row + attempts the channel push + writes an audit row on success.
 *  Never throws on push failure — the caller doesn't need to retry; the
 *  user-prompt drain catches it on the next prompt.
 *
 *  Transport modes:
 *   - 'hybrid'        : durable + best-effort push (default)
 *   - 'inbox-only'    : skip channel push (force user-prompt drain path)
 *   - 'channel-only'  : skip inbox writes (pre-Section 18 behavior; emergency
 *                       revert path — durability is sacrificed)
 */
export function enqueueAndPush(
  channelServer: ChannelServer,
  input: EnqueueAndPushInput,
): EnqueueAndPushResult {
  const transport = readTransportMode();

  if (transport === 'channel-only') {
    const delivered = channelServer.emitToSession({
      projectId: input.projectId,
      recipientSessionId: input.pcSessionId,
      slug: input.slug,
      source: input.source,
      body: input.body,
      sender: input.sender,
    });
    return { inboxId: null, channelDelivered: delivered };
  }

  const row = enqueueInboxRow({
    projectId: input.projectId,
    pcSessionId: input.pcSessionId,
    kind: input.kind,
    body: input.body,
    now: Date.now(),
  });

  if (transport === 'inbox-only') {
    return { inboxId: row.id, channelDelivered: false };
  }

  // Hybrid: best-effort push; flip row + write audit on success.
  const delivered = channelServer.emitToSession({
    projectId: input.projectId,
    recipientSessionId: input.pcSessionId,
    slug: input.slug,
    source: input.source,
    body: input.body,
    sender: input.sender,
  });
  if (delivered) {
    markInboxDelivered({
      inboxId: row.id,
      deliveredAt: Date.now(),
      driver: 'channel',
    });
  }
  return { inboxId: row.id, channelDelivered: delivered };
}

export interface DrainResult {
  /** Number of pending inbox rows whose `pending → delivered` flip succeeded
   *  under this drain. */
  drained: number;
  /** Total pending rows considered. `drained + (attempted - drained)` =
   *  attempted; the delta is rows where the channel push failed OR a
   *  concurrent drain already flipped them. */
  attempted: number;
}

/** Auto-flush all pending inbox rows for a recipient session. Called from
 *  channel-server's `onRegister` callback when a fresh bridge connects
 *  (post-restart / post-respawn) so the orchestrator catches up
 *  autonomously without waiting on a user prompt.
 *
 *  Same "drain ALL pending rows" semantics as v1: a fresh bridge generally
 *  means the prior CC for this session-id is gone, so anything still
 *  pending is by definition undelivered. */
export function drainPendingForSession(
  channelServer: ChannelServer,
  projectId: ULID,
  pcSessionId: string,
  slug: string,
): DrainResult {
  const transport = readTransportMode();
  if (transport === 'channel-only') {
    // No inbox writes in channel-only mode — nothing to drain.
    return { drained: 0, attempted: 0 };
  }

  const pending: AgentInboxRow[] = listPendingForSession(pcSessionId);
  let drained = 0;
  let attempted = 0;
  for (const row of pending) {
    // Defensive — pc_session_id is globally unique today, but listPending
    // doesn't filter by project. Skip foreign-project rows in case a stale
    // session-id ever recurs across projects.
    if (row.projectId !== projectId) continue;
    attempted += 1;
    const delivered = channelServer.emitToSession({
      projectId,
      recipientSessionId: pcSessionId,
      slug,
      source: 'agent',
      body: row.body,
      sender: 'pc',
    });
    if (delivered) {
      const flipped = markInboxDelivered({
        inboxId: row.id,
        deliveredAt: Date.now(),
        driver: 'channel',
      });
      if (flipped) drained += 1;
    }
  }
  return { drained, attempted };
}
