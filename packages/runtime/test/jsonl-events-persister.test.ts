// Section 23.1 — verifies the per-session normalized event log writer
// contract that PtySession.attachTailer wires up. The test reuses the same
// shape PtySession persists (`{ type: 'jsonl', event: <JsonlEvent> }`) so
// regressions in either side surface here first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonlTailer, type JsonlEvent } from '../src/jsonl-tailer.ts';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pc-jsonl-events-'));
}

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
}

/** Mirror PtySession.persistJsonlEvent: append the canonical envelope shape
 *  the WS broadcasts and the replay path expects. Centralised here so any
 *  drift between PtySession + persister test is caught at review. */
function persistJsonlEvent(path: string, ev: JsonlEvent): void {
  appendFileSync(path, JSON.stringify({ type: 'jsonl', event: ev }) + '\n');
}

test('tailer emits N events → jsonl-events.jsonl has N lines in canonical envelope shape', () => {
  const dir = makeTempDir();
  try {
    const sessionFile = join(dir, 'session.jsonl');
    const eventsLog = join(dir, 'jsonl-events.jsonl');

    const lines = [
      { type: 'user', message: { role: 'user', content: 'hi' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a' } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body', is_error: false }],
        },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: 'done.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 11, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
    ];
    writeFileSync(sessionFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const tailer = new JsonlTailer({ filePath: sessionFile, pollIntervalMs: 50 });
    tailer.on('event', (ev: JsonlEvent) => persistJsonlEvent(eventsLog, ev));
    tailer.start();
    tailer.stop();

    assert.ok(existsSync(eventsLog), 'jsonl-events.jsonl should exist');
    const content = readFileSync(eventsLog, 'utf-8');
    assert.ok(content.endsWith('\n'), 'each line must terminate with \\n');
    const rows = content.split('\n').filter(Boolean);

    // Expected emit set from these JSONL lines:
    //   jsonl-user, jsonl-tool-call, jsonl-usage (mid-loop assistant),
    //   jsonl-tool-result, jsonl-usage (turn-end assistant), jsonl-turn-end.
    assert.equal(rows.length, 6, 'six normalized events from four CC JSONL rows');

    const parsed = rows.map((r) => JSON.parse(r) as { type: string; event: JsonlEvent });
    for (const p of parsed) {
      assert.equal(p.type, 'jsonl', 'envelope type must be "jsonl"');
      assert.ok(p.event && typeof p.event === 'object', 'event field must be present + object');
      assert.ok('kind' in p.event, 'event must carry a kind');
    }
    const kinds = parsed.map((p) => p.event.kind);
    assert.deepEqual(kinds, [
      'jsonl-user',
      'jsonl-tool-call',
      'jsonl-usage',
      'jsonl-tool-result',
      'jsonl-usage',
      'jsonl-turn-end',
    ]);
  } finally {
    cleanup(dir);
  }
});

test('append-only: a second tailer session adds to the same log without truncation', () => {
  const dir = makeTempDir();
  try {
    const sessionFile = join(dir, 'session.jsonl');
    const eventsLog = join(dir, 'jsonl-events.jsonl');

    // First pass: one user row.
    writeFileSync(
      sessionFile,
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'first' } }) + '\n',
    );
    {
      const t = new JsonlTailer({ filePath: sessionFile, pollIntervalMs: 50 });
      t.on('event', (ev: JsonlEvent) => persistJsonlEvent(eventsLog, ev));
      t.start();
      t.stop();
    }
    const firstLines = readFileSync(eventsLog, 'utf-8').split('\n').filter(Boolean);
    assert.equal(firstLines.length, 1);

    // Second pass: a fresh tailer pointed at the same file picks up the new
    // line. (Resume seeds startLine past the already-consumed cursor; mirrors
    // PtySession's persisted cursor flow.)
    appendFileSync(
      sessionFile,
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'second' } }) + '\n',
    );
    {
      const t = new JsonlTailer({ filePath: sessionFile, startLine: 1, pollIntervalMs: 50 });
      t.on('event', (ev: JsonlEvent) => persistJsonlEvent(eventsLog, ev));
      t.start();
      t.stop();
    }

    const secondLines = readFileSync(eventsLog, 'utf-8').split('\n').filter(Boolean);
    assert.equal(secondLines.length, 2, 'append-only: original line plus new');
    const parsed = secondLines.map((r) => JSON.parse(r) as { event: { kind: string; text?: string } });
    assert.equal(parsed[0]?.event.text, 'first');
    assert.equal(parsed[1]?.event.text, 'second');
  } finally {
    cleanup(dir);
  }
});

test('malformed line in source JSONL: tailer skips → persister sees nothing for that line', () => {
  const dir = makeTempDir();
  try {
    const sessionFile = join(dir, 'session.jsonl');
    const eventsLog = join(dir, 'jsonl-events.jsonl');
    // valid · garbage · valid
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'a' } }),
        '{ not valid json',
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'b' } }),
      ].join('\n') + '\n',
    );
    const tailer = new JsonlTailer({ filePath: sessionFile, pollIntervalMs: 50 });
    tailer.on('event', (ev: JsonlEvent) => persistJsonlEvent(eventsLog, ev));
    tailer.start();
    tailer.stop();

    const rows = readFileSync(eventsLog, 'utf-8').split('\n').filter(Boolean);
    assert.equal(rows.length, 2, 'two valid lines → two persisted');
    const texts = rows.map(
      (r) => (JSON.parse(r) as { event: { kind: string; text?: string } }).event.text,
    );
    assert.deepEqual(texts, ['a', 'b']);
  } finally {
    cleanup(dir);
  }
});
