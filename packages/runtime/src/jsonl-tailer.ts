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
  | { kind: 'jsonl-turn-end'; text: string; stopReason: string }
  | { kind: 'jsonl-sidechain'; raw: unknown };

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
      } else if (op === 'dequeue') {
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
      // Turn-end fires only on stop_reason === 'end_turn'. Other stop_reasons
      // ('tool_use', 'pause_turn', 'max_tokens', etc.) mean CC is mid-loop —
      // the turn isn't actually over.
      if (message.stop_reason === 'end_turn') {
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
          stopReason: 'end_turn',
        } satisfies JsonlEvent);
      }
      return;
    }

    // Unknown / metadata types (permission-mode, file-history-snapshot,
    // attachment, ai-title, last-prompt, …) — drop silently. CC adds shapes
    // over time; we tolerate the unknown.
  }
}
