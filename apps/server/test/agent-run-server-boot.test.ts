import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AgentRunRow, AgentRunStatus, ULID } from '@pc/domain';
import type {
  AgentHostCommand,
  AgentHostCommandResponse,
  AgentHostEvent,
  AgentHostRunSnapshot,
} from '@pc/runtime';

import { ActiveRunRegistry } from '../src/services/agent-active-runs.ts';
import type { AgentHostReattachClient } from '../src/services/agent-host-reattach.ts';
import { reattachAgentRunsDuringServerBoot } from '../src/services/agent-run-server-boot.ts';

class FakeHostClient implements AgentHostReattachClient {
  commands: AgentHostCommand[] = [];

  constructor(private readonly runs: AgentHostRunSnapshot[]) {}

  listRuns(): readonly AgentHostRunSnapshot[] {
    return this.runs;
  }

  sendCommand(command: AgentHostCommand): AgentHostCommandResponse | void {
    this.commands.push(command);
    if (!('runId' in command)) return;
    const run = this.runs.find((candidate) => candidate.runId === command.runId);
    if (!run || command.type === 'send') return;
    return { ok: true, command: command.type as never, run, lastSeq: 0 };
  }

  onEvent(_listener: (event: AgentHostEvent) => void): () => void {
    return () => undefined;
  }
}

function row(id: string, status: AgentRunStatus = 'running'): AgentRunRow {
  return {
    id: id as ULID,
    projectId: '01KBOOTPROJECT00000000001' as ULID,
    dispatcherSessionId: 'dispatcher-1',
    ccSessionId: `cc-${id}`,
    podName: 'researcher',
    podRevisionAtDispatch: 'agent:1',
    podRevisionAtResume: null,
    status,
    continues: null,
    parentInvokeDepth: 0,
    parentWorkItemId: null,
    input: 'input',
    result: null,
    failureCause: null,
    failureReason: null,
    queuedAt: 1_700_000_000_000,
    spawnedAt: 1_700_000_000_100,
    readyAt: 1_700_000_000_200,
    completedAt: null,
  };
}

function hostRun(id: string): AgentHostRunSnapshot {
  return {
    runId: id as ULID,
    projectId: '01KBOOTPROJECT00000000001' as ULID,
    dispatcherSessionId: 'dispatcher-1',
    ccSessionId: `cc-${id}`,
    podName: 'researcher',
    worktreeDir: 'E:/worktree',
    state: 'running',
    jsonlPath: null,
    transcriptPath: null,
    queuedAt: 1_700_000_000_000,
    spawnedAt: 1_700_000_000_100,
    readyAt: 1_700_000_000_200,
    updatedAt: 1_700_000_000_300,
    terminalAt: null,
  };
}

test('server boot keeps the legacy reconcile path when no host client is available', async () => {
  const result = await reattachAgentRunsDuringServerBoot({
    getHostClient: () => null,
    now: () => 123,
    legacyReconcile: (now) => {
      assert.equal(now, 123);
      return 2;
    },
  });

  assert.deepEqual(result, {
    mode: 'legacy',
    reattach: null,
    reconcile: {
      mode: 'legacy',
      hostRuns: 0,
      checked: 0,
      kept: 0,
      failed: 2,
      updated: 0,
      reconciled: 2,
    },
  });
});

test('server boot reattaches active handles through a provided fake host client', async () => {
  const runRow = row('run-boot-live');
  const host = new FakeHostClient([hostRun('run-boot-live')]);
  const registry = new ActiveRunRegistry();
  const updates: unknown[] = [];
  const terminals: unknown[] = [];

  const result = await reattachAgentRunsDuringServerBoot({
    getHostClient: async () => host,
    activeRunRegistry: registry,
    listNonTerminalRuns: () => [runRow],
    getAgentRun: () => runRow,
    hasOpenPendingAskForRun: () => false,
    resolveJsonlPath: () => null,
    updateStatus: (input) => { updates.push(input); },
    markTerminal: (input) => { terminals.push(input); },
  });

  assert.equal(result.mode, 'host');
  assert.equal(result.reattach.registered, 1);
  assert.equal(result.reattach.reconcile.mode, 'host');
  assert.equal(result.reattach.reconcile.kept, 1);
  assert.deepEqual(updates, []);
  assert.deepEqual(terminals, []);

  const entry = registry.get(runRow.id);
  assert.ok(entry);
  entry.run.cancel();
  assert.deepEqual(host.commands, [
    { type: 'cancel', runId: runRow.id },
  ]);
});
