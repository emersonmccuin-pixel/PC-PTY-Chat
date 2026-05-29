import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { AgentRunRow, ULID } from '@pc/domain';
import type { MarkAgentRunTerminalInput } from '@pc/db';
import type {
  AgentHostCommand,
  AgentHostCommandResponse,
  AgentHostEvent,
  AgentHostRunSnapshot,
} from '@pc/runtime';

import { ActiveRunRegistry } from '../src/services/agent-active-runs.ts';
import {
  applyHostTerminalSnapshot,
  reattachAgentRunsOnBoot,
  type AgentHostReattachClient,
} from '../src/services/agent-host-reattach.ts';

class FakeHostClient extends EventEmitter implements AgentHostReattachClient {
  commands: AgentHostCommand[] = [];

  constructor(private readonly runs: AgentHostRunSnapshot[]) {
    super();
  }

  listRuns(): readonly AgentHostRunSnapshot[] {
    return this.runs;
  }

  sendCommand(command: AgentHostCommand): AgentHostCommandResponse | void {
    this.commands.push(command);
    const run =
      'runId' in command
        ? this.runs.find((candidate) => candidate.runId === command.runId)
        : undefined;
    if (run && command.type !== 'send') {
      return { ok: true, command: command.type as never, run, lastSeq: 0 };
    }
  }

  onEvent(listener: (event: AgentHostEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }

  emitHostEvent(event: AgentHostEvent): void {
    this.emit('event', event);
  }
}

function row(id: string, patch: Partial<AgentRunRow> = {}): AgentRunRow {
  return {
    id: id as ULID,
    projectId: '01KHOSTPROJECT00000000001' as ULID,
    dispatcherSessionId: 'orch-session',
    ccSessionId: `cc-${id}`,
    podName: 'researcher',
    podRevisionAtDispatch: 'agent:1',
    podRevisionAtResume: null,
    status: 'running',
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
    rev: 0,
    ...patch,
  };
}

function hostRun(
  id: string,
  state: AgentHostRunSnapshot['state'] = 'running',
  patch: Partial<AgentHostRunSnapshot> = {},
): AgentHostRunSnapshot {
  return {
    runId: id as ULID,
    projectId: '01KHOSTPROJECT00000000001' as ULID,
    dispatcherSessionId: 'orch-session',
    ccSessionId: `cc-${id}`,
    podName: 'researcher',
    worktreeDir: 'E:/worktree',
    state,
    jsonlPath: null,
    transcriptPath: null,
    queuedAt: 1_700_000_000_000,
    spawnedAt: 1_700_000_000_100,
    readyAt: 1_700_000_000_200,
    updatedAt: 1_700_000_000_300,
    terminalAt: null,
    ...patch,
  };
}

test('reattachAgentRunsOnBoot registers host-backed handles and backfills JSONL', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pc-host-reattach-'));
  const jsonlPath = join(tmp, 'session.jsonl');
  mkdirSync(dirname(jsonlPath), { recursive: true });
  writeFileSync(
    jsonlPath,
    [
      JSON.stringify({ type: 'user', message: { content: 'research this' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn',
        },
      }),
      '',
    ].join('\n'),
  );

  try {
    const runRow = row('run-live');
    const host = new FakeHostClient([hostRun('run-live', 'running', { jsonlPath })]);
    const registry = new ActiveRunRegistry();
    const broadcasts: unknown[] = [];
    const updates: unknown[] = [];
    const terminals: unknown[] = [];

    const result = reattachAgentRunsOnBoot({
      hostClient: host,
      activeRunRegistry: registry,
      listNonTerminalRuns: () => [runRow],
      getAgentRun: () => runRow,
      hasOpenPendingAskForRun: () => false,
      updateStatus: (input) => { updates.push(input); },
      markTerminal: (input) => { terminals.push(input); },
      broadcast: (_projectId, msg) => { broadcasts.push(msg); },
    });

    assert.equal(result.reconcile.mode, 'host');
    assert.equal(result.registered, 1);
    assert.equal(result.backfilledEvents, 2);
    assert.deepEqual(updates, []);
    assert.deepEqual(terminals, []);
    assert.equal(registry.list().length, 1);
    assert.deepEqual(
      broadcasts.map((msg) => (msg as { type?: string }).type),
      ['agent-jsonl-event', 'agent-jsonl-event'],
    );

    const entry = registry.get(runRow.id);
    assert.ok(entry);
    entry.run.markPaused('ask-1');
    entry.run.resumeWithAnswer('resume answer');
    entry.run.notifyMcpHandshake();
    entry.run.cancel();

    assert.deepEqual(host.commands, [
      { type: 'mark-paused', runId: runRow.id, askId: 'ask-1' },
      { type: 'answer-pending', runId: runRow.id, text: 'resume answer' },
      { type: 'notify-mcp-handshake', ccSessionId: runRow.ccSessionId },
      { type: 'cancel', runId: runRow.id },
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('reattached host event stream updates state, broadcasts JSONL, and applies terminal once', () => {
  let currentRow = row('run-events');
  const host = new FakeHostClient([hostRun('run-events')]);
  const registry = new ActiveRunRegistry();
  const updates: unknown[] = [];
  const terminals: unknown[] = [];
  const broadcasts: unknown[] = [];

  reattachAgentRunsOnBoot({
    hostClient: host,
    activeRunRegistry: registry,
    listNonTerminalRuns: () => [currentRow],
    getAgentRun: () => currentRow,
    hasOpenPendingAskForRun: () => false,
    resolveJsonlPath: () => null,
    updateStatus: (input) => {
      updates.push(input);
      currentRow = { ...currentRow, status: input.status };
    },
    markTerminal: (input) => {
      terminals.push(input);
      currentRow = {
        ...currentRow,
        status: input.status,
        completedAt: input.completedAt,
        failureCause: input.failureCause,
        failureReason: input.failureReason,
      };
    },
    broadcast: (_projectId, msg) => { broadcasts.push(msg); },
  });

  host.emitHostEvent({
    seq: 1,
    type: 'run-state',
    run: hostRun('run-events', 'paused'),
  });
  assert.equal(registry.get(currentRow.id)?.run.getState(), 'paused');

  host.emitHostEvent({
    seq: 2,
    type: 'run-jsonl',
    runId: currentRow.id,
    event: { kind: 'jsonl-user', text: 'hi' },
  });

  const terminalSnapshot = hostRun('run-events', 'failed', {
    terminalAt: 1_700_000_001_000,
    terminalResult: {
      status: 'failed',
      result: null,
      failureCause: 'idle-timeout',
      failureReason: 'idle',
    },
  });
  host.emitHostEvent({ seq: 3, type: 'run-terminal', run: terminalSnapshot });
  host.emitHostEvent({ seq: 4, type: 'run-terminal', run: terminalSnapshot });

  assert.deepEqual(updates, [
    {
      id: currentRow.id,
      status: 'paused',
      spawnedAt: 1_700_000_000_100,
      readyAt: 1_700_000_000_200,
    },
  ]);
  assert.equal(terminals.length, 1);
  assert.deepEqual(terminals[0], {
    id: currentRow.id,
    status: 'failed',
    result: null,
    failureCause: 'idle-timeout',
    failureReason: 'idle',
    completedAt: 1_700_000_001_000,
  });
  assert.equal(registry.get(currentRow.id), null);
  assert.deepEqual(
    broadcasts.map((msg) => (msg as { type?: string }).type),
    ['agent-run-changed', 'agent-jsonl-event', 'agent-run-changed'],
  );
});

test('applyHostTerminalSnapshot is idempotent once the DB row is terminal', () => {
  let currentRow = row('run-terminal-once');
  const terminals: unknown[] = [];
  const snapshot = hostRun('run-terminal-once', 'completed', {
    terminalAt: 1_700_000_002_000,
    terminalResult: {
      status: 'completed',
      result: 'complete',
      failureCause: null,
      failureReason: null,
    },
  });

  const deps = {
    getAgentRun: () => currentRow,
    markTerminal: (input: MarkAgentRunTerminalInput) => {
      terminals.push(input);
      currentRow = {
        ...currentRow,
        status: input.status,
        result: input.result,
        completedAt: input.completedAt,
      };
    },
  };

  assert.equal(applyHostTerminalSnapshot(snapshot, deps), 1);
  assert.equal(applyHostTerminalSnapshot(snapshot, deps), 0);
  assert.deepEqual(terminals, [
    {
      id: currentRow.id,
      status: 'completed',
      result: 'complete',
      failureCause: null,
      failureReason: null,
      completedAt: 1_700_000_002_000,
    },
  ]);
});
