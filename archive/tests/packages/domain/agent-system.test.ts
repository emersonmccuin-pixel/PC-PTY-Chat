import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_RUN_FAILURE_CAUSES } from '../src/index.ts';

test('agent run failure causes include out-of-process host taxonomy', () => {
  for (const cause of [
    'host-unavailable',
    'host-lost',
    'host-crashed',
    'host-protocol-error',
  ]) {
    assert.equal(
      AGENT_RUN_FAILURE_CAUSES.includes(cause as never),
      true,
      `expected ${cause} in AGENT_RUN_FAILURE_CAUSES`,
    );
  }
});
