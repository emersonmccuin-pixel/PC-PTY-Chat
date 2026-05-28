// Section 25 Session 7 — v2 JSONL tailer.
//
// Reads CC's per-session JSONL line-by-line and emits the v2 signal set
// (design §7). Sits alongside v1's `jsonl-tailer.ts` during the parallel
// build phase; Session 10's cutover swaps LowLevelSpawn over.
//
// v2 additions over v1:
//
// 1. Turn-end OR rule. v1 fires only on assistant rows. v2 ALSO fires on
//    `system stop_hook_summary` — the labs scenario 19 signal that closes
//    the pause-no-text gap. De-duplicated per loop.
//
// 2. Pause-detected event. New event kind that fires when the agent ends
//    a turn via a tool call with no closing text. The orchestrator's
//    pause-resume flow (Sessions 8 + 9) consumes this signal.
//
// 3. Interleaved-thinking fix. Opus 4.7 can emit two assistant rows with
//    `stop_reason: end_turn` in one logical turn — first thinking-only,
//    second text-bearing. v1's "first end_turn = done" logic was broken;
//    v2 waits for the first text-bearing assistant OR stop_hook_summary,
//    whichever comes first.
//
// 4. setImmediate-deferred first emit (§7.5). v1 emitted historical lines
//    synchronously inside `start()`, which fired events into the void
//    when callers' listeners hadn't yet wired. v2 defers via setImmediate
//    so the constructor-emit-before-listeners-wired bug class
//    (memoed as [[constructor-emit-before-listeners-wired]]) can't recur.
//
// 5. `row: unknown` attached to every event. Consumers that need to peek
//    at the raw JSONL entry can read `ev.row`; the canonical fields are
//    pre-computed for the common cases. Section 6's AgentRun helpers
//    consume this raw row directly.
//
// Pure module — no PtySession / WS / DB awareness. Same testability
// contract as v1: point at a file path, listen for events.

import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';

export type AgentRunJsonlEventKind =
  | 'jsonl-user'
  | 'jsonl-queue-enqueue'
  | 'jsonl-queue-dequeue'
  | 'jsonl-tool-call'
  | 'jsonl-tool-result'
  | 'jsonl-turn-end'
  | 'jsonl-pause-detected'
  | 'jsonl-usage'
  | 'jsonl-sidechain'
  | 'jsonl-system';

/** Every v2 event carries the raw JSONL `row` it was derived from so
 *  consumers can peek at fields the canonical event doesn't expose. */
export type AgentRunJsonlEvent =
  | { kind: 'jsonl-user'; text: string; row: unknown }
  | { kind: 'jsonl-queue-enqueue'; timestamp: string | null; row: unknown }
  | { kind: 'jsonl-queue-dequeue'; timestamp: string | null; row: unknown }
  | {
      kind: 'jsonl-tool-call';
      toolUseId: string;
      name: string;
      input: unknown;
      row: unknown;
    }
  | {
      kind: 'jsonl-tool-result';
      toolUseId: string;
      result: unknown;
      isError: boolean;
      row: unknown;
    }
  | {
      kind: 'jsonl-turn-end';
      text: string;
      stopReason: string | null;
      /** Which OR-rule branch fired. 'assistant' = primary path
       *  (assistant row with text). 'stop-hook' = secondary path
       *  (system stop_hook_summary). */
      trigger: 'assistant' | 'stop-hook';
      row: unknown;
    }
  | { kind: 'jsonl-pause-detected'; row: unknown }
  | {
      kind: 'jsonl-usage';
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      model: string | null;
      row: unknown;
    }
  | { kind: 'jsonl-sidechain'; raw: unknown; row: unknown }
  | {
      kind: 'jsonl-system';
      subtype: string;
      level: string;
      message: string;
      timestamp: string | null;
      raw: unknown;
      row: unknown;
    };

export interface JsonlTailerOptionsForAgentRun {
  filePath: string;
  /** Skip this many leading lines on first read. Used to resume past a
   *  persisted cursor after server restart. Defaults to 0 (process all). */
  startLine?: number;
  /** Poll interval ms for the read loop. Defaults to 200. */
  pollIntervalMs?: number;
}

/** Per-loop bookkeeping. Reset at every loop boundary (new `user` prompt
 *  or queued_command attachment). */
interface LoopState {
  /** Has a turn-end event already fired for this loop (via either path)? */
  firedThisLoop: boolean;
  /** stop_reason of the most recent assistant row in THIS loop (used by
   *  the pause-detector). null if no assistant row seen yet. */
  lastAssistantStopReason: string | null;
  /** Pause-detector state machine:
   *    'idle'   — no pause signal in progress
   *    'armed'  — last assistant had stop_reason: tool_use AND a matching
   *               tool_result has arrived; waiting for either another
   *               assistant (continues the loop) or stop_hook_summary
   *               (confirms pause) */
  pauseWatch: 'idle' | 'armed';
}

function freshLoopState(): LoopState {
  return {
    firedThisLoop: false,
    lastAssistantStopReason: null,
    pauseWatch: 'idle',
  };
}

/**
 * One tailer = one JSONL file. Emits:
 *   'event' (AgentRunJsonlEvent) — one per canonical event derived from a line
 *   'error' (Error)        — file read / parse infra failures (per-line
 *                            parse errors are swallowed + cursor advances)
 */
export class AgentRunJsonlTailer extends EventEmitter {
  private filePath: string;
  private cursor: number;
  private pollIntervalMs: number;
  private poller: ReturnType<typeof setInterval> | null = null;
  private loop: LoopState = freshLoopState();
  private startedOnce = false;

  constructor(opts: JsonlTailerOptionsForAgentRun) {
    super();
    this.filePath = opts.filePath;
    this.cursor = opts.startLine ?? 0;
    this.pollIntervalMs = opts.pollIntervalMs ?? 200;
  }

  /** Begin tailing. The initial drain (any pre-existing lines past the
   *  cursor) is deferred to a setImmediate tick so the caller has a
   *  chance to attach listeners between `new AgentRunJsonlTailer(...)` and
   *  the first event. Subsequent polls read the file directly instead of
   *  depending on platform mtime/change notifications. Idempotent — calling
   *  twice does nothing. */
  start(): void {
    if (this.poller) return;
    if (this.startedOnce && this.poller === null) {
      // start() was called once, then stop()ped, now restart — re-arm.
    }
    this.startedOnce = true;
    this.poller = setInterval(() => this.readTail(), this.pollIntervalMs);
    this.poller.unref?.();
    // setImmediate so listeners attached AFTER `new ...()` but BEFORE the
    // next tick still see the initial drain. Section 15 lesson:
    // [[constructor-emit-before-listeners-wired]].
    setImmediate(() => this.readTail());
  }

  /** Release the poller. Safe to call multiple times. */
  stop(): void {
    if (!this.poller) return;
    clearInterval(this.poller);
    this.poller = null;
  }

  /** Current line count consumed. Persist this to resume past a restart. */
  getCursor(): number {
    return this.cursor;
  }

  /** Synchronously drain currently available complete lines without starting
   *  the polling loop. Used by HTTP backfill endpoints that need a one-shot
   *  snapshot of an existing transcript. */
  drainAvailable(): void {
    this.readTail();
  }

  private readTail(): void {
    if (!existsSync(this.filePath)) return;
    let content: string;
    try {
      content = readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      this.emit('error', err);
      return;
    }
    const endsWithNewline = content.endsWith('\n');
    const segments = content.split('\n');
    if (endsWithNewline) segments.pop();
    const completeLines = endsWithNewline ? segments : segments.slice(0, -1);

    if (completeLines.length <= this.cursor) return;

    for (let i = this.cursor; i < completeLines.length; i++) {
      const line = completeLines[i];
      if (!line) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      this.processEntry(obj);
    }
    this.cursor = completeLines.length;
  }

  private emitEvent(ev: AgentRunJsonlEvent): void {
    this.emit('event', ev);
  }

  private startNewLoop(): void {
    this.loop = freshLoopState();
  }

  private processEntry(obj: unknown): void {
    if (!obj || typeof obj !== 'object') return;
    const entry = obj as Record<string, unknown>;

    // Sidechain rows short-circuit all other rendering. Section 0 captured;
    // surfacing decisions live in the renderer.
    if (entry.isSidechain === true) {
      this.emitEvent({ kind: 'jsonl-sidechain', raw: entry, row: entry });
      return;
    }

    const type = entry.type;

    if (type === 'queue-operation') {
      const op = entry.operation;
      const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : null;
      if (op === 'enqueue') {
        this.emitEvent({ kind: 'jsonl-queue-enqueue', timestamp, row: entry });
      } else if (op === 'dequeue' || op === 'remove') {
        // §7.4: CC 2.0 logged `dequeue`; CC 2.1+ logs `remove` for
        // turn-end-driven consumption. Collapse both into one event.
        this.emitEvent({ kind: 'jsonl-queue-dequeue', timestamp, row: entry });
      }
      return;
    }

    if (type === 'attachment') {
      const a = entry.attachment as Record<string, unknown> | undefined;
      if (a && a.type === 'queued_command') {
        const text = extractQueuedCommandPrompt(a.prompt);
        if (text) {
          // A queued command popping = start of a fresh loop. CC's
          // queue-consume path doesn't emit a `type: 'user'` row; this
          // attachment IS the loop boundary.
          this.startNewLoop();
          this.emitEvent({ kind: 'jsonl-user', text, row: entry });
        }
      }
      return;
    }

    if (type === 'user') {
      const message = entry.message as Record<string, unknown> | undefined;
      if (!message) return;
      const content = message.content;
      // User prompt — content is a plain string. Boundary of a new loop.
      if (typeof content === 'string') {
        if (content) {
          this.startNewLoop();
          this.emitEvent({ kind: 'jsonl-user', text: content, row: entry });
        }
        return;
      }
      // Tool-result wrapper — content is an array of tool_result blocks.
      // NOT a new loop; continues the current one.
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type !== 'tool_result') continue;
          this.emitEvent({
            kind: 'jsonl-tool-result',
            toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : '',
            result: b.content,
            isError: b.is_error === true,
            row: entry,
          });
        }
        // §7.2: arm pause-watch if the prior assistant ended in tool_use.
        // The next signal (another assistant row vs stop_hook_summary)
        // decides between continuation and pause.
        if (this.loop.lastAssistantStopReason === 'tool_use') {
          this.loop.pauseWatch = 'armed';
        }
      }
      return;
    }

    if (type === 'assistant') {
      // An assistant row inside a tool-loop clears the pause-watch:
      // model is continuing, not paused.
      this.loop.pauseWatch = 'idle';

      const message = entry.message as Record<string, unknown> | undefined;
      if (!message) return;
      const content = message.content;

      // Tool calls — each tool_use block becomes one jsonl-tool-call.
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type !== 'tool_use') continue;
          this.emitEvent({
            kind: 'jsonl-tool-call',
            toolUseId: typeof b.id === 'string' ? b.id : '',
            name: typeof b.name === 'string' ? b.name : '',
            input: b.input ?? null,
            row: entry,
          });
        }
      }

      // Usage block — Anthropic SDK shape. Fires once per assistant entry.
      const usage = message.usage;
      if (usage && typeof usage === 'object') {
        const u = usage as Record<string, unknown>;
        this.emitEvent({
          kind: 'jsonl-usage',
          inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : 0,
          outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
          cacheCreationTokens:
            typeof u.cache_creation_input_tokens === 'number'
              ? u.cache_creation_input_tokens
              : 0,
          cacheReadTokens:
            typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0,
          model: typeof message.model === 'string' ? (message.model as string) : null,
          row: entry,
        });
      }

      // Turn-end logic — §7.1 + §7.3.
      const hasStopReasonField = 'stop_reason' in message;
      const stopReason = (message.stop_reason as string | null | undefined) ?? null;
      this.loop.lastAssistantStopReason = stopReason;

      if (!hasStopReasonField) return;

      const isMidLoop = stopReason === 'tool_use' || stopReason === 'pause_turn';
      if (isMidLoop) return;
      if (this.loop.firedThisLoop) return;

      const text = extractAssistantText(content);
      const hasText = text.length > 0;

      // §7.3 — interleaved-thinking fix. For the named happy-path
      // stop_reasons (end_turn / max_tokens / stop_sequence), require
      // a non-empty text content block before emitting. Without text,
      // wait for either the next text-bearing assistant or
      // stop_hook_summary (the OR-rule fallback).
      //
      // For `stop_reason === null` (the empirically-verified user-
      // interrupt sentinel — see v1 jsonl-tailer.ts comment) and other
      // unknown future non-mid-loop stop_reasons, emit regardless. The
      // turn really has ended; the absence of closing text is the user
      // interrupting, not an interleaved-thinking artifact.
      const isNamedHappyStop =
        stopReason === 'end_turn' ||
        stopReason === 'max_tokens' ||
        stopReason === 'stop_sequence';
      if (isNamedHappyStop && !hasText) return;

      this.emitEvent({
        kind: 'jsonl-turn-end',
        text,
        stopReason,
        trigger: 'assistant',
        row: entry,
      });
      this.loop.firedThisLoop = true;
      return;
    }

    if (type === 'system') {
      const subtype = typeof entry.subtype === 'string' ? entry.subtype : '';
      if (!subtype) return;

      // §7.1 OR-rule fallback + §7.2 pause confirmation.
      if (subtype === 'stop_hook_summary') {
        // Pause detection takes precedence — emit it BEFORE the turn-end
        // fallback so consumers can wire the two events in sequence.
        if (this.loop.pauseWatch === 'armed') {
          this.emitEvent({ kind: 'jsonl-pause-detected', row: entry });
          this.loop.pauseWatch = 'idle';
        }
        if (!this.loop.firedThisLoop) {
          this.emitEvent({
            kind: 'jsonl-turn-end',
            text: '',
            stopReason: null,
            trigger: 'stop-hook',
            row: entry,
          });
          this.loop.firedThisLoop = true;
        }
        // Don't emit a generic jsonl-system for stop_hook_summary — the
        // canonical signal IS the turn-end / pause-detected, and the
        // renderer doesn't need a duplicate.
        return;
      }

      const level = typeof entry.level === 'string' ? entry.level : 'info';
      const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : null;
      this.emitEvent({
        kind: 'jsonl-system',
        subtype,
        level,
        message: formatSystemMessage(subtype, entry),
        timestamp,
        raw: entry,
        row: entry,
      });
      return;
    }

    // Unknown / metadata row types — drop silently. v1's tolerance preserved.
  }
}

// -- helpers ----------------------------------------------------------

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (b): b is { type: 'text'; text: string } =>
        !!b &&
        typeof b === 'object' &&
        (b as Record<string, unknown>).type === 'text' &&
        typeof (b as Record<string, unknown>).text === 'string',
    )
    .map((b) => b.text)
    .join('\n');
}

function extractQueuedCommandPrompt(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt;
  if (!Array.isArray(prompt)) return '';
  let text = '';
  for (const block of prompt) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      text += (block as { text: string }).text;
    }
  }
  return text;
}

/** Build a one-line summary of a `type: 'system'` row. Mirrored from v1 with
 *  the same formatting rules — change here AND in v1's `formatSystemMessage`
 *  to keep render parity until v1 retires. */
function formatSystemMessage(subtype: string, entry: Record<string, unknown>): string {
  if (subtype === 'api_error') {
    const errOuter = entry.error as Record<string, unknown> | undefined;
    const status =
      errOuter && typeof errOuter.status === 'number' ? (errOuter.status as number) : null;
    let innerType = '';
    let innerMsg = '';
    if (errOuter && typeof errOuter.error === 'object' && errOuter.error) {
      const lvl1 = errOuter.error as Record<string, unknown>;
      if (typeof lvl1.error === 'object' && lvl1.error) {
        const lvl2 = lvl1.error as Record<string, unknown>;
        innerType = typeof lvl2.type === 'string' ? (lvl2.type as string) : '';
        innerMsg = typeof lvl2.message === 'string' ? (lvl2.message as string) : '';
      }
    }
    const retryInMs = typeof entry.retryInMs === 'number' ? (entry.retryInMs as number) : null;
    const attempt =
      typeof entry.retryAttempt === 'number' ? (entry.retryAttempt as number) : null;
    const maxRetries =
      typeof entry.maxRetries === 'number' ? (entry.maxRetries as number) : null;
    const head = innerMsg || innerType || 'API error';
    const statusBit = status !== null ? ` (HTTP ${status})` : '';
    if (attempt !== null && maxRetries !== null && retryInMs !== null) {
      const secs = (retryInMs / 1000).toFixed(1);
      return `${head}${statusBit} — retrying in ${secs}s (attempt ${attempt}/${maxRetries})`;
    }
    if (attempt !== null && maxRetries !== null) {
      return `${head}${statusBit} (attempt ${attempt}/${maxRetries})`;
    }
    return `${head}${statusBit}`;
  }

  if (subtype === 'init') {
    const cwd = typeof entry.cwd === 'string' ? entry.cwd : '';
    return cwd ? `Session started — cwd ${cwd}` : 'Session started';
  }

  const message = typeof entry.message === 'string' ? (entry.message as string) : '';
  if (message) return `[${subtype}] ${message}`;
  return `[${subtype}]`;
}
