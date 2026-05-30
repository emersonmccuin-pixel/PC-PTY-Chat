import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AgentRunRow, AgentRunStatus, ULID } from '@pc/domain';

import { hardKillAgentRun, type AgentRunControlDeps } from '../src/services/agent-run-control.ts';

function row(patch: Partial<AgentRunRow> = {}): AgentRunRow {
  return {
    id: 'run-1' as ULID,
    projectId: 'proj-1' as ULID,
    dispatcherSessionId: 'disp-1',
    ccSessionId: 'cc-1',
    podName: 'planner',
    podRevisionAtDispatch: null,
    podRevisionAtResume: null,
    status: 'running' as AgentRunStatus,
    continues: null,
    parentInvokeDepth: 0,
    parentWorkItemId: null,
    input: 'go',
    result: null,
    failureCause: null,
    failureReason: null,
    queuedAt: 1,
    spawnedAt: 2,
    readyAt: 3,
    pid: 7777,
    lastActivityAt: 3,
    completedAt: null,
    rev: 0,
    ...patch,
  };
}

test('hard-kill a phantom (no registry entry) kills the pid + finalizes cancelled', () => {
  const killed: number[] = [];
  const finalized: Array<{ status: string; cause: unknown }> = [];
  const deps: AgentRunControlDeps = {
    getAgentRun: () => row(),
    activeRunRegistry: { get: () => null } as never,
    killProcess: (pid) => killed.push(pid),
    applyTerminalEffects: (input) => {
      finalized.push({ status: input.status, cause: input.failureCause });
      return { applied: 1 };
    },
  };
  const res = hardKillAgentRun('run-1' as ULID, deps);
  assert.equal(res.ok, true);
  assert.deepEqual(killed, [7777]);
  assert.deepEqual(finalized, [{ status: 'cancelled', cause: 'cancelled' }]);
  if (res.ok) assert.equal(res.processKilled, true);
});

test('hard-kill is idempotent on an already-terminal run (no kill, no finalize)', () => {
  let killCalls = 0;
  let finalizeCalls = 0;
  const res = hardKillAgentRun('run-1' as ULID, {
    getAgentRun: () => row({ status: 'completed' }),
    killProcess: () => (killCalls += 1),
    applyTerminalEffects: () => {
      finalizeCalls += 1;
      return { applied: 0 };
    },
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.alreadyTerminal, true);
  assert.equal(killCalls, 0);
  assert.equal(finalizeCalls, 0);
});

test('hard-kill with no persisted pid still finalizes (process unkillable but row corrected)', () => {
  let finalized = 0;
  const res = hardKillAgentRun('run-1' as ULID, {
    getAgentRun: () => row({ pid: null }),
    killProcess: () => assert.fail('should not attempt kill with null pid'),
    applyTerminalEffects: () => {
      finalized += 1;
      return { applied: 1 };
    },
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.processKilled, false);
  assert.equal(finalized, 1);
});

test('hard-kill unknown run → ok:false', () => {
  const res = hardKillAgentRun('nope' as ULID, { getAgentRun: () => null });
  assert.equal(res.ok, false);
});
