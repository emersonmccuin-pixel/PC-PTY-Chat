// Pin the ready-gate ordering invariants.
//
// Real-CC verification of the gate lives in the labs scenario port; this
// suite locks the pure logic so future edits can't regress the contract
// without a fast local signal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadyGate, type ReadyTimestamps } from '../src/ready-gate.ts';

const BRACKETED_PASTE_ON = '\x1b[?2004h';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeGate(clock = { now: 0 }): ReadyGate {
  return new ReadyGate({ now: () => clock.now });
}

async function collectReady(
  gate: ReadyGate,
  fire: () => void,
): Promise<ReadyTimestamps> {
  return new Promise<ReadyTimestamps>((resolve, reject) => {
    let settled = false;
    gate.once('ready', (ts: ReadyTimestamps) => {
      settled = true;
      resolve(ts);
    });
    gate.once('aborted', (reason: string) => {
      settled = true;
      reject(new Error(`aborted: ${reason}`));
    });
    fire();
    // setImmediate-deferred emit needs at least one tick to fire.
    setTimeout(() => {
      if (!settled) reject(new Error('ready did not fire within 50ms'));
    }, 50);
  });
}

test('fresh ordering: composer-ready → handshake → init-complete opens gate', async () => {
  const clock = { now: 0 };
  const gate = makeGate(clock);

  const ready = collectReady(gate, () => {
    clock.now = 500;
    gate.feedChunk(BRACKETED_PASTE_ON);
    clock.now = 1200;
    gate.notifyHandshake();
    clock.now = 1700;
    gate.feedChunk('Tip: /remote-control is active · Continue here\n');
  });

  const ts = await ready;
  assert.equal(ts.composerReadyAt, 500);
  assert.equal(ts.handshakeAt, 1200);
  assert.equal(ts.initCompleteAt, 1700);
  assert.equal(gate.isOpen(), true);
});

test('resume ordering: handshake → composer-ready → init-complete opens gate', async () => {
  const clock = { now: 0 };
  const gate = makeGate(clock);

  const ready = collectReady(gate, () => {
    clock.now = 800;
    gate.notifyHandshake();
    clock.now = 1300;
    gate.feedChunk(BRACKETED_PASTE_ON);
    clock.now = 1500;
    gate.feedChunk('/remote-control is active');
  });

  const ts = await ready;
  assert.equal(ts.handshakeAt, 800);
  assert.equal(ts.composerReadyAt, 1300);
  assert.equal(ts.initCompleteAt, 1500);
});

test('gate stays closed when only two of three fire', async () => {
  const gate = makeGate();
  gate.feedChunk(BRACKETED_PASTE_ON);
  gate.notifyHandshake();
  await wait(20);
  assert.equal(gate.isOpen(), false);
  assert.equal(gate.snapshot(), null);
});

test('gate can open without init-complete when remote-control is disabled', async () => {
  const clock = { now: 0 };
  const gate = new ReadyGate({
    now: () => clock.now,
    requireInitComplete: false,
  });

  const ready = collectReady(gate, () => {
    clock.now = 400;
    gate.feedChunk(BRACKETED_PASTE_ON);
    clock.now = 900;
    gate.notifyHandshake();
  });

  const ts = await ready;
  assert.equal(ts.composerReadyAt, 400);
  assert.equal(ts.handshakeAt, 900);
  assert.equal(ts.initCompleteAt, null);
});

test('gate can open without MCP handshake for historical resume sessions', async () => {
  const clock = { now: 0 };
  const gate = new ReadyGate({
    now: () => clock.now,
    requireHandshake: false,
    requireInitComplete: true,
  });

  const ready = collectReady(gate, () => {
    clock.now = 400;
    gate.feedChunk(BRACKETED_PASTE_ON);
    clock.now = 900;
    gate.feedChunk('/remote-control is active');
  });

  const ts = await ready;
  assert.equal(ts.composerReadyAt, 400);
  assert.equal(ts.handshakeAt, null);
  assert.equal(ts.initCompleteAt, 900);
});

test('init-complete substring matches resume-mode cursor-move-right painting', async () => {
  const clock = { now: 0 };
  const gate = makeGate(clock);

  // Resume mode paints with `\x1b[1C` (cursor-move-right) between words.
  // The gate normalizes these to spaces so the probe matches.
  const resumePainting =
    '/remote-control\x1b[1Cis\x1b[1Cactive\x1b[1C·\x1b[1CContinue\x1b[1Chere';

  const ready = collectReady(gate, () => {
    clock.now = 700;
    gate.notifyHandshake();
    clock.now = 1100;
    gate.feedChunk(BRACKETED_PASTE_ON);
    clock.now = 1400;
    gate.feedChunk(resumePainting);
  });

  const ts = await ready;
  assert.equal(ts.initCompleteAt, 1400);
});

test('init-complete accepts remote-control status line painting', async () => {
  const clock = { now: 0 };
  const gate = makeGate(clock);

  const ready = collectReady(gate, () => {
    clock.now = 700;
    gate.notifyHandshake();
    clock.now = 1100;
    gate.feedChunk(BRACKETED_PASTE_ON);
    clock.now = 1400;
    gate.feedChunk('Remote Control active');
  });

  const ts = await ready;
  assert.equal(ts.initCompleteAt, 1400);
});

test('init-complete accepts regular Claude composer footer without remote-control', async () => {
  const clock = { now: 0 };
  const gate = makeGate(clock);

  const ready = collectReady(gate, () => {
    clock.now = 700;
    gate.notifyHandshake();
    clock.now = 1100;
    gate.feedChunk(BRACKETED_PASTE_ON);
    clock.now = 1400;
    gate.feedChunk('bypass permissions on (shift+tab to cycle) · ← for agents');
  });

  const ts = await ready;
  assert.equal(ts.initCompleteAt, 1400);
});

test('init-complete matches across multiple chunks (substring spans buffer)', async () => {
  const clock = { now: 0 };
  const gate = makeGate(clock);

  const ready = collectReady(gate, () => {
    clock.now = 200;
    gate.feedChunk(BRACKETED_PASTE_ON);
    clock.now = 700;
    gate.notifyHandshake();
    clock.now = 1000;
    gate.feedChunk('Tip: /remote-cont');
    clock.now = 1200;
    gate.feedChunk('rol is active · resumed');
  });

  const ts = await ready;
  assert.equal(ts.initCompleteAt, 1200);
});

test('handshake notification is idempotent', async () => {
  const clock = { now: 0 };
  const gate = makeGate(clock);

  clock.now = 100;
  gate.notifyHandshake();
  clock.now = 200;
  gate.notifyHandshake(); // ignored — first wins
  clock.now = 300;
  gate.notifyHandshake();

  // Gate still needs the two stdout signals.
  assert.equal(gate.isOpen(), false);

  const ready = collectReady(gate, () => {
    clock.now = 400;
    gate.feedChunk(BRACKETED_PASTE_ON);
    clock.now = 500;
    gate.feedChunk('/remote-control is active');
  });

  const ts = await ready;
  // Handshake timestamp records the FIRST call.
  assert.equal(ts.handshakeAt, 100);
});

test('feedChunk after gate opens is a no-op (does not double-emit)', async () => {
  const gate = makeGate();
  let count = 0;
  gate.on('ready', () => count++);

  gate.notifyHandshake();
  gate.feedChunk(BRACKETED_PASTE_ON);
  gate.feedChunk('/remote-control is active');
  await wait(20);
  assert.equal(count, 1);

  gate.feedChunk('/remote-control is active again');
  gate.notifyHandshake();
  await wait(20);
  assert.equal(count, 1);
});

test('abort() rejects pending listeners and blocks future ready', async () => {
  const gate = makeGate();
  let readyFired = false;
  let abortReason: string | null = null;
  gate.on('ready', () => (readyFired = true));
  gate.on('aborted', (r: string) => (abortReason = r));

  gate.feedChunk(BRACKETED_PASTE_ON);
  gate.notifyHandshake();
  gate.abort('test');

  await wait(20);
  assert.equal(readyFired, false);
  assert.equal(abortReason, 'test');

  // Subsequent fire of the final signal does nothing.
  gate.feedChunk('/remote-control is active');
  await wait(20);
  assert.equal(readyFired, false);
});

test('listeners attached AFTER all signals fire still receive ready (setImmediate deferral)', async () => {
  const gate = makeGate();

  gate.notifyHandshake();
  gate.feedChunk(BRACKETED_PASTE_ON);
  gate.feedChunk('/remote-control is active');

  // Attach listener synchronously after the third signal — before
  // setImmediate has fired. The deferred emit should still reach us.
  const ready = new Promise<ReadyTimestamps>((resolve) =>
    gate.once('ready', resolve),
  );

  const ts = await ready;
  assert.ok(ts.handshakeAt !== null);
  assert.ok(ts.composerReadyAt !== null);
  assert.ok(ts.initCompleteAt !== null);
});

test('bracketed-paste-on substring matches even when split mid-sequence is impossible — must be in one chunk', async () => {
  // Documented constraint: the BRACKETED_PASTE_ON ANSI sequence is 8 bytes
  // (`\x1b[?2004h`). CC emits it in one write. If a future change introduces
  // chunk splitting, this contract fails — we treat that as a regression
  // requiring an explicit accumulator. This test pins the current contract.
  const gate = makeGate();
  gate.feedChunk('\x1b[?2004');
  gate.feedChunk('h');
  gate.notifyHandshake();
  gate.feedChunk('/remote-control is active');
  await wait(20);
  // Today the gate does NOT match across chunks for this signal. If this
  // assertion ever flips, we've upgraded the signal detection — update
  // accordingly.
  assert.equal(gate.isOpen(), false);
});
