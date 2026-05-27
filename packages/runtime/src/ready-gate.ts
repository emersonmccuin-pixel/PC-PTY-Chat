// Ready gate for spawned Claude sessions.
//
// Send is only permitted when the required signals have fired:
//   1. MCP handshake — pc-rig's `server.oninitialized` POSTs to
//      /api/internal/mcp-handshake. We expose notifyHandshake() so the HTTP
//      route can flip the flag.
//   2. Composer-ready — CC emitted `\x1b[?2004h` (bracketed-paste-mode-on)
//      into the PTY. One-shot ANSI sequence. Banner-immune.
//   3. Optional init-complete — CC emitted the `/remote-control is active` substring
//      somewhere in raw stdout. Matched after running the buffer through
//      collapseAnsiToWhitespace so the resume-mode cursor-move-right
//      rendering also matches.
//
// Subagents deliberately do not use `--remote-control`, so their gate requires
// only the first two signals. The orchestrator can require the remote-control
// banner when launched through PtySession instead of this primitive.
//
// The fresh and resume orderings differ — fresh often emits composer-ready
// first, resume often emits handshake first. The gate doesn't enforce ordering;
// it waits for the configured signal set.
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
  /** ms since epoch — when "/remote-control is active" first matched.
   *  Null when init-complete is not required for this gate. */
  initCompleteAt: number | null;
}

export class ReadyGate extends EventEmitter {
  private handshakeAt: number | null = null;
  private composerReadyAt: number | null = null;
  private initCompleteAt: number | null = null;
  private rawBuffer = '';
  private settled = false;
  private readonly requireInitComplete: boolean;
  /** Optional override so tests can advance time deterministically. */
  private readonly now: () => number;

  constructor(opts: { now?: () => number; requireInitComplete?: boolean } = {}) {
    super();
    this.now = opts.now ?? Date.now;
    this.requireInitComplete = opts.requireInitComplete ?? true;
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
      (this.requireInitComplete && this.initCompleteAt === null)
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
