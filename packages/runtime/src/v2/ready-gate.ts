// Three-signal ready gate.
//
// Send is only permitted when ALL THREE signals have fired:
//   1. MCP handshake — pc-rig's `server.oninitialized` POSTs to
//      /api/internal/mcp-handshake. We expose notifyHandshake() so the HTTP
//      route can flip the flag.
//   2. Composer-ready — CC emitted `\x1b[?2004h` (bracketed-paste-mode-on)
//      into the PTY. One-shot ANSI sequence. Banner-immune.
//   3. Init-complete — CC emitted the `/remote-control is active` substring
//      somewhere in raw stdout. Matched after running the buffer through
//      collapseAnsiToWhitespace so the resume-mode cursor-move-right
//      rendering also matches.
//
// The fresh and resume orderings differ — fresh emits composer-ready first,
// resume emits handshake first — but BOTH must satisfy all three before the
// gate opens. The gate doesn't enforce ordering; it waits for all three.
//
// Pure logic. No PTY, no HTTP, no fs. Tested in isolation.

import { EventEmitter } from 'node:events';
import { collapseAnsiToWhitespace } from './ansi.ts';

const INIT_COMPLETE_SUBSTRING = '/remote-control is active';
const BRACKETED_PASTE_ON = '\x1b[?2004h';

export interface ReadyTimestamps {
  /** ms since epoch — when notifyHandshake() was called. */
  handshakeAt: number;
  /** ms since epoch — when `\x1b[?2004h` was first observed. */
  composerReadyAt: number;
  /** ms since epoch — when "/remote-control is active" first matched. */
  initCompleteAt: number;
}

export class ReadyGate extends EventEmitter {
  private handshakeAt: number | null = null;
  private composerReadyAt: number | null = null;
  private initCompleteAt: number | null = null;
  private rawBuffer = '';
  private settled = false;
  /** Optional override so tests can advance time deterministically. */
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    super();
    this.now = opts.now ?? Date.now;
  }

  /** Feed a raw stdout chunk from the PTY. Idempotent once the gate opens. */
  feedChunk(bytes: string): void {
    if (this.settled) return;
    this.rawBuffer += bytes;

    if (this.composerReadyAt === null && bytes.includes(BRACKETED_PASTE_ON)) {
      this.composerReadyAt = this.now();
    }

    if (
      this.initCompleteAt === null &&
      collapseAnsiToWhitespace(this.rawBuffer).includes(INIT_COMPLETE_SUBSTRING)
    ) {
      this.initCompleteAt = this.now();
    }

    this.maybeFire();
  }

  /** Called by the HTTP handler when the agent's pc-rig MCP child POSTs
   *  /api/internal/mcp-handshake. Idempotent. */
  notifyHandshake(): void {
    if (this.settled) return;
    if (this.handshakeAt !== null) return;
    this.handshakeAt = this.now();
    this.maybeFire();
  }

  /** Returns the three timestamps if all signals have fired, else null. */
  snapshot(): ReadyTimestamps | null {
    if (
      this.handshakeAt === null ||
      this.composerReadyAt === null ||
      this.initCompleteAt === null
    ) {
      return null;
    }
    return {
      handshakeAt: this.handshakeAt,
      composerReadyAt: this.composerReadyAt,
      initCompleteAt: this.initCompleteAt,
    };
  }

  isOpen(): boolean {
    return this.settled;
  }

  /** Defensive: clear state. Used when the spawn dies before the gate opens
   *  so the consumer's awaitReady promise can be rejected cleanly. */
  abort(reason: string): void {
    if (this.settled) return;
    this.settled = true;
    this.emit('aborted', reason);
  }

  private maybeFire(): void {
    if (this.settled) return;
    const snap = this.snapshot();
    if (!snap) return;
    this.settled = true;
    // Defer emit so callers attaching listeners after construction still
    // receive the event. (Section 15 lesson: synchronous emit during
    // construction races caller listener attach.)
    setImmediate(() => this.emit('ready', snap));
  }
}
