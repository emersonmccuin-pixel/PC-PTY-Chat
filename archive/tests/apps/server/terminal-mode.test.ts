import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  forwardTerminalInput,
  normalizeTerminalTranscriptTailBytes,
  readTerminalTranscriptTail,
  TERMINAL_INPUT_MAX_BYTES,
  TERMINAL_TRANSCRIPT_MAX_TAIL_BYTES,
} from '../src/services/terminal-mode.ts';

test('terminal-input forwards bounded raw strings to a live PTY only', () => {
  const writes: string[] = [];
  const runtime = {
    ptySession: () => ({
      writeRaw(bytes: string) {
        writes.push(bytes);
        return true;
      },
    }),
  };

  assert.deepEqual(forwardTerminalInput(runtime, '/help\r'), {
    ok: true,
    bytesWritten: 6,
  });
  assert.deepEqual(writes, ['/help\r']);
});

test('terminal-input rejects invalid, oversized, and absent-PTY input without enqueueing', () => {
  const noPty = forwardTerminalInput({ ptySession: () => null }, 'abc');
  assert.equal(noPty.ok, false);
  if (!noPty.ok) assert.equal(noPty.status, 'no-session');

  const invalid = forwardTerminalInput({ ptySession: () => null }, 42);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.status, 'invalid-message');

  const oversized = forwardTerminalInput(
    { ptySession: () => ({ writeRaw: () => true }) },
    'x'.repeat(TERMINAL_INPUT_MAX_BYTES + 1),
  );
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.status, 'invalid-message');
});

test('terminal transcript tail reads only the requested session transcript', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-terminal-transcript-'));
  try {
    const projectData = resolve(root, 'projects', 'p1');
    const sessionDir = resolve(projectData, 'sessions', 's1');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(resolve(sessionDir, 'transcript.log'), '0123456789');

    const result = readTerminalTranscriptTail({
      projectId: 'p1',
      sessionId: 's1',
      session: { id: 's1', projectId: 'p1' },
      runtime: {
        dataPath: projectData,
        sessionDataPath: (sessionId) => resolve(projectData, 'sessions', sessionId),
      },
      tailBytes: 4,
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.bytes, '6789');
      assert.equal(result.truncated, true);
      assert.equal(typeof result.mtimeMs, 'number');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('terminal transcript returns empty bytes for a missing transcript', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-terminal-transcript-missing-'));
  try {
    const projectData = resolve(root, 'projects', 'p1');
    mkdirSync(resolve(projectData, 'sessions', 's1'), { recursive: true });
    const result = readTerminalTranscriptTail({
      projectId: 'p1',
      sessionId: 's1',
      session: { id: 's1', projectId: 'p1' },
      runtime: {
        dataPath: projectData,
        sessionDataPath: (sessionId) => resolve(projectData, 'sessions', sessionId),
      },
      tailBytes: 100,
    });
    assert.deepEqual(result, {
      ok: true,
      sessionId: 's1',
      bytes: '',
      truncated: false,
      mtimeMs: null,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('terminal transcript verifies project ownership and path containment', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-terminal-transcript-containment-'));
  try {
    const projectData = resolve(root, 'projects', 'p1');
    const outside = resolve(root, 'outside');
    mkdirSync(outside, { recursive: true });

    const wrongProject = readTerminalTranscriptTail({
      projectId: 'p1',
      sessionId: 's1',
      session: { id: 's1', projectId: 'p2' },
      runtime: {
        dataPath: projectData,
        sessionDataPath: () => resolve(projectData, 'sessions', 's1'),
      },
      tailBytes: 100,
    });
    assert.equal(wrongProject.ok, false);
    if (!wrongProject.ok) assert.equal(wrongProject.status, 404);

    const escaped = readTerminalTranscriptTail({
      projectId: 'p1',
      sessionId: 's1',
      session: { id: 's1', projectId: 'p1' },
      runtime: {
        dataPath: projectData,
        sessionDataPath: () => outside,
      },
      tailBytes: 100,
    });
    assert.equal(escaped.ok, false);
    if (!escaped.ok) assert.equal(escaped.status, 400);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('terminal transcript tail byte parsing is capped', () => {
  assert.equal(normalizeTerminalTranscriptTailBytes(undefined), TERMINAL_TRANSCRIPT_MAX_TAIL_BYTES);
  assert.equal(normalizeTerminalTranscriptTailBytes('-1'), 0);
  assert.equal(
    normalizeTerminalTranscriptTailBytes(String(TERMINAL_TRANSCRIPT_MAX_TAIL_BYTES + 999)),
    TERMINAL_TRANSCRIPT_MAX_TAIL_BYTES,
  );
});
