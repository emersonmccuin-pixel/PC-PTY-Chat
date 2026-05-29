import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ULID } from '@pc/domain';
import type { AgentHostCommand, AgentHostRunSnapshot } from '@pc/runtime';

import {
  ActiveRunRegistry,
  HostBackedActiveRunHandle,
  type ActiveRunHandle,
} from '../src/services/agent-active-runs.ts';

class FakeActiveRunHandle implements ActiveRunHandle {
  private terminalListeners: Array<() => void> = [];
  private state: ReturnType<ActiveRunHandle['getState']> = 'running';
  pausedAsk: string | null = null;
  resumeAnswer: string | null = null;
  cancelled = false;
  handshakeNotified = false;

  constructor(private readonly runId: ULID) {}

  getRecord() {
    return { agentRunId: this.runId };
  }

  getState() {
    return this.state;
  }

  cancel() {
    this.cancelled = true;
    this.state = 'cancelled';
    this.fireTerminal();
  }

  notifyMcpHandshake() {
    this.handshakeNotified = true;
  }

  markPaused(askId: string) {
    this.pausedAsk = askId;
    this.state = 'paused';
  }

  resumeWithAnswer(answer: string) {
    this.resumeAnswer = answer;
    this.state = 'spawning';
  }

  onTerminal(listener: () => void) {
    this.terminalListeners.push(listener);
  }

  fireTerminal() {
    for (const listener of this.terminalListeners) listener();
  }
}

test('ActiveRunRegistry stores host-style handles without AgentRun concrete dependency', () => {
  const registry = new ActiveRunRegistry();
  const runId = '01KSRVHANDLETEST000000001' as ULID;
  const handle = new FakeActiveRunHandle(runId);

  const entry = registry.register({
    run: handle,
    projectId: '01KSRVPROJECT000000000001' as ULID,
    dispatcherSessionId: 'dispatcher-1',
    ccSessionId: 'cc-session-1',
    podName: 'researcher',
    parentWorkItemId: null,
    podRevisionAtDispatch: null,
    now: 1_700_000_000_000,
  });

  assert.equal(entry.run, handle);
  assert.equal(registry.get(runId), entry);
  assert.equal(registry.getByCcSession('cc-session-1'), entry);
  assert.deepEqual(registry.list(), [entry]);

  entry.run.markPaused('ask-1');
  entry.run.resumeWithAnswer('answer');
  entry.run.notifyMcpHandshake();

  assert.equal(handle.pausedAsk, 'ask-1');
  assert.equal(handle.resumeAnswer, 'answer');
  assert.equal(handle.handshakeNotified, true);
});

test('ActiveRunRegistry unregisters host-style handles on terminal callback', () => {
  const registry = new ActiveRunRegistry();
  const runId = '01KSRVHANDLETEST000000002' as ULID;
  const handle = new FakeActiveRunHandle(runId);

  registry.register({
    run: handle,
    projectId: '01KSRVPROJECT000000000001' as ULID,
    dispatcherSessionId: 'dispatcher-1',
    ccSessionId: 'cc-session-2',
    podName: 'writer',
  });

  handle.fireTerminal();

  assert.equal(registry.get(runId), null);
  assert.equal(registry.getByCcSession('cc-session-2'), null);
  assert.deepEqual(registry.list(), []);
});

function hostSnapshot(
  runId: ULID,
  state: AgentHostRunSnapshot['state'] = 'running',
): AgentHostRunSnapshot {
  return {
    runId,
    projectId: '01KSRVPROJECT000000000001' as ULID,
    dispatcherSessionId: 'dispatcher-1',
    ccSessionId: 'cc-session-host',
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
  };
}

test('HostBackedActiveRunHandle routes active operations through host commands', () => {
  const commands: AgentHostCommand[] = [];
  const runId = '01KSRVHOSTHANDLE000000001' as ULID;
  const handle = new HostBackedActiveRunHandle(
    hostSnapshot(runId),
    {
      sendCommand: (command) => {
        commands.push(command);
      },
    },
    { now: () => 1_700_000_001_000 },
  );

  assert.equal(handle.getRecord().agentRunId, runId);
  assert.equal(handle.getState(), 'running');

  handle.markPaused('ask-1');
  handle.resumeWithAnswer('answer');
  handle.notifyMcpHandshake();
  handle.cancel();

  assert.equal(handle.getState(), 'paused');
  assert.deepEqual(commands, [
    { type: 'mark-paused', runId, askId: 'ask-1' },
    { type: 'answer-pending', runId, text: 'answer' },
    { type: 'notify-mcp-handshake', ccSessionId: 'cc-session-host' },
    { type: 'cancel', runId },
  ]);
});

test('HostBackedActiveRunHandle fires terminal listeners from host snapshots', () => {
  const runId = '01KSRVHOSTHANDLE000000002' as ULID;
  const handle = new HostBackedActiveRunHandle(hostSnapshot(runId), {
    sendCommand: () => {},
  });

  let terminalCount = 0;
  handle.onTerminal(() => {
    terminalCount += 1;
  });

  handle.applySnapshot({
    ...hostSnapshot(runId, 'completed'),
    terminalAt: 1_700_000_002_000,
    terminalResult: {
      status: 'completed',
      result: 'done',
      failureCause: null,
      failureReason: null,
    },
  });
  handle.applySnapshot(hostSnapshot(runId, 'completed'));

  assert.equal(terminalCount, 1);
  assert.equal(handle.getState(), 'completed');
});
