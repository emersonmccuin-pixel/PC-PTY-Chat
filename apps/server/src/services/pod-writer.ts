// UI Spine step 3 — announcing write-door for agents (pods).
//
// Every mutation of an agents row MUST go through getAgentById + broadcast
// immediately after. The door: (1) reads back the full row (including the
// bumped rev), (2) broadcasts a versioned full-snapshot WS delta.
//
// Pods are global (no project scope on the WS); consumers filter by scope /
// projectId. The broadcast function here is the global broadcastAll variant.

import type { ULID, PodAgentRow } from '@pc/domain';
import { getAgentById } from '@pc/db';

export type PodBroadcast = (event: unknown) => void;

export interface PodChangedEnvelope {
  type: 'pod-changed';
  change: 'created' | 'updated' | 'deleted';
  pod: PodAgentRow;
}

export interface PodDeletedEnvelope {
  type: 'pod-changed';
  change: 'deleted';
  podId: ULID;
  name: string;
}

function buildSnapshot(pod: PodAgentRow): PodChangedEnvelope {
  return { type: 'pod-changed', change: 'updated', pod };
}

/** Read back the current pod row and broadcast a versioned snapshot. No-ops if
 *  the row is gone. Pass `change: 'created'` for new rows. */
export function announcePod(
  id: ULID,
  broadcast: PodBroadcast,
  change: 'created' | 'updated' = 'updated',
): void {
  const pod = getAgentById(id);
  if (!pod) return;
  broadcast({ ...buildSnapshot(pod), change });
}

/** Announce a pod that was just soft-deleted (not readable via getAgentById). */
export function announcePodDeleted(
  podId: ULID,
  name: string,
  broadcast: PodBroadcast,
): void {
  const envelope: PodDeletedEnvelope = { type: 'pod-changed', change: 'deleted', podId, name };
  broadcast(envelope);
}
