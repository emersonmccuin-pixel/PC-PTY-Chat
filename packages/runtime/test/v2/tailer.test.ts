// Section 25 Session 7 — JsonlTailerV2 contract.
//
// Pins the §7 signal set: turn-end OR rule, pause-detected event, interleaved-
// thinking fix, CC 2.1 queue protocol, setImmediate-deferred first emit.
//
// Run via:  pnpm --filter @pc/runtime test
// Or:       pnpm test:unit  (from repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonlTailerV2, type JsonlEventV2 } from '../../src/v2/tailer.ts';

function freshFile(lines: object[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'pc-tailer-v2-'));
  const path = join(dir, 'session.jsonl');
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '');
  writeFileSync(path, body, 'utf-8');
  return path;
}

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

/** Collect events from a tailer started against `filePath`. Awaits one
 *  setImmediate tick so the deferred initial drain lands before assertions. */
async function collect(
  filePath: string,
  opts: { startLine?: number } = {},
): Promise<JsonlEventV2[]> {
  const events: JsonlEventV2[] = [];
  const tailer = new JsonlTailerV2({ filePath, ...opts, pollIntervalMs: 50 });
  tailer.on('event', (e: JsonlEventV2) => events.push(e));
  tailer.start();
  await tick();
  tailer.stop();
  return events;
}

// ─── Construction discipline (§7.5) ──────────────────────────────────────

test('start() defers initial emit via setImmediate so late listeners catch up', async () => {
  const f = freshFile([{ type: 'user', message: { role: 'user', content: 'hello' } }]);
  const tailer = new JsonlTailerV2({ filePath: f, pollIntervalMs: 50 });
  tailer.start();
  // Listener attached AFTER start(), but still BEFORE the setImmediate tick.
  const events: JsonlEventV2[] = [];
  tailer.on('event', (e: JsonlEventV2) => events.push(e));
  await tick();
  tailer.stop();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'jsonl-user');
  rmSync(join(f, '..'), { recursive: true, force: true });
});

test('cursor-based resume skips prior lines', async () => {
  const f = freshFile([
    { type: 'user', message: { role: 'user', content: 'line 1' } },
    { type: 'user', message: { role: 'user', content: 'line 2' } },
    { type: 'user', message: { role: 'user', content: 'line 3' } },
  ]);
  const events = await collect(f, { startLine: 2 });
  assert.equal(events.length, 1);
  assert.equal((events[0] as { kind: string; text: string }).text, 'line 3');
  rmSync(join(f, '..'), { recursive: true, force: true });
});

// ─── Basic row mappings ──────────────────────────────────────────────────

test('sidechain entry short-circuits with jsonl-sidechain', async () => {
  const row = { isSidechain: true, type: 'assistant', message: { content: 'hidden' } };
  const f = freshFile([row]);
  const events = await collect(f);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'jsonl-sidechain');
  rmSync(join(f, '..'), { recursive: true, force: true });
});

test('user with string content → jsonl-user; carries raw row', async () => {
  const f = freshFile([{ type: 'user', message: { role: 'user', content: 'hi' } }]);
  const events = await collect(f);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'jsonl-user');
  assert.equal((events[0] as { text: string }).text, 'hi');
  assert.ok(events[0].row);
  rmSync(join(f, '..'), { recursive: true, force: true });
});

test('queue-operation enqueue + dequeue + remove → unified events', async () => {
  const f = freshFile([
    { type: 'queue-operation', operation: 'enqueue', timestamp: 't1' },
    { type: 'queue-operation', operation: 'dequeue', timestamp: 't2' },
    { type: 'queue-operation', operation: 'remove', timestamp: 't3' },
  ]);
  const events = await collect(f);
  assert.equal(events.length, 3);
  assert.equal(events[0].kind, 'jsonl-queue-enqueue');
  assert.equal(events[1].kind, 'jsonl-queue-dequeue');
  assert.equal(events[2].kind, 'jsonl-queue-dequeue'); // §7.4 — remove collapses to dequeue
  rmSync(join(f, '..'), { recursive: true, force: true });
});

test('attachment queued_command synthesizes jsonl-user from prompt field', async () => {
  const f = freshFile([
    {
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        prompt: 'queued prompt body',
      },
    },
  ]);
  const events = await collect(f);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'jsonl-user');
  assert.equal((events[0] as { text: string }).text, 'queued prompt body');
  rmSync(join(f, '..'), { recursive: true, force: true });
});

test('attachment queued_command with ContentBlockParam array collects text blocks', async () => {
  const f = freshFile([
    {
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        prompt: [
          { type: 'text', text: 'part one ' },
          { type: 'image', source: { type: 'base64', data: 'AAAA' } },
          { type: 'text', text: 'part two' },
        ],
      },
    },
  ]);
  const events = await collect(f);
  assert.equal(events.length, 1);
  assert.equal((events[0] as { text: string }).text, 'part one part two');
  rmSync(join(f, '..'), { recursive: true, force: true });
});

test('assistant tool_use block → jsonl-tool-call; user tool_result → jsonl-tool-result', async () => {
  const f = freshFile([
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/a' } },
        ],
        stop_reason: 'tool_use',
      },
    },
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: 'file contents',
          },
        ],
      },
    },
  ]);
  const events = await collect(f);
  // Expect: jsonl-tool-call, jsonl-tool-result
  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, ['jsonl-tool-call', 'jsonl-tool-result']);
  rmSync(join(f, '..'), { recursive: true, force: true });
});

test('assistant usage block emits jsonl-usage', async () => {
  const f = freshFile([
    {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'hi' }],
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
        },
        model: 'claude-opus-4-7',
        stop_reason: 'end_turn',
      },
    },
  ]);
  const events = await collect(f);
  const usage = events.find((e) => e.kind === 'jsonl-usage') as
    | { kind: 'jsonl-usage'; inputTokens: number; outputTokens: number; model: string | null }
    | undefined;
  assert.ok(usage);
  assert.equal(usage!.inputTokens, 10);
  assert.equal(usage!.outputTokens, 20);
  assert.equal(usage!.model, 'claude-opus-4-7');
  rmSync(join(f, '..'), { recursive: true, force: true });
});

// ─── Turn-end OR rule (§7.1) + interleaved-thinking fix (§7.3) ───────────

test('assistant end_turn + non-empty text → jsonl-turn-end via assistant trigger', async () => {
  const f = freshFile([
    { type: 'user', message: { role: 'user', content: 'hi' } },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'hello back' }],
        stop_reason: 'end_turn',
      },
    },
  ]);
  const events = await collect(f);
  const turnEnd = events.find((e) => e.kind === 'jsonl-turn-end') as
    | { kind: 'jsonl-turn-end'; text: string; trigger: 'assistant' | 'stop-hook' }
    | undefined;
  assert.ok(turnEnd);
  assert.equal(turnEnd!.text, 'hello back');
  assert.equal(turnEnd!.trigger, 'assistant');
});

test('interleaved-thinking: thinking-only end_turn followed by text end_turn fires ONCE on text', async () => {
  const f = freshFile([
    { type: 'user', message: { role: 'user', content: 'think' } },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'thinking', thinking: '...' }],
        stop_reason: 'end_turn',
      },
    },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'final answer' }],
        stop_reason: 'end_turn',
      },
    },
  ]);
  const events = await collect(f);
  const turnEnds = events.filter((e) => e.kind === 'jsonl-turn-end');
  assert.equal(turnEnds.length, 1);
  assert.equal((turnEnds[0] as { text: string }).text, 'final answer');
});

test('thinking-only end_turn followed by stop_hook_summary → turn-end via stop-hook (no text)', async () => {
  const f = freshFile([
    { type: 'user', message: { role: 'user', content: 'think' } },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'thinking', thinking: '...' }],
        stop_reason: 'end_turn',
      },
    },
    { type: 'system', subtype: 'stop_hook_summary' },
  ]);
  const events = await collect(f);
  const turnEnds = events.filter((e) => e.kind === 'jsonl-turn-end') as Array<{
    kind: 'jsonl-turn-end';
    text: string;
    trigger: 'assistant' | 'stop-hook';
  }>;
  assert.equal(turnEnds.length, 1);
  assert.equal(turnEnds[0].trigger, 'stop-hook');
  assert.equal(turnEnds[0].text, '');
});

test('turn-end already fired via assistant: stop_hook_summary does NOT emit second turn-end', async () => {
  const f = freshFile([
    { type: 'user', message: { role: 'user', content: 'hi' } },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
      },
    },
    { type: 'system', subtype: 'stop_hook_summary' },
  ]);
  const events = await collect(f);
  const turnEnds = events.filter((e) => e.kind === 'jsonl-turn-end');
  assert.equal(turnEnds.length, 1);
  assert.equal((turnEnds[0] as { trigger: string }).trigger, 'assistant');
});

test('user-interrupt sentinel (stop_reason: null with no text) still emits turn-end', async () => {
  const f = freshFile([
    { type: 'user', message: { role: 'user', content: 'hi' } },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'partial...' }],
        stop_reason: null,
      },
    },
  ]);
  const events = await collect(f);
  const turnEnds = events.filter((e) => e.kind === 'jsonl-turn-end') as Array<{
    kind: 'jsonl-turn-end';
    stopReason: string | null;
    trigger: 'assistant' | 'stop-hook';
  }>;
  assert.equal(turnEnds.length, 1);
  assert.equal(turnEnds[0].stopReason, null);
  assert.equal(turnEnds[0].trigger, 'assistant');
});

test('mid-loop stop_reasons (tool_use, pause_turn) do NOT emit turn-end', async () => {
  const f = freshFile([
    { type: 'user', message: { role: 'user', content: 'use tool' } },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }],
        stop_reason: 'tool_use',
      },
    },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'thinking', thinking: '...' }],
        stop_reason: 'pause_turn',
      },
    },
  ]);
  const events = await collect(f);
  const turnEnds = events.filter((e) => e.kind === 'jsonl-turn-end');
  assert.equal(turnEnds.length, 0);
});

// ─── Pause detection (§7.2) ──────────────────────────────────────────────

test('pause-detected: tool_use + tool_result + stop_hook_summary (no closing assistant text)', async () => {
  const f = freshFile([
    { type: 'user', message: { role: 'user', content: 'ask a question via tool' } },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'pq', name: 'pc_ask_orchestrator', input: { q: 'x' } }],
        stop_reason: 'tool_use',
      },
    },
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'pq', content: 'queued' }],
      },
    },
    { type: 'system', subtype: 'stop_hook_summary' },
  ]);
  const events = await collect(f);
  const pause = events.find((e) => e.kind === 'jsonl-pause-detected');
  assert.ok(pause);
  // Both pause AND turn-end (via stop-hook) fire — consumers can wire either.
  const turnEnds = events.filter((e) => e.kind === 'jsonl-turn-end') as Array<{
    trigger: string;
  }>;
  assert.equal(turnEnds.length, 1);
  assert.equal(turnEnds[0].trigger, 'stop-hook');
});

test('pause-detected does NOT fire when an assistant row continues after tool_result', async () => {
  const f = freshFile([
    { type: 'user', message: { role: 'user', content: 'do stuff' } },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
        stop_reason: 'tool_use',
      },
    },
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'data' }],
      },
    },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'here is the answer' }],
        stop_reason: 'end_turn',
      },
    },
    { type: 'system', subtype: 'stop_hook_summary' },
  ]);
  const events = await collect(f);
  const pause = events.find((e) => e.kind === 'jsonl-pause-detected');
  assert.equal(pause, undefined);
});

test('pause-detected requires the prior assistant to have stop_reason=tool_use', async () => {
  // Edge case: a user tool_result row arrives without a prior assistant having
  // ended in tool_use (malformed log). Should not arm pause-watch.
  const f = freshFile([
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'x' }],
      },
    },
    { type: 'system', subtype: 'stop_hook_summary' },
  ]);
  const events = await collect(f);
  const pause = events.find((e) => e.kind === 'jsonl-pause-detected');
  assert.equal(pause, undefined);
});

// ─── Loop independence ───────────────────────────────────────────────────

test('two sequential turns reset state independently', async () => {
  const f = freshFile([
    { type: 'user', message: { role: 'user', content: 'turn 1' } },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'one' }],
        stop_reason: 'end_turn',
      },
    },
    { type: 'system', subtype: 'stop_hook_summary' },
    { type: 'user', message: { role: 'user', content: 'turn 2' } },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'two' }],
        stop_reason: 'end_turn',
      },
    },
  ]);
  const events = await collect(f);
  const turnEnds = events.filter((e) => e.kind === 'jsonl-turn-end') as Array<{
    text: string;
    trigger: string;
  }>;
  assert.equal(turnEnds.length, 2);
  assert.equal(turnEnds[0].text, 'one');
  assert.equal(turnEnds[0].trigger, 'assistant');
  assert.equal(turnEnds[1].text, 'two');
  assert.equal(turnEnds[1].trigger, 'assistant');
});

// ─── System messages ─────────────────────────────────────────────────────

test('non-stop_hook system row passes through as jsonl-system', async () => {
  const f = freshFile([
    {
      type: 'system',
      subtype: 'api_error',
      level: 'warning',
      retryAttempt: 1,
      maxRetries: 3,
      retryInMs: 8000,
      error: {
        status: 529,
        error: { error: { type: 'overloaded_error', message: 'Overloaded' } },
      },
    },
  ]);
  const events = await collect(f);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'jsonl-system');
  const sys = events[0] as { subtype: string; message: string; level: string };
  assert.equal(sys.subtype, 'api_error');
  assert.equal(sys.level, 'warning');
  assert.match(sys.message, /Overloaded \(HTTP 529\) — retrying in 8\.0s \(attempt 1\/3\)/);
});

test('stop_hook_summary does NOT pass through as generic jsonl-system', async () => {
  // The canonical signal IS the turn-end / pause-detected; double-emitting as
  // a generic system bubble would clutter the chat panel.
  const f = freshFile([
    { type: 'user', message: { role: 'user', content: 'x' } },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
      },
    },
    { type: 'system', subtype: 'stop_hook_summary' },
  ]);
  const events = await collect(f);
  const sysEvents = events.filter((e) => e.kind === 'jsonl-system');
  assert.equal(sysEvents.length, 0);
});
