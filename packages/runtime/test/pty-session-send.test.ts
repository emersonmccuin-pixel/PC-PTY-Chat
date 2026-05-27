import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PtySession } from '../src/pty-session.ts';

test('PtySession.send returns ok when the timed paste queue accepts the prompt', () => {
  const enqueued: string[] = [];
  const states: string[] = [];
  const fakeSession = {
    state: 'ready',
    sendQueue: {
      enqueue(text: string) {
        enqueued.push(text);
        return 'queued';
      },
    },
    setState(next: string) {
      states.push(next);
      this.state = next;
    },
  };

  const result = (PtySession.prototype.send as (this: typeof fakeSession, text: string) => unknown)
    .call(fakeSession, 'hello from queue');

  assert.equal(result, 'ok');
  assert.deepEqual(enqueued, ['hello from queue']);
  assert.deepEqual(states, ['thinking']);
});

test('PtySession.send returns exited without enqueueing after process exit', () => {
  let enqueued = false;
  const fakeSession = {
    state: 'exited',
    sendQueue: {
      enqueue() {
        enqueued = true;
        return 'queued';
      },
    },
    setState() {
      throw new Error('setState should not run');
    },
  };

  const result = (PtySession.prototype.send as (this: typeof fakeSession, text: string) => unknown)
    .call(fakeSession, 'too late');

  assert.equal(result, 'exited');
  assert.equal(enqueued, false);
});
