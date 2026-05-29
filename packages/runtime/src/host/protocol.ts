// Out-of-process agent host — control protocol.
//
// The thin control channel between the API server (client) and the long-lived
// agent host (owns node-pty / claude.exe children). Carries COMMANDS +
// LIFECYCLE EVENTS only — never JSONL conversation content. Content stays
// canonical on disk; the server re-derives it with its own JsonlTailer (see
// docs/out-of-process-agent-host-design.md). This keeps reattach replay-free.
//
// Wire format: newline-delimited JSON (one message object per line). Both the
// WS binding (apps/server) and the in-memory test transport speak these types;
// `encodeMsg` / `decodeMsg` are the only serialization seam.
//
// `key` = agentRunId (durable; reused on reattach so the host re-binds the same
// PTY). Phase 1 uses spawn/send/.../kill + lifecycle events; `attach` + the
// reattach roster fields are defined now so the phase-2 reattach work doesn't
// reshape the protocol.

import type { LowLevelSpawnInput, SpawnState } from '../low-level-spawn.ts';
import type { ReadyTimestamps } from '../ready-gate.ts';
import type { SendResult } from '../send-protocol.ts';

/** Spawn input as it travels on the wire. Identical to LowLevelSpawnInput —
 *  every field is JSON-serializable (strings / numbers / booleans / arrays).
 *  `jsonlPath` is resolved server-side and set before send so host/server agree
 *  on the canonical JSONL path regardless of per-process CLAUDE_CONFIG_DIR
 *  divergence (see memory reference_claude_config_dir_overrides_projects_root). */
export type SerializableSpawnInput = LowLevelSpawnInput;

// ── Server → Host (commands) ─────────────────────────────────────────────

export type ServerToHostMsg =
  | { t: 'spawn'; key: string; input: SerializableSpawnInput }
  /** Reattach to an already-running PTY after a server restart (phase 2). */
  | { t: 'attach'; key: string }
  | { t: 'send'; key: string; reqId: string; body: string; echoTimeoutMs?: number }
  | { t: 'writeRaw'; key: string; bytes: string }
  | { t: 'interrupt'; key: string }
  | { t: 'resize'; key: string; cols: number; rows: number }
  | { t: 'kill'; key: string; graceMs?: number }
  | { t: 'notifyHandshake'; key: string }
  | { t: 'roster'; reqId: string };

// ── Host → Server (events + replies) ─────────────────────────────────────

export interface RosterEntry {
  key: string;
  pid: number | null;
  state: SpawnState;
  jsonlPath: string | null;
}

export type HostToServerMsg =
  | { t: 'spawned'; key: string; pid: number | null; jsonlPath: string | null }
  | { t: 'attached'; key: string; pid: number | null; state: SpawnState; jsonlPath: string | null }
  | { t: 'gone'; key: string }
  | { t: 'state'; key: string; state: SpawnState }
  | { t: 'ready'; key: string; ts: ReadyTimestamps }
  /** The host-side ready gate aborted (ready-timeout / exited-before-ready /
   *  killed). Lets the server's awaitReady() reject — the in-process path got
   *  this for free from LowLevelSpawn.awaitReady()'s rejection. */
  | { t: 'readyFailed'; key: string; reason: string }
  | { t: 'chunk'; key: string; text: string }
  | { t: 'exit'; key: string; code: number | null; signal: number | null }
  | { t: 'sendResult'; reqId: string; result: SendResult }
  | { t: 'rosterResult'; reqId: string; sessions: RosterEntry[] }
  | { t: 'error'; key?: string; reqId?: string; message: string };

// ── Codec ────────────────────────────────────────────────────────────────

export function encodeMsg(msg: ServerToHostMsg | HostToServerMsg): string {
  return JSON.stringify(msg);
}

/** Parse one wire line. Throws on malformed JSON; callers log + drop the line
 *  rather than tearing the connection down over one bad frame. */
export function decodeMsg<T extends ServerToHostMsg | HostToServerMsg>(line: string): T {
  return JSON.parse(line) as T;
}

/** A duplex message channel. The host side parameterizes
 *  `MessageChannel<HostToServerMsg, ServerToHostMsg>`; the client side flips
 *  the type arguments. `subscribe` returns an unsubscribe fn. */
export interface MessageChannel<TX, RX> {
  send(msg: TX): void;
  subscribe(handler: (msg: RX) => void): () => void;
}
