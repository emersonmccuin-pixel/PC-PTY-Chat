import assert from 'node:assert/strict';
import { test } from 'node:test';

type WsEvent = {
  projectId: string;
  type: string;
  [key: string]: unknown;
};

type TerminalTranscriptModule = {
  maxTerminalSeq: (events: readonly WsEvent[], sessionId: string) => number;
  removeOverlappingPrefix: (previous: string, next: string) => string;
  terminalRawBatchFromEvents: (
    events: readonly WsEvent[],
    sessionId: string,
    afterSeq: number,
  ) => Array<{ seq: number; text: string }>;
  terminalRawFromEnvelope: (
    env: WsEvent | undefined,
    sessionId: string,
  ) => { seq: number; text: string } | null;
};

async function loadTerminalTranscriptModule(): Promise<TerminalTranscriptModule> {
  const moduleUrl = new URL('../../web/src/features/chat/terminalTranscript.ts', import.meta.url).href;
  return (await import(moduleUrl)) as TerminalTranscriptModule;
}

function raw(seq: unknown, text: unknown, sessionId = 'session-1'): WsEvent {
  return {
    projectId: 'project-1',
    type: 'raw',
    sessionId,
    terminalSeq: seq,
    text,
  };
}

test('terminal raw envelope parser accepts only matching well-formed raw envelopes', async () => {
  const { terminalRawFromEnvelope } = await loadTerminalTranscriptModule();

  assert.deepEqual(terminalRawFromEnvelope(raw(2, 'two'), 'session-1'), {
    seq: 2,
    text: 'two',
  });
  assert.equal(terminalRawFromEnvelope(undefined, 'session-1'), null);
  assert.equal(terminalRawFromEnvelope({ ...raw(3, 'three'), type: 'jsonl' }, 'session-1'), null);
  assert.equal(terminalRawFromEnvelope(raw(3, 'three', 'other-session'), 'session-1'), null);
  assert.equal(terminalRawFromEnvelope(raw(0, 'zero'), 'session-1'), null);
  assert.equal(terminalRawFromEnvelope(raw(1.25, 'fraction'), 'session-1'), null);
  assert.equal(terminalRawFromEnvelope(raw(Number.MAX_SAFE_INTEGER + 1, 'unsafe'), 'session-1'), null);
  assert.equal(terminalRawFromEnvelope(raw(4, null), 'session-1'), null);
});

test('terminal raw batch filters old rows, sorts pending rows, and dedupes seqs', async () => {
  const { terminalRawBatchFromEvents } = await loadTerminalTranscriptModule();

  const batch = terminalRawBatchFromEvents(
    [
      raw(4, 'four'),
      raw(2, 'old'),
      raw(5, 'other', 'other-session'),
      raw(3, 'three'),
      raw(4, 'four duplicate'),
      raw(6, null),
    ],
    'session-1',
    2,
  );

  assert.deepEqual(batch, [
    { seq: 3, text: 'three' },
    { seq: 4, text: 'four' },
  ]);
});

test('terminal max seq ignores malformed and unrelated envelopes', async () => {
  const { maxTerminalSeq } = await loadTerminalTranscriptModule();

  assert.equal(
    maxTerminalSeq(
      [
        raw(3, 'three'),
        raw(99, 'other', 'other-session'),
        raw(7, 'seven'),
        raw(10, null),
        { projectId: 'project-1', type: 'terminal-input-ack', ok: false },
      ],
      'session-1',
    ),
    7,
  );
});

test('terminal overlap removal trims only the live prefix already in the transcript', async () => {
  const { removeOverlappingPrefix } = await loadTerminalTranscriptModule();

  assert.equal(removeOverlappingPrefix('abc123', '123def'), 'def');
  assert.equal(removeOverlappingPrefix('abc', 'xyz'), 'xyz');
  assert.equal(removeOverlappingPrefix('', 'live'), 'live');
  assert.equal(removeOverlappingPrefix('prompt\nprompt\n', 'prompt\nmore'), 'more');
});
