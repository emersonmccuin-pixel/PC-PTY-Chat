// Unit tests for JsonlTailer — the heart of the chat reliability fix
// (docs/buildout/chat-reliability.md). The 2026-05-17 session shipped two
// bugs in the tailer/discovery layer; these tests pin the parsing contract
// so changes here can't silently regress without a fast local signal.
//
// Run via:  pnpm --filter @pc/runtime test
// Or:       pnpm test:unit  (from repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonlTailer, type JsonlEvent } from '../src/jsonl-tailer.ts';

function freshFile(lines: object[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'pc-tailer-'));
  const path = join(dir, 'session.jsonl');
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '');
  writeFileSync(path, body, 'utf-8');
  return path;
}

function cleanup(filePath: string): void {
  try { rmSync(join(filePath, '..'), { recursive: true, force: true }); } catch { /* noop */ }
}

/** Drain the tailer synchronously — start() does an initial readTail so any
 *  content already in the file lands before start() returns. */
function collect(filePath: string, opts: { startLine?: number } = {}): JsonlEvent[] {
  const events: JsonlEvent[] = [];
  const tailer = new JsonlTailer({ filePath, ...opts, pollIntervalMs: 50 });
  tailer.on('event', (e: JsonlEvent) => events.push(e));
  tailer.start();
  tailer.stop();
  return events;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────
// User / assistant / tool parsing
// ─────────────────────────────────────────────────────────────────────────

test('user message with string content → jsonl-user', () => {
  const f = freshFile([
    { type: 'user', message: { role: 'user', content: 'hi there' } },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.deepEqual(events, [{ kind: 'jsonl-user', text: 'hi there' }]);
});

test('user message with empty string content → no event', () => {
  const f = freshFile([
    { type: 'user', message: { role: 'user', content: '' } },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.equal(events.length, 0);
});

test('user message with tool_result blocks → jsonl-tool-result per block', () => {
  const f = freshFile([
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok', is_error: false },
          { type: 'tool_result', tool_use_id: 'tu_2', content: 'boom', is_error: true },
        ],
      },
    },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    kind: 'jsonl-tool-result',
    toolUseId: 'tu_1',
    result: 'ok',
    isError: false,
  });
  assert.deepEqual(events[1], {
    kind: 'jsonl-tool-result',
    toolUseId: 'tu_2',
    result: 'boom',
    isError: true,
  });
});

test('assistant message with tool_use blocks → jsonl-tool-call per block', () => {
  const f = freshFile([
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/foo' } },
          { type: 'tool_use', id: 'tu_2', name: 'Grep', input: { pattern: 'x' } },
        ],
        // stop_reason: 'tool_use' is mid-loop → no turn-end
        stop_reason: 'tool_use',
      },
    },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    kind: 'jsonl-tool-call',
    toolUseId: 'tu_1',
    name: 'Read',
    input: { file_path: '/foo' },
  });
  assert.deepEqual(events[1], {
    kind: 'jsonl-tool-call',
    toolUseId: 'tu_2',
    name: 'Grep',
    input: { pattern: 'x' },
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The four Stop-skip cases (the whole reason Section 0 exists)
// ─────────────────────────────────────────────────────────────────────────

test('assistant stop_reason: end_turn → jsonl-turn-end with extracted text', () => {
  const f = freshFile([
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'first paragraph' },
          { type: 'text', text: 'second paragraph' },
        ],
        stop_reason: 'end_turn',
      },
    },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.deepEqual(events, [
    { kind: 'jsonl-turn-end', text: 'first paragraph\nsecond paragraph', stopReason: 'end_turn' },
  ]);
});

test('assistant stop_reason: null → jsonl-turn-end (user interrupt — Stop-skip case 2)', () => {
  // Empirically observed: CC writes `stop_reason: null` when the user hits
  // Escape mid-stream. The 0c-followup phase added this case explicitly.
  const f = freshFile([
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial reply' }],
        stop_reason: null,
      },
    },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.deepEqual(events, [
    { kind: 'jsonl-turn-end', text: 'partial reply', stopReason: null },
  ]);
});

test('assistant stop_reason: max_tokens → jsonl-turn-end', () => {
  const f = freshFile([
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'cut off' }],
        stop_reason: 'max_tokens',
      },
    },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.deepEqual(events, [
    { kind: 'jsonl-turn-end', text: 'cut off', stopReason: 'max_tokens' },
  ]);
});

test('assistant stop_reason: tool_use → NO jsonl-turn-end (mid-loop)', () => {
  const f = freshFile([
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }],
        stop_reason: 'tool_use',
      },
    },
  ]);
  const events = collect(f);
  cleanup(f);
  // Tool call emitted, but no turn-end.
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, 'jsonl-tool-call');
});

test('assistant stop_reason: pause_turn → NO jsonl-turn-end (mid-loop)', () => {
  const f = freshFile([
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'thinking…' }],
        stop_reason: 'pause_turn',
      },
    },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.equal(events.length, 0);
});

test('assistant message without stop_reason field → NO jsonl-turn-end', () => {
  // Mid-stream assistant lines may land without a stop_reason field at all.
  const f = freshFile([
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'streaming…' }],
      },
    },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.equal(events.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// Usage events (Section 1 Phase 2 — status bar)
// ─────────────────────────────────────────────────────────────────────────

test('assistant message with usage → jsonl-usage with all four token counts', () => {
  const f = freshFile([
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'reply' }],
        stop_reason: 'end_turn',
        model: 'claude-opus-4-7',
        usage: {
          input_tokens: 12,
          output_tokens: 34,
          cache_creation_input_tokens: 56,
          cache_read_input_tokens: 78,
        },
      },
    },
  ]);
  const events = collect(f);
  cleanup(f);
  // Expect 2 events: jsonl-usage then jsonl-turn-end (order: usage emitted
  // before turn-end so the client has totals when the turn closes).
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    kind: 'jsonl-usage',
    inputTokens: 12,
    outputTokens: 34,
    cacheCreationTokens: 56,
    cacheReadTokens: 78,
    model: 'claude-opus-4-7',
    speed: null,
    cacheMissReason: null,
  });
  assert.equal(events[1]!.kind, 'jsonl-turn-end');
});

test('assistant message with usage on mid-loop tool_use → jsonl-usage but NO turn-end', () => {
  const f = freshFile([
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }],
        stop_reason: 'tool_use',
        model: 'claude-opus-4-7',
        usage: {
          input_tokens: 100,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 50,
        },
      },
    },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.equal(events.length, 2);
  assert.equal(events[0]!.kind, 'jsonl-tool-call');
  assert.deepEqual(events[1], {
    kind: 'jsonl-usage',
    inputTokens: 100,
    outputTokens: 5,
    cacheCreationTokens: 0,
    cacheReadTokens: 50,
    model: 'claude-opus-4-7',
    speed: null,
    cacheMissReason: null,
  });
});

test('assistant message without usage field → NO jsonl-usage', () => {
  const f = freshFile([
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'reply' }],
        stop_reason: 'end_turn',
      },
    },
  ]);
  const events = collect(f);
  cleanup(f);
  // Only the turn-end fires; no usage event.
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, 'jsonl-turn-end');
});

test('sidechain assistant entry with usage → NO jsonl-usage (short-circuit)', () => {
  // Subagent usage must NOT bleed into the orchestrator's session totals.
  const f = freshFile([
    {
      type: 'assistant',
      isSidechain: true,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'subagent reply' }],
        stop_reason: 'end_turn',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 999, output_tokens: 999 },
      },
    },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, 'jsonl-sidechain');
});

test('usage with partial fields → missing counts default to 0', () => {
  const f = freshFile([
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'x' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    },
  ]);
  const events = collect(f);
  cleanup(f);
  const usage = events.find((e) => e.kind === 'jsonl-usage');
  assert.ok(usage);
  assert.deepEqual(usage, {
    kind: 'jsonl-usage',
    inputTokens: 5,
    outputTokens: 2,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    model: null,
    speed: null,
    cacheMissReason: null,
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Queue events + sidechain + unknown types
// ─────────────────────────────────────────────────────────────────────────

test('queue-operation enqueue + dequeue → matching events', () => {
  const f = freshFile([
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-05-17T10:00:00Z' },
    { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-05-17T10:00:05Z' },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.deepEqual(events, [
    { kind: 'jsonl-queue-enqueue', timestamp: '2026-05-17T10:00:00Z' },
    { kind: 'jsonl-queue-dequeue', timestamp: '2026-05-17T10:00:05Z' },
  ]);
});

test('queue-operation remove (CC ≥2.1) collapses into jsonl-queue-dequeue', () => {
  // CC's queue manager emits `remove` when a queued command is consumed via
  // the reference/filter path (messageQueueManager.remove / removeByFilter).
  // The "queued command processed at turn-end" path fires `remove`, NOT
  // `dequeue` — both mean "this queue slot is gone" so the tailer collapses
  // them into a single jsonl-queue-dequeue envelope. Burned 2026-05-22 when
  // the queue UI never popped because the tailer ignored `remove`.
  const f = freshFile([
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-05-22T17:25:11Z' },
    { type: 'queue-operation', operation: 'remove', timestamp: '2026-05-22T17:27:16Z' },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.deepEqual(events, [
    { kind: 'jsonl-queue-enqueue', timestamp: '2026-05-22T17:25:11Z' },
    { kind: 'jsonl-queue-dequeue', timestamp: '2026-05-22T17:27:16Z' },
  ]);
});

test('attachment with queued_command surfaces as jsonl-user', () => {
  // CC persists a processed queued command as `type: "attachment"` with
  // `attachment.type === "queued_command"`. There is NO separate type:"user"
  // row for queued commands — the attachment is the only carrier of the
  // prompt body. Without surfacing it, queued messages disappear silently
  // from the chat panel even though CC processes them. Burned 2026-05-22.
  const f = freshFile([
    {
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        prompt: 'follow-up question while busy',
        commandMode: 'prompt',
      },
    },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.deepEqual(events, [
    { kind: 'jsonl-user', text: 'follow-up question while busy' },
  ]);
});

test('attachment queued_command with ContentBlockParam[] prompt extracts text', () => {
  // When the user pastes images alongside text, CC stores prompt as a
  // ContentBlockParam[] array — text blocks + image blocks. Concatenate
  // the text blocks; ignore images for chat rendering (they're not
  // bubble-renderable through this path today).
  const f = freshFile([
    {
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        prompt: [
          { type: 'text', text: 'check this screenshot:' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } },
        ],
      },
    },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.deepEqual(events, [
    { kind: 'jsonl-user', text: 'check this screenshot:' },
  ]);
});

test('attachment with non-queued_command subtype is dropped silently', () => {
  // Other attachment subtypes (deferred_tools_delta, diagnostics,
  // task_reminder, mcp_instructions_delta, skill_listing, …) are
  // metadata — not chat content. They must not surface as user bubbles.
  const f = freshFile([
    { type: 'attachment', attachment: { type: 'diagnostics', files: [] } },
    { type: 'attachment', attachment: { type: 'task_reminder', content: [] } },
    { type: 'attachment', attachment: { type: 'deferred_tools_delta', addedNames: [] } },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.deepEqual(events, []);
});

test('isSidechain: true short-circuits → only jsonl-sidechain event', () => {
  // Subagent JSONL lines have isSidechain: true. The tailer must NOT also
  // emit jsonl-user / jsonl-turn-end for them — the chat panel renders
  // them differently (Section 6's Activity panel territory).
  const sidechainEntry = {
    type: 'assistant',
    isSidechain: true,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'subagent reply' }],
      stop_reason: 'end_turn',
    },
  };
  const f = freshFile([sidechainEntry]);
  const events = collect(f);
  cleanup(f);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, 'jsonl-sidechain');
});

test('cut top-level types silently dropped', () => {
  // Cut list per Section 31: permission-mode and agent-setting stay
  // un-decoded. Attachment without a recognized subtype is dropped too.
  // ai-title and file-history-snapshot now have typed envelopes; covered in
  // the Section 31 test block below.
  const f = freshFile([
    { type: 'permission-mode', mode: 'plan' },
    { type: 'agent-setting', activeAgent: 'orchestrator' },
    { type: 'attachment', path: '/foo' },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.equal(events.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// Resilience: malformed lines, partial trailing line, cursor resume
// ─────────────────────────────────────────────────────────────────────────

test('malformed JSON line is skipped but cursor still advances', () => {
  // Write a mix: valid, malformed, valid. The malformed line must not
  // crash the tailer AND must not block the next line's emit.
  const dir = mkdtempSync(join(tmpdir(), 'pc-tailer-'));
  const path = join(dir, 'session.jsonl');
  const valid1 = JSON.stringify({ type: 'user', message: { role: 'user', content: 'first' } });
  const malformed = '{ this is not json';
  const valid2 = JSON.stringify({ type: 'user', message: { role: 'user', content: 'second' } });
  writeFileSync(path, `${valid1}\n${malformed}\n${valid2}\n`, 'utf-8');

  const events: JsonlEvent[] = [];
  const tailer = new JsonlTailer({ filePath: path, pollIntervalMs: 50 });
  tailer.on('event', (e: JsonlEvent) => events.push(e));
  tailer.start();
  tailer.stop();
  cleanup(path);

  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { kind: 'jsonl-user', text: 'first' });
  assert.deepEqual(events[1], { kind: 'jsonl-user', text: 'second' });
  // Cursor should reflect all 3 lines consumed (including the malformed one).
  assert.equal(tailer.getCursor(), 3);
});

test('partial trailing line held until newline lands', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-tailer-'));
  const path = join(dir, 'session.jsonl');
  // Write a complete line + the start of a second with no trailing newline.
  const complete = JSON.stringify({ type: 'user', message: { role: 'user', content: 'one' } });
  const partial = JSON.stringify({ type: 'user', message: { role: 'user', content: 'two' } });
  writeFileSync(path, `${complete}\n${partial.slice(0, 30)}`, 'utf-8');

  const events: JsonlEvent[] = [];
  const tailer = new JsonlTailer({ filePath: path, pollIntervalMs: 50 });
  tailer.on('event', (e: JsonlEvent) => events.push(e));
  tailer.start();

  // Only the complete line should have emitted.
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { kind: 'jsonl-user', text: 'one' });

  // Now finish the partial line + add a newline. Wait for the poll.
  appendFileSync(path, `${partial.slice(30)}\n`, 'utf-8');
  await wait(250);
  tailer.stop();
  cleanup(path);

  assert.equal(events.length, 2);
  assert.deepEqual(events[1], { kind: 'jsonl-user', text: 'two' });
});

test('startLine resumes past persisted cursor — earlier lines NOT re-emitted', () => {
  const f = freshFile([
    { type: 'user', message: { role: 'user', content: 'one' } },
    { type: 'user', message: { role: 'user', content: 'two' } },
    { type: 'user', message: { role: 'user', content: 'three' } },
  ]);
  const events = collect(f, { startLine: 2 });
  cleanup(f);
  // Only line index 2 ("three") should emit.
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { kind: 'jsonl-user', text: 'three' });
});

test('getCursor() reflects total complete lines consumed', () => {
  const f = freshFile([
    { type: 'user', message: { role: 'user', content: 'one' } },
    { type: 'user', message: { role: 'user', content: 'two' } },
  ]);
  const tailer = new JsonlTailer({ filePath: f, pollIntervalMs: 50 });
  tailer.start();
  tailer.stop();
  cleanup(f);
  assert.equal(tailer.getCursor(), 2);
});

test('appended lines after start() are picked up by the watcher', async () => {
  const f = freshFile([
    { type: 'user', message: { role: 'user', content: 'first' } },
  ]);
  const events: JsonlEvent[] = [];
  const tailer = new JsonlTailer({ filePath: f, pollIntervalMs: 50 });
  tailer.on('event', (e: JsonlEvent) => events.push(e));
  tailer.start();
  assert.equal(events.length, 1);

  // Append a second line; the watchFile poll should pick it up.
  appendFileSync(
    f,
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'second' } }) + '\n',
    'utf-8',
  );
  await wait(250);
  tailer.stop();
  cleanup(f);

  assert.equal(events.length, 2);
  assert.deepEqual(events[1], { kind: 'jsonl-user', text: 'second' });
});

test('stop() is idempotent — safe to call twice', () => {
  const f = freshFile([]);
  const tailer = new JsonlTailer({ filePath: f, pollIntervalMs: 50 });
  tailer.start();
  tailer.stop();
  tailer.stop();
  cleanup(f);
  // No assertion — the test passes if no error is thrown.
});

test('start() is idempotent — safe to call twice', () => {
  const f = freshFile([
    { type: 'user', message: { role: 'user', content: 'once' } },
  ]);
  const events: JsonlEvent[] = [];
  const tailer = new JsonlTailer({ filePath: f, pollIntervalMs: 50 });
  tailer.on('event', (e: JsonlEvent) => events.push(e));
  tailer.start();
  tailer.start();
  tailer.stop();
  cleanup(f);
  // The line is emitted exactly once — the second start() is a no-op.
  assert.equal(events.length, 1);
});

test('missing file → no events, no error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-tailer-'));
  const missing = join(dir, 'never-existed.jsonl');
  const events: JsonlEvent[] = [];
  const errors: Error[] = [];
  const tailer = new JsonlTailer({ filePath: missing, pollIntervalMs: 50 });
  tailer.on('event', (e: JsonlEvent) => events.push(e));
  tailer.on('error', (e: Error) => errors.push(e));
  tailer.start();
  tailer.stop();
  rmSync(dir, { recursive: true, force: true });
  assert.equal(events.length, 0);
  assert.equal(errors.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// System messages (2026-05-19 — surface CC's status-line errors in chat)
// ─────────────────────────────────────────────────────────────────────────

test('system api_error (overloaded) → jsonl-system with formatted retry status', () => {
  const f = freshFile([
    {
      type: 'system',
      subtype: 'api_error',
      level: 'error',
      timestamp: '2026-05-19T14:47:04.192Z',
      error: {
        status: 529,
        error: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      },
      retryInMs: 8608.6,
      retryAttempt: 5,
      maxRetries: 10,
    },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.ok(ev && ev.kind === 'jsonl-system');
  if (ev.kind !== 'jsonl-system') throw new Error('narrowing');
  assert.equal(ev.subtype, 'api_error');
  assert.equal(ev.level, 'error');
  assert.equal(ev.timestamp, '2026-05-19T14:47:04.192Z');
  assert.equal(
    ev.message,
    'Overloaded (HTTP 529) — retrying in 8.6s (attempt 5/10)',
  );
});

test('system api_error without retry metadata → message keeps the http status', () => {
  const f = freshFile([
    {
      type: 'system',
      subtype: 'api_error',
      level: 'error',
      error: {
        status: 401,
        error: { type: 'error', error: { type: 'authentication_error', message: 'invalid auth' } },
      },
    },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.equal(events.length, 1);
  const ev = events[0];
  if (!ev || ev.kind !== 'jsonl-system') throw new Error('expected jsonl-system');
  assert.equal(ev.message, 'invalid auth (HTTP 401)');
});

test('system init → jsonl-system with cwd in message', () => {
  const f = freshFile([
    { type: 'system', subtype: 'init', level: 'info', cwd: 'E:\temp\pc-p-test\project-b' },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.equal(events.length, 1);
  const ev = events[0];
  if (!ev || ev.kind !== 'jsonl-system') throw new Error('expected jsonl-system');
  assert.equal(ev.subtype, 'init');
  assert.match(ev.message, /Session started — cwd /);
});

test('system row with unknown subtype → generic fallback message', () => {
  const f = freshFile([
    { type: 'system', subtype: 'permission_mode_changed', level: 'info', message: 'plan → bypass' },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.equal(events.length, 1);
  const ev = events[0];
  if (!ev || ev.kind !== 'jsonl-system') throw new Error('expected jsonl-system');
  assert.equal(ev.subtype, 'permission_mode_changed');
  assert.equal(ev.message, '[permission_mode_changed] plan → bypass');
});

test('system row without subtype → no event (drop silently)', () => {
  const f = freshFile([{ type: 'system', level: 'info' }]);
  const events = collect(f);
  cleanup(f);
  assert.equal(events.length, 0);
});

test('system row carries raw entry through for the debug-expand surface', () => {
  const raw = {
    type: 'system',
    subtype: 'api_error',
    level: 'error',
    error: { status: 529, error: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } },
    retryInMs: 1000,
    retryAttempt: 1,
    maxRetries: 10,
    weirdField: 'should survive',
  };
  const f = freshFile([raw]);
  const events = collect(f);
  cleanup(f);
  const ev = events[0];
  if (!ev || ev.kind !== 'jsonl-system') throw new Error('expected jsonl-system');
  const r = ev.raw as Record<string, unknown>;
  assert.equal(r.weirdField, 'should survive');
});

// ─────────────────────────────────────────────────────────────────────────
// Section 31 — kept JSONL signals get typed envelopes (firehose principle)
// ─────────────────────────────────────────────────────────────────────────

test('Section 31 — ai-title with aiTitle field (real CC shape) emits jsonl-ai-title', () => {
  // CC writes ai-title rows as `{type: 'ai-title', aiTitle: '...', sessionId: '...'}`
  // — verified 2026-05-25 against live JSONL. The original 31.1 fixture used
  // `title:` which doesn't match production; both are accepted now.
  const f = freshFile([
    { type: 'ai-title', aiTitle: 'Continue previous coding session', sessionId: 'abc' },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.deepEqual(events, [
    { kind: 'jsonl-ai-title', title: 'Continue previous coding session' },
  ]);
});

test('Section 31 — ai-title with title fallback still works', () => {
  const f = freshFile([{ type: 'ai-title', title: 'Section 31 building' }]);
  const events = collect(f);
  cleanup(f);
  assert.deepEqual(events, [{ kind: 'jsonl-ai-title', title: 'Section 31 building' }]);
});

test('Section 31 — ai-title with empty title drops silently', () => {
  const f = freshFile([
    { type: 'ai-title', aiTitle: '' },
    { type: 'ai-title', title: '' },
    { type: 'ai-title' },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.equal(events.length, 0);
});

test('Section 31 — last-prompt emits internal jsonl-last-prompt', () => {
  const f = freshFile([{ type: 'last-prompt', uuid: 'msg_42' }]);
  const events = collect(f);
  cleanup(f);
  assert.equal(events.length, 1);
  const ev = events[0]!;
  if (ev.kind !== 'jsonl-last-prompt') throw new Error('expected jsonl-last-prompt');
  assert.equal(ev.uuid, 'msg_42');
});

test('Section 31 — file-history-snapshot emits internal jsonl-file-history', () => {
  const f = freshFile([{ type: 'file-history-snapshot', snapshotId: 'snap_7', files: [] }]);
  const events = collect(f);
  cleanup(f);
  assert.equal(events.length, 1);
  const ev = events[0]!;
  if (ev.kind !== 'jsonl-file-history') throw new Error('expected jsonl-file-history');
  assert.equal(ev.snapshotId, 'snap_7');
});

test('Section 31 — bridge-session emits jsonl-bridge-session', () => {
  const f = freshFile([{ type: 'bridge-session', bridgeSessionId: 'bridge_abc' }]);
  const events = collect(f);
  cleanup(f);
  assert.equal(events.length, 1);
  const ev = events[0]!;
  if (ev.kind !== 'jsonl-bridge-session') throw new Error('expected jsonl-bridge-session');
  assert.equal(ev.bridgeSessionId, 'bridge_abc');
});

test('Section 31 — tool_progress emits jsonl-tool-progress with elapsed seconds', () => {
  const f = freshFile([
    {
      type: 'tool_progress',
      tool_use_id: 'tu_long',
      tool_name: 'Bash',
      parent_tool_use_id: null,
      elapsed_time_seconds: 12.4,
      task_id: 'task_99',
    },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.equal(events.length, 1);
  const ev = events[0]!;
  if (ev.kind !== 'jsonl-tool-progress') throw new Error('expected jsonl-tool-progress');
  assert.equal(ev.toolUseId, 'tu_long');
  assert.equal(ev.toolName, 'Bash');
  assert.equal(ev.elapsedSeconds, 12.4);
  assert.equal(ev.taskId, 'task_99');
});

test('Section 31 — stream_event emits jsonl-stream-event with the raw event', () => {
  const inner = { type: 'content_block_delta', delta: { type: 'text_delta', text: 'p' } };
  const f = freshFile([{ type: 'stream_event', event: inner, parent_tool_use_id: null }]);
  const events = collect(f);
  cleanup(f);
  assert.equal(events.length, 1);
  const ev = events[0]!;
  if (ev.kind !== 'jsonl-stream-event') throw new Error('expected jsonl-stream-event');
  assert.deepEqual(ev.event, inner);
});

test('Section 31 — system session_state_changed emits BOTH jsonl-session-state AND jsonl-system', () => {
  // Typed envelope drives composer + inline divider; generic system row stays
  // for legacy consumers + the "expand for raw" surface.
  const f = freshFile([
    {
      type: 'system',
      subtype: 'session_state_changed',
      level: 'info',
      state: 'requires_action',
      permissionMode: 'default',
      timestamp: '2026-05-25T16:00:00Z',
    },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.equal(events.length, 2);
  const typed = events.find((e) => e.kind === 'jsonl-session-state');
  if (!typed || typed.kind !== 'jsonl-session-state') throw new Error('missing typed envelope');
  assert.equal(typed.state, 'requires_action');
  assert.equal(typed.permissionMode, 'default');
  const generic = events.find((e) => e.kind === 'jsonl-system');
  assert.ok(generic && generic.kind === 'jsonl-system' && generic.subtype === 'session_state_changed');
});

test('Section 31 — system session_state_changed without state drops typed envelope but keeps generic', () => {
  const f = freshFile([
    { type: 'system', subtype: 'session_state_changed', level: 'info' },
  ]);
  const events = collect(f);
  cleanup(f);
  // Only the generic jsonl-system fires; typed envelope drops because state
  // was missing.
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, 'jsonl-system');
});

test('Section 31 — system compact_boundary emits jsonl-compact with metadata', () => {
  const f = freshFile([
    {
      type: 'system',
      subtype: 'compact_boundary',
      level: 'info',
      compactMetadata: {
        trigger: 'manual',
        preTokens: 145000,
        messagesSummarized: 40,
        userContext: 'long thread',
      },
      logicalParentUuid: 'uuid_abc',
    },
  ]);
  const events = collect(f);
  cleanup(f);
  assert.equal(events.length, 2);
  const compact = events.find((e) => e.kind === 'jsonl-compact');
  if (!compact || compact.kind !== 'jsonl-compact') throw new Error('expected jsonl-compact');
  assert.equal(compact.trigger, 'manual');
  assert.equal(compact.preTokens, 145000);
  assert.equal(compact.messagesSummarized, 40);
});

test('Section 31 — system microcompact_boundary emits jsonl-microcompact', () => {
  const f = freshFile([
    {
      type: 'system',
      subtype: 'microcompact_boundary',
      level: 'info',
      microcompactMetadata: {
        trigger: 'auto',
        preTokens: 80000,
        tokensSaved: 12000,
        compactedToolIds: ['tu_1', 'tu_2'],
      },
    },
  ]);
  const events = collect(f);
  cleanup(f);
  const micro = events.find((e) => e.kind === 'jsonl-microcompact');
  if (!micro || micro.kind !== 'jsonl-microcompact') throw new Error('expected jsonl-microcompact');
  assert.equal(micro.tokensSaved, 12000);
  assert.equal(micro.preTokens, 80000);
});

test('Section 31 — system turn_duration emits jsonl-turn-duration', () => {
  const f = freshFile([
    {
      type: 'system',
      subtype: 'turn_duration',
      level: 'info',
      durationMs: 4275,
      budgetTokens: 200000,
      messageCount: 18,
    },
  ]);
  const events = collect(f);
  cleanup(f);
  const td = events.find((e) => e.kind === 'jsonl-turn-duration');
  if (!td || td.kind !== 'jsonl-turn-duration') throw new Error('expected jsonl-turn-duration');
  assert.equal(td.durationMs, 4275);
  assert.equal(td.messageCount, 18);
});

test('Section 31 — system post_turn_summary emits jsonl-post-turn-summary', () => {
  const f = freshFile([
    {
      type: 'system',
      subtype: 'post_turn_summary',
      level: 'info',
      summarizes_uuid: 'msg_abc',
      status_category: 'in_progress',
      status_detail: 'tool_use',
      is_noteworthy: true,
      title: 'Refactor work',
      description: 'Touched 3 files',
      recent_action: 'Edit',
      needs_action: false,
      artifact_urls: ['file:///foo'],
    },
  ]);
  const events = collect(f);
  cleanup(f);
  const ps = events.find((e) => e.kind === 'jsonl-post-turn-summary');
  if (!ps || ps.kind !== 'jsonl-post-turn-summary') throw new Error('expected jsonl-post-turn-summary');
  assert.equal(ps.title, 'Refactor work');
  assert.equal(ps.statusCategory, 'in_progress');
  assert.equal(ps.isNoteworthy, true);
  assert.equal(ps.needsAction, false);
});

test('Section 31 — system memory_saved formats writtenPaths into the message', () => {
  const f = freshFile([
    {
      type: 'system',
      subtype: 'memory_saved',
      level: 'info',
      writtenPaths: ['feedback_x.md', 'feedback_y.md'],
    },
  ]);
  const events = collect(f);
  cleanup(f);
  const ev = events[0]!;
  if (ev.kind !== 'jsonl-system') throw new Error('expected jsonl-system');
  assert.match(ev.message, /Saved 2 entries to memory/);
});

test('Section 31 — system files_persisted formats counts into the message', () => {
  const f = freshFile([
    {
      type: 'system',
      subtype: 'files_persisted',
      level: 'info',
      files: [{ filename: 'a.md' }, { filename: 'b.md' }, { filename: 'c.md' }],
      failed: [{ filename: 'd.md', error: 'EACCES' }],
    },
  ]);
  const events = collect(f);
  cleanup(f);
  const ev = events[0]!;
  if (ev.kind !== 'jsonl-system') throw new Error('expected jsonl-system');
  assert.equal(ev.message, 'Wrote 3 files (1 failed)');
});

test('Section 31 — system api_retry formats attempt + delay like api_error', () => {
  const f = freshFile([
    {
      type: 'system',
      subtype: 'api_retry',
      level: 'warn',
      attempt: 2,
      max_retries: 10,
      retry_delay_ms: 4000,
      error_status: 529,
      error: 'Overloaded',
    },
  ]);
  const events = collect(f);
  cleanup(f);
  const ev = events[0]!;
  if (ev.kind !== 'jsonl-system') throw new Error('expected jsonl-system');
  assert.equal(ev.message, 'Overloaded (HTTP 529) — retrying in 4.0s (attempt 2/10)');
});

test('Section 31 — usage carries speed + cacheMissReason when present', () => {
  const f = freshFile([
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'x' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          speed: 'slow',
        },
        diagnostics: {
          cache_miss_reason: 'tools_changed',
        },
      },
    },
  ]);
  const events = collect(f);
  cleanup(f);
  const usage = events.find((e) => e.kind === 'jsonl-usage');
  if (!usage || usage.kind !== 'jsonl-usage') throw new Error('expected jsonl-usage');
  assert.equal(usage.speed, 'slow');
  assert.equal(usage.cacheMissReason, 'tools_changed');
});
