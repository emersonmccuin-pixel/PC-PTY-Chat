// Out-of-process agent host — core (transport-agnostic).
//
// Owns the node-pty / claude.exe children for every PTY the API server runs.
// Lives in its own long-lived process so a server crash/restart leaves agents
// alive, and a native node-pty crash (0xC0000374) isolates here instead of
// taking down the API/UI. See docs/out-of-process-agent-host-design.md.
//
// This module is the CORE only: it speaks the control protocol over an injected
// `send` callback + a `handle(msg)` entry point, with no socket/WS awareness.
// The WS binding (apps/server) wires a socket's data → handle() and send →
// socket.write. Unit tests wire an in-memory loopback instead.
//
// Content note: the host does NOT forward JSONL events. It spawns with
// `suppressJsonlTailer: true`; the server tails the canonical JSONL from disk
// itself, so reattach needs no replay.

import {
  LowLevelSpawn,
  type LowLevelSpawnInput,
  type SpawnState,
} from '../low-level-spawn.ts';
import type { SpawnLike } from '../agent-run.ts';
import type {
  HostToServerMsg,
  RosterEntry,
  ServerToHostMsg,
} from './protocol.ts';

/** A host-managed PTY. LowLevelSpawn satisfies this; `getPid` is host-only
 *  (roster/reattach) so it's an optional extension of the shared SpawnLike. */
export type HostSpawn = SpawnLike & { getPid?(): number | null };

export type HostSpawnFactory = (input: LowLevelSpawnInput) => HostSpawn;

const defaultSpawnFactory: HostSpawnFactory = (input) =>
  new LowLevelSpawn({ ...input, suppressJsonlTailer: true });

export interface AgentHostDeps {
  /** Outbound channel to the connected server. */
  send: (msg: HostToServerMsg) => void;
  /** Test seam. Production = LowLevelSpawn with the host tailer suppressed. */
  spawnFactory?: HostSpawnFactory;
}

interface Entry {
  spawn: HostSpawn;
  jsonlPath: string | null;
}

/**
 * The host's per-connection command processor. One AgentHost instance per
 * connected server client; the WS binding constructs one on connect and routes
 * that socket's frames through `handle`.
 *
 * NB phase 1: a single connected client at a time is assumed. Multi-client /
 * reconnect fan-out (so a restarted server reattaches to a host that may still
 * have the prior connection's listeners) is a phase-2/3 concern — `attach` +
 * `roster` are wired here so that work doesn't reshape the protocol.
 */
export class AgentHost {
  private readonly send: (msg: HostToServerMsg) => void;
  private readonly spawnFactory: HostSpawnFactory;
  private readonly entries = new Map<string, Entry>();

  constructor(deps: AgentHostDeps) {
    this.send = deps.send;
    this.spawnFactory = deps.spawnFactory ?? defaultSpawnFactory;
  }

  /** Process one inbound command from the server. Never throws — protocol
   *  errors are reported back as `{ t: 'error' }` so one bad frame can't tear
   *  the host down. */
  handle(msg: ServerToHostMsg): void {
    try {
      switch (msg.t) {
        case 'spawn':
          this.onSpawn(msg.key, msg.input);
          break;
        case 'attach':
          this.onAttach(msg.key);
          break;
        case 'send':
          void this.onSend(msg.key, msg.reqId, msg.body, msg.echoTimeoutMs);
          break;
        case 'writeRaw':
          this.entries.get(msg.key)?.spawn.writeRaw?.(msg.bytes);
          break;
        case 'interrupt':
          this.entries.get(msg.key)?.spawn.interrupt();
          break;
        case 'resize':
          this.entries.get(msg.key)?.spawn.resize?.(msg.cols, msg.rows);
          break;
        case 'kill':
          this.entries.get(msg.key)?.spawn.kill(msg.graceMs);
          break;
        case 'notifyHandshake':
          this.entries.get(msg.key)?.spawn.notifyMcpHandshake();
          break;
        case 'roster':
          this.onRoster(msg.reqId);
          break;
        default: {
          const _exhaustive: never = msg;
          void _exhaustive;
        }
      }
    } catch (err) {
      this.send({
        t: 'error',
        key: 'key' in msg ? (msg as { key?: string }).key : undefined,
        reqId: 'reqId' in msg ? (msg as { reqId?: string }).reqId : undefined,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Test/introspection — count of live PTYs. */
  size(): number {
    return this.entries.size;
  }

  // ── command handlers ─────────────────────────────────────────────────

  private onSpawn(key: string, input: LowLevelSpawnInput): void {
    if (this.entries.has(key)) {
      this.send({ t: 'error', key, message: `spawn: key ${key} already exists` });
      return;
    }
    const spawn = this.spawnFactory(input);
    const entry: Entry = { spawn, jsonlPath: null };
    this.entries.set(key, entry);

    spawn.on('state', (state: SpawnState) => this.send({ t: 'state', key, state }));
    spawn.on('ready', (ts) => this.send({ t: 'ready', key, ts }));
    spawn.on('chunk', (text: string) => this.send({ t: 'chunk', key, text }));
    spawn.on('exit', (code: number | null, signal: number | null) => {
      this.send({ t: 'exit', key, code, signal });
      this.entries.delete(key);
    });

    // Surface a ready-gate abort (ready-timeout / exited-before-ready / killed)
    // so the server's RemoteSpawn.awaitReady() can reject. The 'ready' success
    // path already rides the spawn.on('ready') forward above; we only need the
    // rejection here. Swallow after forwarding — the host doesn't act on it.
    spawn.awaitReady().then(
      () => {},
      (err: unknown) => {
        this.send({
          t: 'readyFailed',
          key,
          reason: err instanceof Error ? err.message : String(err),
        });
      },
    );

    spawn.start();
    entry.jsonlPath = spawn.getJsonlPath();
    this.send({
      t: 'spawned',
      key,
      pid: spawn.getPid?.() ?? null,
      jsonlPath: entry.jsonlPath,
    });
  }

  private onAttach(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) {
      this.send({ t: 'gone', key });
      return;
    }
    this.send({
      t: 'attached',
      key,
      pid: entry.spawn.getPid?.() ?? null,
      state: entry.spawn.getState(),
      jsonlPath: entry.jsonlPath ?? entry.spawn.getJsonlPath(),
    });
  }

  private async onSend(
    key: string,
    reqId: string,
    body: string,
    echoTimeoutMs?: number,
  ): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) {
      this.send({ t: 'sendResult', reqId, result: 'exited' });
      return;
    }
    try {
      const result = await entry.spawn.send(body, echoTimeoutMs);
      this.send({ t: 'sendResult', reqId, result });
    } catch (err) {
      this.send({
        t: 'error',
        key,
        reqId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private onRoster(reqId: string): void {
    const sessions: RosterEntry[] = [];
    for (const [key, entry] of this.entries) {
      sessions.push({
        key,
        pid: entry.spawn.getPid?.() ?? null,
        state: entry.spawn.getState(),
        jsonlPath: entry.jsonlPath ?? entry.spawn.getJsonlPath(),
      });
    }
    this.send({ t: 'rosterResult', reqId, sessions });
  }
}
