import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  containsProjectChangedRefetchEvent,
  projectWsTargetIds,
  projectWsTargetKeyFromIds,
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

test('all-project websocket target key is stable across metadata-only project refetches', () => {
  const before = [
    { id: 'p2', name: 'Two' },
    { id: 'p1', name: 'One' },
    { id: 'active', name: 'Active' },
  ];
  const after = [
    { id: 'active', name: 'Active renamed' },
    { id: 'p1', name: 'One renamed' },
    { id: 'p2', name: 'Two renamed' },
  ];

  const beforeKey = projectWsTargetKeyFromIds(projectWsTargetIds(before, 'active', true));
  const afterKey = projectWsTargetKeyFromIds(projectWsTargetIds(after, 'active', true));

  assert.equal(beforeKey, 'p1,p2');
  assert.equal(afterKey, beforeKey);
  assert.equal(projectWsTargetKeyFromIds(projectWsTargetIds(after, 'active', false)), '');
});
