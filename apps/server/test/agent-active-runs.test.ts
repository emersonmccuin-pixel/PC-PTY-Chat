import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ULID } from '@pc/domain';

import {
  ActiveRunRegistry,
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
