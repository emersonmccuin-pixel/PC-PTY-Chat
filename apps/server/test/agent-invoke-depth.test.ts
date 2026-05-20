// Section 16b.4.5 unit tests — `pc_invoke_agent` nesting depth cap.
//
// Exercises `checkInvokeDepth`: orchestrator-initiated calls (parent=0)
// land children at depth 1; intermediate depths advance one step; reaching
// the cap rejects with `cause: 'depth-cap'`; malformed parent inputs clamp
// to 0 rather than silently allowing unbounded nesting.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_INVOKE_DEPTH_CAP,
  checkInvokeDepth,
} from '../src/services/agent-run-manager.ts';

test('orchestrator-initiated dispatch lands child at depth 1', () => {
  const out = checkInvokeDepth(0);
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.childDepth, 1);
});

test('intermediate depth increments by one', () => {
  for (let parent = 1; parent < AGENT_INVOKE_DEPTH_CAP; parent++) {
    const out = checkInvokeDepth(parent);
    assert.equal(out.ok, true, `parent ${parent} should be allowed`);
    if (out.ok) assert.equal(out.childDepth, parent + 1);
  }
});

test('at-cap parent rejects with cause "depth-cap"', () => {
  const out = checkInvokeDepth(AGENT_INVOKE_DEPTH_CAP);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.cause, 'depth-cap');
    assert.match(out.error, /exceeding cap 5/);
  }
});

test('above-cap parent rejects', () => {
  const out = checkInvokeDepth(AGENT_INVOKE_DEPTH_CAP + 3);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.cause, 'depth-cap');
});

test('negative parent clamps to 0', () => {
  const out = checkInvokeDepth(-5);
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.childDepth, 1);
});

test('NaN parent clamps to 0', () => {
  const out = checkInvokeDepth(Number.NaN);
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.childDepth, 1);
});

test('fractional parent floors before checking', () => {
  const out = checkInvokeDepth(2.9);
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.childDepth, 3);
});
