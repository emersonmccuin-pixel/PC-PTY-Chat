import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import type { ULID } from '@pc/domain';
import type {
  AgentHostEvent,
  AgentHostStartRunRequest,
  JsonlEvent,
  ReadyTimestamps,
  SendResult,
  SpawnLike,
  SpawnState,
  SubagentSpawnRequest,
} from '@pc/runtime';

import { AgentHostService } from '../src/index.ts';

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class StubSpawn extends EventEmitter implements SpawnLike {
  state: SpawnState = 'spawning';
  started = false;
  killed = false;
  killCount = 0;
  handshakes = 0;
  sent: string[] = [];
  sendResult: SendResult = 'ok';
  readyPromise: Promise<ReadyTimestamps>;
  private readyResolve!: (ts: ReadyTimestamps) => void;

  constructor() {
    super();
    this.readyPromise = new Promise<ReadyTimestamps>((resolve) => {
      this.readyResolve = resolve;
    });
  }

  start(): void {
    this.started = true;
  }

  awaitReady(): Promise<ReadyTimestamps> {
    return this.readyPromise;
  }

  async send(body: string): Promise<SendResult> {
    this.sent.push(body);
    return this.sendResult;
  }

  notifyMcpHandshake(): void {
    this.handshakes++;
  }

  interrupt(): void {}

  kill(): void {
    this.killed = true;
    this.killCount++;
    setImmediate(() => this.emit('exit', null, null));
  }

  getState(): SpawnState {
    return this.state;
  }

  getJsonlPath(): string | null {
    return 'C:\\fake\\claude\\session.jsonl';
  }

  fireReady(): void {
    this.state = 'ready';
    this.emit('state', this.state);
    this.readyResolve({
      composerReadyAt: 100,
      handshakeAt: 200,
      initCompleteAt: 300,
    });
  }

  fireAssistantTurnEnd(text = 'done'): void {
    this.emit('jsonl-event', {
      row: {
        type: 'assistant',
        message: { content: [{ type: 'text', text }], stop_reason: 'end_turn' },
      },
    } as unknown as JsonlEvent);
  }

  fireWorkflowAssistantTurnEnd(text = 'done'): void {
    this.emit('jsonl-event', {
      kind: 'jsonl-turn-end',
      text,
      stopReason: 'end_turn',
    } satisfies JsonlEvent);
  }
}

function makeRequest(
  overrides: Partial<AgentHostStartRunRequest> = {},
): AgentHostStartRunRequest {
  return {
    runId: '01KHOST0000000000000000001' as ULID,
    projectId: '01KHOSTPROJECT00000000001' as ULID,
    dispatcherSessionId: 'orch-session',
    ccSessionId: '00000000-0000-0000-0000-000000000001',
    podDefinition: { name: 'researcher' },
    worktreePath: 'C:\\fake\\worktree',
    env: {},
    initialInput: 'hello host',
    transcriptPath: 'C:\\fake\\transcript.txt',
    timeouts: {
      spawnStuckMs: 1_000,
      idleMs: 10_000,
      wallClockMs: 10_000,
      cancelGraceMs: 5,
      handshakeTimeoutMs: 1_000,
      readyTimeoutMs: 1_000,
    },
    ...overrides,
  };
}

function makeWorkflowRequest(
  overrides: Partial<SubagentSpawnRequest> = {},
): SubagentSpawnRequest {
  return {
    agentName: 'researcher',
    worktreeDir: 'C:\\fake\\workflow-worktree',
    initialInput: 'workflow task',
    sessionDataDir: 'C:\\fake\\workflow-session',
    pcSessionId: 'wf-session-1',
    ...overrides,
  };
}

function collectEvents(service: AgentHostService): AgentHostEvent[] {
  const events: AgentHostEvent[] = [];
  service.on('event', (event: AgentHostEvent) => events.push(event));
  return events;
}

function nextEvent<T extends AgentHostEvent['type']>(
  service: AgentHostService,
  type: T,
): Promise<Extract<AgentHostEvent, { type: T }>> {
  return new Promise((resolve) => {
    const onEvent = (event: AgentHostEvent) => {
      if (event.type !== type) return;
      service.off('event', onEvent);
      resolve(event as Extract<AgentHostEvent, { type: T }>);
    };
    service.on('event', onEvent);
  });
}

test('hello emits host identity and list-runs starts empty', async () => {
  const service = new AgentHostService({
    hostId: 'host-test',
    pid: 123,
    startedAt: 456,
  });
  const events = collectEvents(service);

  const hello = await service.handleCommand({
    type: 'hello',
    apiPid: 789,
    protocolVersion: 1,
  });

  assert.equal(hello.ok, true);
  if (!hello.ok || hello.command !== 'hello') {
    throw new Error('bad hello response');
  }
  assert.equal(hello.identity.hostId, 'host-test');
  assert.equal(hello.identity.pid, 123);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'host-ready');
  assert.deepEqual(service.getEventsAfter(0), events);

  const list = await service.handleCommand({ type: 'list-runs' });
  assert.equal(list.ok, true);
  if (!list.ok || list.command !== 'list-runs') throw new Error('bad list response');
  assert.deepEqual(list.runs, []);
});

test('start-run owns AgentRun lifecycle and emits run events', async () => {
  const stub = new StubSpawn();
  const service = new AgentHostService({
    hostId: 'host-start',
    spawnFactory: () => stub,
  });
  const events = collectEvents(service);
  const request = makeRequest();

  const started = await service.handleCommand({ type: 'start-run', request });
  assert.equal(started.ok, true);
  if (!started.ok || started.command !== 'start-run') {
    throw new Error('bad start response');
  }
  assert.equal(started.run.state, 'queued');
  assert.equal(started.run.runId, request.runId);

  await tick();
  assert.equal(stub.started, true);

  stub.fireReady();
  await tick();
  assert.deepEqual(stub.sent, ['hello host']);

  const list = await service.handleCommand({ type: 'list-runs' });
  assert.equal(list.ok, true);
  if (!list.ok || list.command !== 'list-runs') throw new Error('bad list response');
  assert.equal(list.runs[0]?.state, 'running');
  assert.equal(list.runs[0]?.jsonlPath, 'C:\\fake\\claude\\session.jsonl');

  const terminalP = nextEvent(service, 'run-terminal');
  stub.fireAssistantTurnEnd('complete');
  const terminal = await terminalP;

  assert.equal(terminal.run.state, 'completed');
  assert.equal(terminal.run.terminalResult?.status, 'completed');
  assert.equal(terminal.run.terminalResult?.result, 'complete');
  assert.equal(
    events.some((event) => event.type === 'run-jsonl' && event.runId === request.runId),
    true,
  );
});

test('send, notify-mcp-handshake, and cancel route through the active run', async () => {
  const stub = new StubSpawn();
  const service = new AgentHostService({ spawnFactory: () => stub });
  const events = collectEvents(service);
  const request = makeRequest({
    runId: '01KHOST0000000000000000002' as ULID,
    ccSessionId: '00000000-0000-0000-0000-000000000002',
  });

  const started = await service.handleCommand({ type: 'start-run', request });
  assert.equal(started.ok, true);
  await tick();
  stub.fireReady();
  await tick();

  const handshake = await service.handleCommand({
    type: 'notify-mcp-handshake',
    ccSessionId: request.ccSessionId,
  });
  assert.equal(handshake.ok, true);
  assert.equal(stub.handshakes, 1);

  const sent = await service.handleCommand({
    type: 'send',
    runId: request.runId,
    text: 'follow up',
  });
  assert.equal(sent.ok, true);
  assert.deepEqual(stub.sent, ['hello host', 'follow up']);

  stub.sendResult = 'echo-timeout';
  const failedSend = await service.handleCommand({
    type: 'send',
    runId: request.runId,
    text: 'will fail',
  });
  assert.equal(failedSend.ok, false);
  if (failedSend.ok) throw new Error('expected send failure');
  assert.equal(failedSend.code, 'send-failed');
  assert.equal(events.at(-1)?.type, 'run-error');

  const terminalP = nextEvent(service, 'run-terminal');
  const cancelled = await service.handleCommand({
    type: 'cancel',
    runId: request.runId,
  });
  assert.equal(cancelled.ok, true);
  const terminal = await terminalP;
  assert.equal(terminal.run.state, 'cancelled');
  assert.equal(terminal.run.terminalResult?.failureCause, 'cancelled');
});

test('mark-paused transitions the host-owned run before API-side resume', async () => {
  const stub = new StubSpawn();
  const service = new AgentHostService({ spawnFactory: () => stub });
  const request = makeRequest({
    runId: '01KHOST0000000000000000004' as ULID,
    ccSessionId: '00000000-0000-0000-0000-000000000004',
  });

  const started = await service.handleCommand({ type: 'start-run', request });
  assert.equal(started.ok, true);
  await tick();
  stub.fireReady();
  await tick();

  const paused = await service.handleCommand({
    type: 'mark-paused',
    runId: request.runId,
    askId: 'ask-1',
  });

  assert.equal(paused.ok, true);
  if (!paused.ok || paused.command !== 'mark-paused') {
    throw new Error('bad mark-paused response');
  }
  assert.equal(paused.run.state, 'paused');

  const list = await service.handleCommand({ type: 'list-runs' });
  assert.equal(list.ok, true);
  if (!list.ok || list.command !== 'list-runs') throw new Error('bad list response');
  assert.equal(list.runs[0]?.state, 'paused');
});

test('duplicate run ids and missing runs return protocol errors without throwing', async () => {
  const stub = new StubSpawn();
  const service = new AgentHostService({ spawnFactory: () => stub });
  const request = makeRequest({
    runId: '01KHOST0000000000000000003' as ULID,
    ccSessionId: '00000000-0000-0000-0000-000000000003',
  });

  const first = await service.handleCommand({ type: 'start-run', request });
  assert.equal(first.ok, true);

  const duplicate = await service.handleCommand({ type: 'start-run', request });
  assert.equal(duplicate.ok, false);
  if (duplicate.ok) throw new Error('expected duplicate failure');
  assert.equal(duplicate.code, 'run-exists');

  const missing = await service.handleCommand({
    type: 'cancel',
    runId: '01KHOSTMISSING0000000001' as ULID,
  });
  assert.equal(missing.ok, false);
  if (missing.ok) throw new Error('expected missing-run failure');
  assert.equal(missing.code, 'not-found');

  await tick();
  stub.fireReady();
  await tick();
  const terminalP = nextEvent(service, 'run-terminal');
  stub.fireAssistantTurnEnd();
  await terminalP;
});

test('workflow subagent command owns spawn lifecycle and handshake', async () => {
  const stub = new StubSpawn();
  const service = new AgentHostService({ workflowSpawnFactory: () => stub });
  const request = makeWorkflowRequest();

  const started = await service.handleCommand({
    type: 'start-workflow-subagent',
    request,
  });

  assert.equal(started.ok, true);
  if (!started.ok || started.command !== 'start-workflow-subagent') {
    throw new Error('bad workflow start response');
  }
  assert.equal(started.workflowSubagent.pcSessionId, request.pcSessionId);
  assert.equal(started.workflowSubagent.state, 'running');
  assert.equal(started.workflowSubagent.transcriptPath, 'C:\\fake\\workflow-session\\transcript.log');
  assert.equal(started.workflowSubagent.jsonlPath, 'C:\\fake\\claude\\session.jsonl');
  assert.equal(typeof started.workflowSubagent.ccSessionId, 'string');

  await tick();
  assert.equal(stub.started, true);

  const ccSessionId = started.workflowSubagent.ccSessionId;
  if (typeof ccSessionId !== 'string') {
    throw new Error('expected workflow cc session id');
  }
  const handshake = await service.handleCommand({
    type: 'notify-mcp-handshake',
    ccSessionId,
  });
  assert.equal(handshake.ok, true);
  assert.equal(stub.handshakes, 1);

  stub.fireReady();
  await tick();
  assert.deepEqual(stub.sent, ['workflow task']);

  const terminalP = nextEvent(service, 'workflow-subagent-terminal');
  stub.fireWorkflowAssistantTurnEnd('workflow done');
  const terminal = await terminalP;

  assert.equal(terminal.workflowSubagent.pcSessionId, request.pcSessionId);
  assert.equal(terminal.workflowSubagent.state, 'completed');
  assert.equal(terminal.workflowSubagent.terminalResult?.kind, 'success');
  if (terminal.workflowSubagent.terminalResult?.kind !== 'success') {
    throw new Error('expected workflow success result');
  }
  assert.equal(terminal.workflowSubagent.terminalResult.lastAssistantText, 'workflow done');
});

test('cancel-workflow-subagent kills workflow subagent handle', async () => {
  const stub = new StubSpawn();
  const service = new AgentHostService({ workflowSpawnFactory: () => stub });
  const request = makeWorkflowRequest({ pcSessionId: 'wf-session-cancel' });

  const started = await service.handleCommand({
    type: 'start-workflow-subagent',
    request,
  });
  assert.equal(started.ok, true);
  await tick();

  const terminalP = nextEvent(service, 'workflow-subagent-terminal');
  const cancelled = await service.handleCommand({
    type: 'cancel-workflow-subagent',
    pcSessionId: request.pcSessionId,
    reason: 'test cancel',
  });
  assert.equal(cancelled.ok, true);
  assert.equal(stub.killed, true);

  const terminal = await terminalP;
  assert.equal(terminal.workflowSubagent.state, 'cancelled');
  assert.equal(terminal.workflowSubagent.terminalResult?.kind, 'failure');
  if (terminal.workflowSubagent.terminalResult?.kind !== 'failure') {
    throw new Error('expected workflow failure result');
  }
  assert.equal(terminal.workflowSubagent.terminalResult.cause, 'killed');
});
