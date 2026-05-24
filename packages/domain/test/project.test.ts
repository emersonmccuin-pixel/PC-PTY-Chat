// Section 27 — stage flag → post-move status helper.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { postMoveStatusForStage } from '../src/project.ts';

test('postMoveStatusForStage: is_done → complete', () => {
  assert.equal(postMoveStatusForStage({ isDone: true, isCancelled: false }), 'complete');
});

test('postMoveStatusForStage: is_cancelled → cancelled', () => {
  assert.equal(postMoveStatusForStage({ isDone: false, isCancelled: true }), 'cancelled');
});

test('postMoveStatusForStage: neither flag → pending', () => {
  assert.equal(postMoveStatusForStage({}), 'pending');
  assert.equal(postMoveStatusForStage({ isDone: false, isCancelled: false }), 'pending');
});

test('postMoveStatusForStage: undefined flags treated as false', () => {
  assert.equal(postMoveStatusForStage({ isDone: undefined, isCancelled: undefined }), 'pending');
});
