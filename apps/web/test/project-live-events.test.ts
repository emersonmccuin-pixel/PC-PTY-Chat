import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  containsProjectChangedRefetchEvent,
  shouldAcceptProjectWsEnvelope,
} from '../src/features/projects/live-events.ts';

test('project websocket filter accepts only matching project events or project.changed globals', () => {
  assert.equal(
    shouldAcceptProjectWsEnvelope({ type: 'work-item-changed', projectId: 'p1' }, 'p1'),
    true,
  );
  assert.equal(
    shouldAcceptProjectWsEnvelope({ type: 'work-item-changed', projectId: 'p2' }, 'p1'),
    false,
  );
  assert.equal(
    shouldAcceptProjectWsEnvelope({ type: 'pod-changed' }, 'p1'),
    false,
  );
  assert.equal(
    shouldAcceptProjectWsEnvelope({
      type: 'project.changed',
      scope: 'global',
      projectId: null,
      reason: 'reordered',
    }, 'p1'),
    true,
  );
  assert.equal(
    shouldAcceptProjectWsEnvelope({
      type: 'project.changed',
      scope: 'project',
      projectId: null,
      reason: 'reordered',
    }, 'p1'),
    false,
  );
});

test('project.changed event scanner only considers new events after a start index', () => {
  const events = [
    { type: 'project.changed', scope: 'global', projectId: null, reason: 'created' },
    { type: 'work-item-changed', projectId: 'p1' },
    { type: 'project.changed', scope: 'global', projectId: null, reason: 'soft-deleted' },
  ];

  assert.equal(containsProjectChangedRefetchEvent(events, 0), true);
  assert.equal(containsProjectChangedRefetchEvent(events, 1), true);
  assert.equal(containsProjectChangedRefetchEvent(events, 3), false);
});
