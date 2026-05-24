// Section 23.10 — D39 smoke gate. Asserts the loadSessionReplayEnvelopes
// helper produces the correct envelope shapes for both new-path
// (jsonl-events.jsonl, written by the JSONL tailer) and legacy-fallback
// (events.jsonl, written by the pre-23 hook) sources. Together these
// cover the contract the WS replay + Sessions tab past-replay endpoints
// depend on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadSessionReplayEnvelopes } from '../src/services/session-replay.ts';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pc-session-replay-'));
}
function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
}

test('new path: jsonl-events.jsonl present → returns {type:"jsonl", event} envelopes', () => {
  const dir = makeTempDir();
  try {
    const file = join(dir, 'jsonl-events.jsonl');
    // Write the same canonical envelope shape PtySession.persistJsonlEvent emits.
    const events = [
      { type: 'jsonl', event: { kind: 'jsonl-user', text: 'hello' } },
      {
        type: 'jsonl',
        event: { kind: 'jsonl-tool-call', toolUseId: 't1', name: 'Read', input: { file: 'a' } },
      },
      {
        type: 'jsonl',
        event: { kind: 'jsonl-tool-result', toolUseId: 't1', result: 'ok', isError: false },
      },
      {
        type: 'jsonl',
        event: { kind: 'jsonl-turn-end', text: 'done', stopReason: 'end_turn' },
      },
    ];
    writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const got = loadSessionReplayEnvelopes(dir);
    assert.equal(got.length, 4);
    for (let i = 0; i < got.length; i++) {
      assert.equal(got[i]?.type, 'jsonl');
      assert.deepEqual(got[i]?.event, events[i]?.event);
    }
  } finally { cleanup(dir); }
});

test('legacy fallback: only events.jsonl present → returns {type:"event", event} envelopes', () => {
  const dir = makeTempDir();
  try {
    const file = join(dir, 'events.jsonl');
    // Legacy hook-written shape — single JSON event per line, no wrapper.
    const events = [
      { kind: 'user', text: 'legacy prompt' },
      { kind: 'assistant', text: 'legacy reply', transcriptPath: null },
    ];
    writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const got = loadSessionReplayEnvelopes(dir);
    assert.equal(got.length, 2);
    assert.equal(got[0]?.type, 'event');
    assert.deepEqual(got[0]?.event, events[0]);
    assert.equal(got[1]?.type, 'event');
    assert.deepEqual(got[1]?.event, events[1]);
  } finally { cleanup(dir); }
});

test('prefer new path when both files exist', () => {
  const dir = makeTempDir();
  try {
    writeFileSync(
      join(dir, 'events.jsonl'),
      JSON.stringify({ kind: 'user', text: 'from-legacy' }) + '\n',
    );
    writeFileSync(
      join(dir, 'jsonl-events.jsonl'),
      JSON.stringify({ type: 'jsonl', event: { kind: 'jsonl-user', text: 'from-new' } }) + '\n',
    );

    const got = loadSessionReplayEnvelopes(dir);
    assert.equal(got.length, 1);
    assert.equal(got[0]?.type, 'jsonl');
    assert.deepEqual(got[0]?.event, { kind: 'jsonl-user', text: 'from-new' });
  } finally { cleanup(dir); }
});

test('missing both files → empty array', () => {
  const dir = makeTempDir();
  try {
    assert.deepEqual(loadSessionReplayEnvelopes(dir), []);
  } finally { cleanup(dir); }
});

test('malformed lines in jsonl-events.jsonl are skipped, valid lines pass through', () => {
  const dir = makeTempDir();
  try {
    const file = join(dir, 'jsonl-events.jsonl');
    appendFileSync(
      file,
      JSON.stringify({ type: 'jsonl', event: { kind: 'jsonl-user', text: 'first' } }) + '\n',
    );
    appendFileSync(file, '{ malformed json\n');
    appendFileSync(
      file,
      JSON.stringify({ type: 'jsonl', event: { kind: 'jsonl-user', text: 'second' } }) + '\n',
    );

    const got = loadSessionReplayEnvelopes(dir);
    assert.equal(got.length, 2);
    assert.deepEqual(got[0]?.event, { kind: 'jsonl-user', text: 'first' });
    assert.deepEqual(got[1]?.event, { kind: 'jsonl-user', text: 'second' });
  } finally { cleanup(dir); }
});

test('jsonl-events.jsonl rows without the proper envelope shape are ignored', () => {
  const dir = makeTempDir();
  try {
    const file = join(dir, 'jsonl-events.jsonl');
    // Mix valid envelopes with rows that don't match the contract.
    appendFileSync(file, JSON.stringify({ type: 'event', event: { kind: 'user' } }) + '\n');
    appendFileSync(file, JSON.stringify({ type: 'jsonl' }) + '\n'); // missing event
    appendFileSync(file, JSON.stringify({ type: 'jsonl', event: 'not-an-object' }) + '\n');
    appendFileSync(
      file,
      JSON.stringify({ type: 'jsonl', event: { kind: 'jsonl-user', text: 'good' } }) + '\n',
    );

    const got = loadSessionReplayEnvelopes(dir);
    assert.equal(got.length, 1);
    assert.deepEqual(got[0]?.event, { kind: 'jsonl-user', text: 'good' });
  } finally { cleanup(dir); }
});

test('malformed lines in legacy events.jsonl are skipped', () => {
  const dir = makeTempDir();
  try {
    const file = join(dir, 'events.jsonl');
    appendFileSync(file, JSON.stringify({ kind: 'user', text: 'first' }) + '\n');
    appendFileSync(file, '{ bad\n');
    appendFileSync(file, JSON.stringify({ kind: 'user', text: 'second' }) + '\n');

    const got = loadSessionReplayEnvelopes(dir);
    assert.equal(got.length, 2);
    assert.deepEqual(got[0]?.event, { kind: 'user', text: 'first' });
    assert.deepEqual(got[1]?.event, { kind: 'user', text: 'second' });
  } finally { cleanup(dir); }
});
