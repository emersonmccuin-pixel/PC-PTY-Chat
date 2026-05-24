// Pin the cap + FIFO contract of AgentRunRegistry.
//
// The registry has no PTY / IO concerns — pure scheduling logic. These
// tests lock the under-cap admit, over-cap blocking, FIFO order on
// release, and abort/withdraw paths so future edits can't regress the
// labs-validated cap of 5 without a fast local signal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunRegistry } from '../src/agent-run-registry.ts';

const wait = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

test('admits under cap immediately', async () => {
  const r = new AgentRunRegistry({ maxConcurrent: 3 });
  const t1 = r.admit();
  const t2 = r.admit();
  const t3 = r.admit();
  await Promise.all([t1.granted, t2.granted, t3.granted]);
  assert.equal(t1.state, 'admitted');
  assert.equal(t2.state, 'admitted');
  assert.equal(t3.state, 'admitted');
  assert.equal(r.getActiveCount(), 3);
  assert.equal(r.getQueueLength(), 0);
});

test('blocks over cap; release dequeues head FIFO', async () => {
  const r = new AgentRunRegistry({ maxConcurrent: 2 });
  const t1 = r.admit();
  const t2 = r.admit();
  const t3 = r.admit();
  const t4 = r.admit();
  await Promise.all([t1.granted, t2.granted]);
  assert.equal(t3.state, 'queued');
  assert.equal(t4.state, 'queued');
  assert.equal(r.getQueueLength(), 2);

  // FIFO: releasing t1 admits t3, not t4.
  t1.release();
  await t3.granted;
  assert.equal(t3.state, 'admitted');
  assert.equal(t4.state, 'queued');

  t2.release();
  await t4.granted;
  assert.equal(t4.state, 'admitted');
  assert.equal(r.getActiveCount(), 2);
  assert.equal(r.getQueueLength(), 0);
});

test('release is idempotent', async () => {
  const r = new AgentRunRegistry({ maxConcurrent: 1 });
  const t1 = r.admit();
  await t1.granted;
  t1.release();
  t1.release();
  t1.release();
  assert.equal(r.getActiveCount(), 0);
});

test('abort removes queued ticket without consuming a slot', async () => {
  const r = new AgentRunRegistry({ maxConcurrent: 1 });
  const t1 = r.admit();
  const t2 = r.admit();
  const t3 = r.admit();
  await t1.granted;
  assert.equal(t2.state, 'queued');
  assert.equal(t3.state, 'queued');

  // Abort t2 while queued. t1 still holds the only slot.
  let t2Rejected = false;
  t2.granted.catch(() => {
    t2Rejected = true;
  });
  t2.abort();
  await wait(0);
  assert.equal(t2.state, 'aborted');
  assert.equal(t2Rejected, true);
  assert.equal(r.getQueueLength(), 1);

  // Releasing t1 should now admit t3 (not the aborted t2).
  t1.release();
  await t3.granted;
  assert.equal(t3.state, 'admitted');
});

test('abort on admitted ticket releases the slot', async () => {
  const r = new AgentRunRegistry({ maxConcurrent: 1 });
  const t1 = r.admit();
  const t2 = r.admit();
  await t1.granted;
  assert.equal(t2.state, 'queued');

  // Aborting an admitted ticket = release.
  t1.abort();
  await t2.granted;
  assert.equal(t1.state, 'released');
  assert.equal(t2.state, 'admitted');
});

test('clamps maxConcurrent to [1, 50]', () => {
  assert.equal(new AgentRunRegistry({ maxConcurrent: 0 }).getMaxConcurrent(), 1);
  assert.equal(
    new AgentRunRegistry({ maxConcurrent: -5 }).getMaxConcurrent(),
    1,
  );
  assert.equal(
    new AgentRunRegistry({ maxConcurrent: 100 }).getMaxConcurrent(),
    50,
  );
  assert.equal(new AgentRunRegistry({ maxConcurrent: 7 }).getMaxConcurrent(), 7);
  assert.equal(new AgentRunRegistry().getMaxConcurrent(), 5);
  // Truncation: 3.7 → 3.
  assert.equal(new AgentRunRegistry({ maxConcurrent: 3.7 }).getMaxConcurrent(), 3);
});

test('multiple waiters get admitted in FIFO order on multiple releases', async () => {
  const r = new AgentRunRegistry({ maxConcurrent: 2 });
  const t1 = r.admit();
  const t2 = r.admit();
  const t3 = r.admit();
  const t4 = r.admit();
  const t5 = r.admit();
  await Promise.all([t1.granted, t2.granted]);
  assert.equal(r.getQueueLength(), 3);

  t1.release();
  t2.release();
  await Promise.all([t3.granted, t4.granted]);
  assert.equal(t3.state, 'admitted');
  assert.equal(t4.state, 'admitted');
  assert.equal(t5.state, 'queued');
  assert.equal(r.getActiveCount(), 2);
  assert.equal(r.getQueueLength(), 1);
});

test('admitted ticket release while queue is empty is a clean no-op-after', async () => {
  const r = new AgentRunRegistry({ maxConcurrent: 2 });
  const t1 = r.admit();
  await t1.granted;
  t1.release();
  assert.equal(r.getActiveCount(), 0);
  assert.equal(r.getQueueLength(), 0);

  // Fresh admit after queue drains works.
  const t2 = r.admit();
  await t2.granted;
  assert.equal(t2.state, 'admitted');
});

test('abort-on-queued ticket is idempotent', async () => {
  const r = new AgentRunRegistry({ maxConcurrent: 1 });
  const t1 = r.admit();
  const t2 = r.admit();
  await t1.granted;
  t2.granted.catch(() => {});
  t2.abort();
  t2.abort();
  t2.abort();
  assert.equal(t2.state, 'aborted');
  assert.equal(r.getQueueLength(), 0);
});
