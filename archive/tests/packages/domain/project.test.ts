// Section 27 — stage flag → post-move status helper.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  postMoveStatusForStage,
  resolveCancelledHidden,
  withProjectSettingsDefaults,
} from '../src/project.ts';

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

test('withProjectSettingsDefaults: missing / unknown values default to use-global', () => {
  assert.equal(withProjectSettingsDefaults(undefined).cancelledVisibility, 'use-global');
  assert.equal(withProjectSettingsDefaults({}).cancelledVisibility, 'use-global');
  assert.equal(
    withProjectSettingsDefaults({ cancelledVisibility: 'bogus' as 'use-global' }).cancelledVisibility,
    'use-global',
  );
});

test('withProjectSettingsDefaults: valid values pass through', () => {
  assert.equal(
    withProjectSettingsDefaults({ cancelledVisibility: 'force-visible' }).cancelledVisibility,
    'force-visible',
  );
  assert.equal(
    withProjectSettingsDefaults({ cancelledVisibility: 'force-hidden' }).cancelledVisibility,
    'force-hidden',
  );
});

test('resolveCancelledHidden: use-global respects global flag', () => {
  assert.equal(resolveCancelledHidden({ cancelledVisibility: 'use-global' }, true), true);
  assert.equal(resolveCancelledHidden({ cancelledVisibility: 'use-global' }, false), false);
});

test('resolveCancelledHidden: force-visible always shows regardless of global', () => {
  assert.equal(resolveCancelledHidden({ cancelledVisibility: 'force-visible' }, true), false);
  assert.equal(resolveCancelledHidden({ cancelledVisibility: 'force-visible' }, false), false);
});

test('resolveCancelledHidden: force-hidden always hides regardless of global', () => {
  assert.equal(resolveCancelledHidden({ cancelledVisibility: 'force-hidden' }, true), true);
  assert.equal(resolveCancelledHidden({ cancelledVisibility: 'force-hidden' }, false), true);
});

test('resolveCancelledHidden: undefined settings default to use-global', () => {
  assert.equal(resolveCancelledHidden(undefined, true), true);
  assert.equal(resolveCancelledHidden(undefined, false), false);
});
