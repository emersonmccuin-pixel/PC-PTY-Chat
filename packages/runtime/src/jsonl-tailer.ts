// Tails CC's per-session JSONL file (~/.claude/projects/<encoded-cwd>/<uuid>.jsonl)
// and emits typed canonical events. Source of truth for turn lifecycle + tool
// calls; replaces the hook-driven derivation that misses the four documented
// Stop-skip cases (see docs/design/chat-reliability.md).
//
// Pure module: no PtySession / WS / DB awareness. Tested by pointing at a real
// JSONL file and reading the emitted events.

import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, unwatchFile, watchFile } from 'node:fs';

export type JsonlEvent =
  | { kind: 'jsonl-user'; text: string }
  | { kind: 'jsonl-queue-enqueue'; timestamp: string | null }
  | { kind: 'jsonl-queue-dequeue'; timestamp: string | null }
  | {
      kind: 'jsonl-tool-call';
      toolUseId: string;
      name: string;
      input: unknown;
    }
  | {
      kind: 'jsonl-tool-result';
      toolUseId: string;
      result: unknown;
      isError: boolean;
    }
  | { kind: 'jsonl-turn-end'; text: string; stopReason: string | null }
  | {
      kind: 'jsonl-usage';
      // Per-API-call token usage from the assistant message's `usage` field.
      // Each assistant entry (mid-loop OR turn-end) carries one of these.
      // Client sums across entries to get session totals — sidechain entries
      // short-circuit before this fires, so subagent tokens don't pollute
      // orchestrator totals.
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      model: string | null;
    }
  | { kind: 'jsonl-sidechain'; raw: unknown }
  /**
   * `type: 'system'` rows from CC's JSONL. claude.exe writes these for any
   * non-turn event the user would see in the CLI's stderr / status line:
   *   - `subtype: 'api_error'` — Anthropic API failure, with retry metadata.
   *     Surfaces the "Overloaded — retrying in 8s (attempt 5/10)" status line
   *     that the CLI shows but our chat panel was previously eating.
   *   - `subtype: 'init'` — session boot banner.
   *   - other subtypes claude.exe adds over time — we emit them all and let
   *     the chat panel decide what to render (default: dump the raw entry).
   * Per [[hand-user-everything]] / 2026-05-19 ask: the user must see EVERY
   * system message a claude code CLI user would see; missing this surface is
   * how "stuck in Thinking" with no diagnosis becomes a frustrating bug.
   */
  | {
      kind: 'jsonl-system';
      subtype: string;
      level: string;
      message: string;
      timestamp: string | null;
      raw: unknown;
    };

export interface JsonlTailerOptions {
  filePath: string;
  /** Skip this many leading lines on first read. Used to resume past a
   *  persisted cursor after server restart. Defaults to 0 (process all). */
  startLine?: number;
  /** Poll interval ms for the underlying watchFile. Defaults to 200. */
  pollIntervalMs?: number;
}

/**
 * One tailer = one JSONL file. Emits:
 *   'event' (JsonlEvent) — one per canonical event derived from a line
 *   'error' (Error)      — file read / parse infra failures (per-line parse
 *                          errors are swallowed + cursor still advances)
 */
export class JsonlTailer extends EventEmitter {
  private filePath: string;
  private cursor: number;
  private pollIntervalMs: number;
  private watcher: (() => void) | null = null;

  constructor(opts: JsonlTailerOptions) {
    super();
    this.filePath = opts.filePath;
    this.cursor = opts.startLine ?? 0;
    this.pollIntervalMs = opts.pollIntervalMs ?? 200;
  }

  /** Begin tailing. Reads any current tail past the cursor immediately, then
   *  polls. Idempotent — calling twice does nothing. */
  start(): void {
    if (this.watcher) return;
    const listener = () => this.readTail();
    watchFile(this.filePath, { interval: this.pollIntervalMs }, listener);
    this.watcher = () => unwatchFile(this.filePath, listener);
    // Initial read — watchFile only fires on subsequent stat changes, so we
    // need to drain any already-present content past the cursor.
    this.readTail();
  }

  /** Release the watcher. Safe to call multiple times. */
  stop(): void {
    if (!this.watcher) return;
    this.watcher();
    this.watcher = null;
  }

  /** Current line count consumed. Persist this to resume past a restart. */
  getCursor(): number {
    return this.cursor;
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
    // Newline-delimited records. If the file does NOT end with '\n' the last
    // segment is mid-write — leave it for the next tick when it's terminated.
    const endsWithNewline = content.endsWith('\n');
    const segments = content.split('\n');
    if (endsWithNewline) segments.pop(); // drop empty trailing element
    const completeLines = endsWithNewline ? segments : segments.slice(0, -1);

    if (completeLines.length <= this.cursor) return;

    for (let i = this.cursor; i < completeLines.length; i++) {
      const line = completeLines[i];
      if (!line) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        // Malformed line — skip but still advance the cursor below.
        continue;
      }
      this.processEntry(obj);
    }
    this.cursor = completeLines.length;
  }

  private processEntry(obj: unknown): void {
    if (!obj || typeof obj !== 'object') return;
    const entry = obj as Record<string, unknown>;

    // isSidechain entries short-circuit all other rendering. Section 0
    // captures them; Section 6 (Activity panel) decides how to render.
    if (entry.isSidechain === true) {
      this.emit('event', { kind: 'jsonl-sidechain', raw: entry } satisfies JsonlEvent);
      return;
    }

    const type = entry.type;

    if (type === 'queue-operation') {
      const op = entry.operation;
      const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : null;
      if (op === 'enqueue') {
        this.emit('event', { kind: 'jsonl-queue-enqueue', timestamp } satisfies JsonlEvent);
      } else if (op === 'dequeue' || op === 'remove') {
        // CC's queue protocol logs two consumption operations:
        //   - `dequeue` when a command is pulled for processing via the normal
        //     consume path (messageQueueManager.dequeue)
        //   - `remove` when a command leaves the queue via reference / filter
        //     removal (messageQueueManager.remove / removeByFilter). The
        //     "queued command processed at turn-end" path on CC ≥2.1 fires
        //     `remove`. Both mean "this queue slot is gone" — collapse into
        //     our single `jsonl-queue-dequeue` envelope so the UI pops it.
        this.emit('event', { kind: 'jsonl-queue-dequeue', timestamp } satisfies JsonlEvent);
      }
      return;
    }

    if (type === 'user') {
      const message = entry.message as Record<string, unknown> | undefined;
      if (!message) return;
      const content = message.content;
      // User prompt: content is a plain string.
      if (typeof content === 'string') {
        if (content) {
          this.emit('event', { kind: 'jsonl-user', text: content } satisfies JsonlEvent);
        }
        return;
      }
      // Tool-result wrapper: content is an array of tool_result blocks.
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type !== 'tool_result') continue;
          this.emit('event', {
            kind: 'jsonl-tool-result',
            toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : '',
            result: b.content,
            isError: b.is_error === true,
          } satisfies JsonlEvent);
        }
      }
      return;
    }

    if (type === 'assistant') {
      const message = entry.message as Record<string, unknown> | undefined;
      if (!message) return;
      const content = message.content;
      // Tool calls are individual content blocks within an assistant message.
      // Emit each as its own event so the chat panel can render them
      // incrementally.
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type !== 'tool_use') continue;
          this.emit('event', {
            kind: 'jsonl-tool-call',
            toolUseId: typeof b.id === 'string' ? b.id : '',
            name: typeof b.name === 'string' ? b.name : '',
            input: b.input ?? null,
          } satisfies JsonlEvent);
        }
      }
      // Usage block — Anthropic SDK response shape. Emit once per assistant
      // entry (whether mid-loop or turn-end), client sums for the session.
      const usage = message.usage;
      if (usage && typeof usage === 'object') {
        const u = usage as Record<string, unknown>;
        this.emit('event', {
          kind: 'jsonl-usage',
          inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : 0,
          outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
          cacheCreationTokens:
            typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0,
          cacheReadTokens:
            typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0,
          model: typeof message.model === 'string' ? (message.model as string) : null,
        } satisfies JsonlEvent);
      }
      // Turn-end fires for any stop_reason that means "model is no longer
      // working" — covers the four documented Stop-skip cases from CC's
      // src/query.ts:1267 (user interrupt, API error, max_tokens, reactive
      // compact). Mid-loop signals are `tool_use` (continuing with tool
      // execution) and `pause_turn` (extended thinking pause). Everything
      // else — including `null` (verified empirically as the user-interrupt
      // signature: assistant line lands with stop_reason:null, followed
      // immediately by a user message containing "[Request interrupted by
      // user]") — is treated as a turn-end.
      const stopReason = message.stop_reason as string | null | undefined;
      const isMidLoop = stopReason === 'tool_use' || stopReason === 'pause_turn';
      const hasStopReasonField = 'stop_reason' in message;
      if (hasStopReasonField && !isMidLoop) {
        const text = Array.isArray(content)
          ? content
              .filter(
                (b): b is Record<string, unknown> =>
                  !!b &&
                  typeof b === 'object' &&
                  (b as Record<string, unknown>).type === 'text' &&
                  typeof (b as Record<string, unknown>).text === 'string',
              )
              .map((b) => b.text as string)
              .join('\n')
          : '';
        this.emit('event', {
          kind: 'jsonl-turn-end',
          text,
          stopReason: stopReason ?? null,
        } satisfies JsonlEvent);
      }
      return;
    }

    if (type === 'system') {
      const subtype = typeof entry.subtype === 'string' ? entry.subtype : '';
      // claude.exe writes init / api_error rows + an ever-growing set of
      // operational subtypes. We emit every one of them so the chat panel
      // can surface them. Subtypes we DON'T want as bubbles (init banner is
      // noise; permission-mode flips are metadata) get filtered web-side.
      if (!subtype) return;
      const level = typeof entry.level === 'string' ? entry.level : 'info';
      const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : null;
      this.emit('event', {
        kind: 'jsonl-system',
        subtype,
        level,
        message: formatSystemMessage(subtype, entry),
        timestamp,
        raw: entry,
      } satisfies JsonlEvent);
      return;
    }

    // Unknown / metadata types (permission-mode, file-history-snapshot,
    // attachment, ai-title, last-prompt, …) — drop silently. CC adds shapes
    // over time; we tolerate the unknown.
  }
}

/** Build a one-line plain-English summary of a `type: 'system'` row. Used
 *  for the chat-bubble label; the raw entry rides along so the panel can
 *  expand for the technically curious. Per [[hand-user-everything]]: this
 *  is what the user would have seen in the CLI's status line, so phrase it
 *  like a status line — short, factual, no jargon. */
function formatSystemMessage(subtype: string, entry: Record<string, unknown>): string {
  if (subtype === 'api_error') {
    const errOuter = entry.error as Record<string, unknown> | undefined;
    const status =
      errOuter && typeof errOuter.status === 'number' ? (errOuter.status as number) : null;
    // Anthropic SDK shape: error.error.error.{type,message}.
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

  // Generic fallback: surface whatever scalar fields the row carries.
  const message = typeof entry.message === 'string' ? (entry.message as string) : '';
  if (message) return `[${subtype}] ${message}`;
  return `[${subtype}]`;
}
