// Out-of-process agent host — server-side client / multiplexer.
//
// Owns the single control channel to the host and fans it out across many
// RemoteSpawns. Routes key-addressed lifecycle events to the right spawn, and
// correlates reqId-addressed replies (sendResult / rosterResult) back to their
// awaiting callers. The WS binding (apps/server) constructs one HostClient per
// host connection; tests wire an in-memory loopback channel.

import { randomUUID } from 'node:crypto';

import type { LowLevelSpawnInput } from '../low-level-spawn.ts';
import type { SendResult } from '../send-protocol.ts';
import {
  type HostToServerMsg,
  type MessageChannel,
  type RosterEntry,
  type ServerToHostMsg,
} from './protocol.ts';
import { RemoteSpawn, type RemoteSpawnHost } from './remote-spawn.ts';

export class HostClient implements RemoteSpawnHost {
  private readonly channel: MessageChannel<ServerToHostMsg, HostToServerMsg>;
  private readonly unsubscribe: () => void;
  private readonly byKey = new Map<string, RemoteSpawn>();
  private readonly pendingSends = new Map<string, (result: SendResult) => void>();
  private readonly pendingRosters = new Map<string, (sessions: RosterEntry[]) => void>();
  private disconnected = false;

  constructor(channel: MessageChannel<ServerToHostMsg, HostToServerMsg>) {
    this.channel = channel;
    this.unsubscribe = channel.subscribe((msg) => this.onInbound(msg));
  }

  /** Construct a RemoteSpawn bound to this client. Caller then `.start()`s it
   *  (the AgentRun lifecycle does this), exactly like the in-process factory. */
  createSpawn(input: LowLevelSpawnInput): RemoteSpawn {
    const spawn = new RemoteSpawn(input, this);
    this.byKey.set(spawn.key, spawn);
    return spawn;
  }

  /** Ask the host for its live roster (phase-2 reattach uses this at boot). */
  roster(): Promise<RosterEntry[]> {
    const reqId = randomUUID();
    return new Promise<RosterEntry[]>((resolve, reject) => {
      if (this.disconnected) {
        reject(new Error('HostClient: disconnected'));
        return;
      }
      this.pendingRosters.set(reqId, resolve);
      this.channel.send({ t: 'roster', reqId });
    });
  }

  /** Tear down: drop the subscription and fail every spawn + pending reply.
   *  The WS binding calls this on socket close. */
  shutdown(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.unsubscribe();
    for (const resolve of this.pendingSends.values()) resolve('exited');
    this.pendingSends.clear();
    this.pendingRosters.clear();
    for (const spawn of [...this.byKey.values()]) spawn.handleDisconnect();
    this.byKey.clear();
  }

  // ── RemoteSpawnHost ──────────────────────────────────────────────────

  sendToHost(msg: ServerToHostMsg): void {
    if (this.disconnected) return;
    this.channel.send(msg);
  }

  awaitSendResult(reqId: string): Promise<SendResult> {
    return new Promise<SendResult>((resolve) => {
      if (this.disconnected) {
        resolve('exited');
        return;
      }
      this.pendingSends.set(reqId, resolve);
    });
  }

  unregister(key: string): void {
    this.byKey.delete(key);
  }

  // ── inbound routing ──────────────────────────────────────────────────

  private onInbound(msg: HostToServerMsg): void {
    switch (msg.t) {
      case 'sendResult': {
        const resolve = this.pendingSends.get(msg.reqId);
        if (resolve) {
          this.pendingSends.delete(msg.reqId);
          resolve(msg.result);
        }
        return;
      }
      case 'rosterResult': {
        const resolve = this.pendingRosters.get(msg.reqId);
        if (resolve) {
          this.pendingRosters.delete(msg.reqId);
          resolve(msg.sessions);
        }
        return;
      }
      case 'error': {
        // reqId-correlated errors fail the matching pending reply; otherwise
        // it's a spawn-level error — surface it as a disconnect-style exit so
        // the lifecycle doesn't hang.
        if (msg.reqId && this.pendingSends.has(msg.reqId)) {
          this.pendingSends.get(msg.reqId)!('exited');
          this.pendingSends.delete(msg.reqId);
        }
        if (msg.key) this.byKey.get(msg.key)?.handleHostMsg({ t: 'exit', key: msg.key, code: null, signal: null });
        return;
      }
      case 'attached':
      case 'gone':
        // Phase-2 reattach replies — routed to the spawn by key when that path
        // lands. No-op in phase 1.
        return;
      default: {
        // Key-addressed lifecycle event → route to the owning spawn.
        const key = (msg as { key?: string }).key;
        if (key) this.byKey.get(key)?.handleHostMsg(msg);
        return;
      }
    }
  }
}
