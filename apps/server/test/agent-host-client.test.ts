import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import type { ULID } from '@pc/domain';
import type {
  AgentHostCommand,
  AgentHostEvent,
  AgentHostIdentity,
  AgentHostRunSnapshot,
} from '@pc/runtime';

import { JsonLineAgentHostClient } from '../src/services/agent-host-client.ts';

interface WireRequest {
  id: string | number;
  command: AgentHostCommand;
}

function createHarness(): {
  client: JsonLineAgentHostClient;
  nextRequest: () => Promise<WireRequest>;
  writeHost: (payload: unknown) => void;
} {
  const hostStdout = new PassThrough();
  const hostStdin = new PassThrough();
  const client = new JsonLineAgentHostClient(
    { input: hostStdout, output: hostStdin },
    { requestTimeoutMs: 1_000 },
  );

  const requests: WireRequest[] = [];
  const waiters: Array<(request: WireRequest) => void> = [];
  let buffer = '';

  hostStdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const request = JSON.parse(line) as WireRequest;
      const waiter = waiters.shift();
      if (waiter) {
        waiter(request);
      } else {
        requests.push(request);
      }
    }
  });

  return {
    client,
    nextRequest: () => {
      const request = requests.shift();
      if (request) return Promise.resolve(request);
      return new Promise((resolve) => waiters.push(resolve));
    },
    writeHost: (payload) => {
      hostStdout.write(`${JSON.stringify(payload)}\n`);
    },
  };
}

function identity(): AgentHostIdentity {
  return {
    hostId: 'host-1',
    pid: 4321,
    startedAt: 1_700_000_000_000,
    protocolVersion: 1,
  };
}

function hostRun(
  state: AgentHostRunSnapshot['state'] = 'running',
  patch: Partial<AgentHostRunSnapshot> = {},
): AgentHostRunSnapshot {
  return {
    runId: '01KHOSTCLIENT000000000001' as ULID,
    projectId: '01KHOSTCLIENTPROJECT001' as ULID,
    dispatcherSessionId: 'dispatcher-1',
    ccSessionId: 'cc-host-client-1',
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

test('JsonLineAgentHostClient sends commands, caches snapshots, and emits events', async () => {
  const { client, nextRequest, writeHost } = createHarness();
  const hostIdentity = identity();
  const run = hostRun();

  const hello = client.hello(1234);
  const helloRequest = await nextRequest();
  assert.deepEqual(helloRequest.command, {
    type: 'hello',
    apiPid: 1234,
    protocolVersion: 1,
  });
  writeHost({
    type: 'response',
    id: helloRequest.id,
    response: {
      ok: true,
      command: 'hello',
      identity: hostIdentity,
      lastSeq: 1,
    },
  });
  assert.deepEqual(await hello, hostIdentity);

  const refreshed = client.refreshRuns();
  const listRequest = await nextRequest();
  assert.deepEqual(listRequest.command, { type: 'list-runs' });
  writeHost({
    type: 'response',
    id: listRequest.id,
    response: {
      ok: true,
      command: 'list-runs',
      runs: [run],
      lastSeq: 2,
    },
  });
  assert.deepEqual(await refreshed, [run]);
  assert.deepEqual(client.listRuns(), [run]);

  const events: AgentHostEvent[] = [];
  const off = client.onEvent((event) => events.push(event));
  const paused = hostRun('paused', { updatedAt: 1_700_000_000_900 });
  writeHost({
    type: 'event',
    event: {
      seq: 3,
      type: 'run-state',
      run: paused,
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [{ seq: 3, type: 'run-state', run: paused }]);
  assert.deepEqual(client.listRuns(), [paused]);

  const cancel = client.sendCommand({ type: 'cancel', runId: run.runId });
  const cancelRequest = await nextRequest();
  assert.deepEqual(cancelRequest.command, { type: 'cancel', runId: run.runId });
  writeHost({
    type: 'response',
    id: cancelRequest.id,
    response: {
      ok: true,
      command: 'cancel',
      run: paused,
      lastSeq: 4,
    },
  });
  assert.deepEqual(await cancel, {
    ok: true,
    command: 'cancel',
    run: paused,
    lastSeq: 4,
  });

  off();
  client.close();
});
