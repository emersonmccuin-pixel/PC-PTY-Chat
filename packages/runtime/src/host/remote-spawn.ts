// Out-of-process agent host — server-side spawn proxy.
//
// RemoteSpawn implements the SpawnLike interface AgentRun already depends on
// (agent-run.ts), so it drops straight into the `spawnFactory` seam with no
// change to the state machine. It proxies the PTY control plane to the host
// over the control channel, and owns its OWN JsonlTailer on the canonical
// on-disk JSONL — content is never sent over the wire (see the design doc).
//
// key = ccProviderSessionId: unique + durable per spawn, present in the spawn
// input at the factory seam (no signature change), and the same id the JSONL
// path is derived from. The server maps agentRunId ↔ ccSessionId via the DB for
// phase-2 reattach.

import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { JsonlTailer, type JsonlEvent, type JsonlEventMeta } from '../jsonl-tailer.ts';
import { jsonlPathFor } from '../path-resolver.ts';
import type { LowLevelSpawnInput, SpawnState } from '../low-level-spawn.ts';
import type { ReadyTimestamps } from '../ready-gate.ts';
import type { SendResult } from '../send-protocol.ts';
import type { SpawnLike } from '../agent-run.ts';
import type { HostToServerMsg, ServerToHostMsg } from './protocol.ts';

/** The slice of HostClient that a RemoteSpawn drives. Declared here (not
 *  imported from host-client) to keep the dependency one-way. */
export interface RemoteSpawnHost {
  sendToHost(msg: ServerToHostMsg): void;
  /** Resolves when the matching `sendResult` arrives, or rejects on disconnect. */
  awaitSendResult(reqId: string): Promise<SendResult>;
  /** Drop this spawn's routing entry once it's terminal. */
  unregister(key: string): void;
}

export class RemoteSpawn extends EventEmitter implements SpawnLike {
  readonly key: string;
  private state: SpawnState = 'spawning';
  private readonly input: LowLevelSpawnInput;
  private readonly host: RemoteSpawnHost;
  private resolvedJsonlPath: string | null = null;
  private tailer: JsonlTailer | null = null;
  private jsonlPollTimer: NodeJS.Timeout | null = null;
  private started = false;
  private readyPromise: Promise<ReadyTimestamps>;
  private readyResolve: ((ts: ReadyTimestamps) => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;

  constructor(input: LowLevelSpawnInput, host: RemoteSpawnHost) {
    super();
    this.input = input;
    this.host = host;
    this.key = input.ccProviderSessionId;
    this.readyPromise = new Promise<ReadyTimestamps>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // Avoid an unhandled-rejection if readyFailed/exit lands before a caller
    // attaches via awaitReady() (same guard as LowLevelSpawn's StubSpawn).
    this.readyPromise.catch(() => {});
  }

  start(): void {
    if (this.started) throw new Error('RemoteSpawn: start() called twice');
    this.started = true;

    // Resolve the JSONL path server-side so host + server agree regardless of
    // per-process CLAUDE_CONFIG_DIR, and pin it into the spawn input so the
    // host's LowLevelSpawn uses the same path.
    this.resolvedJsonlPath =
      this.input.jsonlPath ??
      jsonlPathFor(this.input.worktreePath, this.input.ccProviderSessionId);
    const spawnInput: LowLevelSpawnInput = {
      ...this.input,
      jsonlPath: this.resolvedJsonlPath,
    };

    this.host.sendToHost({ t: 'spawn', key: this.key, input: spawnInput });
    setImmediate(() => this.attachJsonlTailer());
  }

  awaitReady(): Promise<ReadyTimestamps> {
    return this.readyPromise;
  }

  async send(body: string, echoTimeoutMs?: number): Promise<SendResult> {
    if (this.state === 'exited') return 'exited';
    const reqId = randomUUID();
    const pending = this.host.awaitSendResult(reqId);
    this.host.sendToHost({ t: 'send', key: this.key, reqId, body, echoTimeoutMs });
    const result = await pending;
    if (result === 'ok') this.setState('running');
    return result;
  }

  writeRaw(bytes: string): boolean {
    if (this.state === 'exited') return false;
    this.host.sendToHost({ t: 'writeRaw', key: this.key, bytes });
    return true;
  }

  interrupt(): void {
    if (this.state === 'exited') return;
    this.host.sendToHost({ t: 'interrupt', key: this.key });
  }

  resize(cols: number, rows: number): void {
    if (this.state === 'exited') return;
    this.host.sendToHost({ t: 'resize', key: this.key, cols, rows });
  }

  kill(graceMs?: number): void {
    this.stopTailer();
    if (this.state === 'exited') return;
    this.host.sendToHost({ t: 'kill', key: this.key, graceMs });
  }

  notifyMcpHandshake(): void {
    this.host.sendToHost({ t: 'notifyHandshake', key: this.key });
  }

  getState(): SpawnState {
    return this.state;
  }

  getJsonlPath(): string | null {
    return this.resolvedJsonlPath;
  }

  // ── inbound from the host (routed by HostClient) ─────────────────────

  handleHostMsg(msg: HostToServerMsg): void {
    switch (msg.t) {
      case 'spawned':
        if (msg.jsonlPath) this.resolvedJsonlPath = msg.jsonlPath;
        break;
      case 'state':
        this.setState(msg.state);
        break;
      case 'ready':
        this.setState('ready');
        this.emit('ready', msg.ts);
        this.readyResolve?.(msg.ts);
        this.readyResolve = null;
        this.readyReject = null;
        break;
      case 'readyFailed':
        this.rejectReady(new Error(`RemoteSpawn: ready failed (${msg.reason})`));
        break;
      case 'chunk':
        this.emit('chunk', msg.text);
        break;
      case 'exit':
        this.onExit(msg.code, msg.signal);
        break;
      default:
        // attached / gone / sendResult / rosterResult / error are handled by
        // HostClient, not per-spawn.
        break;
    }
  }

  /** Connection to the host dropped — treat as an unexpected exit so the
   *  AgentRun lifecycle funnels to a terminal state instead of hanging. */
  handleDisconnect(): void {
    this.onExit(null, null);
  }

  // ── internals ────────────────────────────────────────────────────────

  private onExit(code: number | null, signal: number | null): void {
    if (this.state === 'exited') return;
    this.setState('exited');
    this.stopTailer();
    this.rejectReady(new Error('RemoteSpawn: exited before ready'));
    this.emit('exit', code, signal);
    this.host.unregister(this.key);
  }

  private setState(next: SpawnState): void {
    if (this.state === next) return;
    if (this.state === 'exited') return; // terminal is sticky
    this.state = next;
    this.emit('state', next);
  }

  private rejectReady(err: Error): void {
    if (this.readyReject) {
      this.readyReject(err);
      this.readyResolve = null;
      this.readyReject = null;
    }
  }

  private stopTailer(): void {
    if (this.jsonlPollTimer) {
      clearTimeout(this.jsonlPollTimer);
      this.jsonlPollTimer = null;
    }
    if (this.tailer) {
      this.tailer.stop();
      this.tailer = null;
    }
  }

  /** Poll for the JSONL file then attach the tailer. Mirrors
   *  LowLevelSpawn.attachJsonlTailer, including the resume start-line skip so a
   *  resumed conversation's prior turn-ends don't replay as fresh events. */
  private attachJsonlTailer(): void {
    if (this.state === 'exited') return;
    const path = this.resolvedJsonlPath;
    if (!path) return;

    const tryAttach = (): void => {
      if (this.tailer || this.state === 'exited') return;
      if (existsSync(path)) {
        let startLine = 0;
        if (this.input.jsonlStartLine !== undefined) {
          startLine = this.input.jsonlStartLine;
        } else if (this.input.mode === 'resume') {
          try {
            startLine = readFileSync(path, 'utf-8').split('\n').filter(Boolean).length;
          } catch {
            startLine = 0;
          }
        }
        this.tailer = new JsonlTailer({ filePath: path, startLine });
        this.tailer.on('event', (ev: JsonlEvent, meta?: JsonlEventMeta) =>
          this.emit('jsonl-event', ev, meta),
        );
        this.tailer.start();
        return;
      }
      this.jsonlPollTimer = setTimeout(tryAttach, 250);
    };
    tryAttach();
  }
}
