import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';

import type { ULID } from '@pc/domain';
import type {
  AgentHostCommand,
  AgentHostEndpoint,
  AgentHostEvent,
  AgentHostIdentity,
  AgentHostRunSnapshot,
} from '@pc/runtime';
import { agentHostLockFilePath } from '@pc/runtime';

import {
  HttpAgentHostClient,
  JsonLineAgentHostClient,
  resolveAgentHostClientForBoot,
} from '../src/services/agent-host-client.ts';
import type { AgentHostReattachClient } from '../src/services/agent-host-reattach.ts';

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

test('resolveAgentHostClientForBoot discovers a live lock file and uses the connector', async () => {
  const dataDir = join(tmpdir(), `pc-agent-host-${process.pid}-${Date.now()}`);
  const lockPath = agentHostLockFilePath(dataDir);
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(
    lockPath,
    JSON.stringify({
      pid: 4321,
      hostId: 'host-lock-1',
      port: 43123,
      startedAt: 1_700_000_000_000,
      protocolVersion: 1,
    }),
  );

  const fakeClient: AgentHostReattachClient = {
    listRuns: () => [],
    sendCommand: () => undefined,
  };
  let connectedEndpoint: AgentHostEndpoint | null = null;

  const resolved = await resolveAgentHostClientForBoot({
    dataDir,
    isPidAlive: (pid) => pid === 4321,
    connect: (endpoint) => {
      connectedEndpoint = endpoint;
      return fakeClient;
    },
  });

  assert.equal(resolved, fakeClient);
  assert.deepEqual(connectedEndpoint, {
    lockFilePath: lockPath,
    lock: {
      pid: 4321,
      hostId: 'host-lock-1',
      port: 43123,
      startedAt: 1_700_000_000_000,
      protocolVersion: 1,
    },
    baseUrl: 'http://127.0.0.1:43123',
  });
});

test('resolveAgentHostClientForBoot ignores stale lock files', async () => {
  const dataDir = join(tmpdir(), `pc-agent-host-stale-${process.pid}-${Date.now()}`);
  const lockPath = agentHostLockFilePath(dataDir);
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(
    lockPath,
    JSON.stringify({
      pid: 4321,
      hostId: 'host-lock-1',
      port: 43123,
      startedAt: 1_700_000_000_000,
      protocolVersion: 1,
    }),
  );

  let connected = false;
  const resolved = await resolveAgentHostClientForBoot({
    dataDir,
    isPidAlive: () => false,
    connect: () => {
      connected = true;
      throw new Error('should not connect');
    },
  });

  assert.equal(resolved, null);
  assert.equal(connected, false);
});

test('HttpAgentHostClient sends commands over localhost HTTP and caches snapshots', async () => {
  const hostIdentity = identity();
  const run = hostRun('running', { runId: '01KHTTPCLIENT000000000001' as ULID });
  const calls: Array<{ url: string; command: AgentHostCommand }> = [];
  const client = new HttpAgentHostClient('http://127.0.0.1:43123', {
    fetch: async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { command: AgentHostCommand };
      calls.push({ url: String(input), command: body.command });
      if (body.command.type === 'hello') {
        return jsonResponse({
          ok: true,
          command: 'hello',
          identity: hostIdentity,
          lastSeq: 1,
        });
      }
      if (body.command.type === 'list-runs') {
        return jsonResponse({
          ok: true,
          command: 'list-runs',
          runs: [run],
          lastSeq: 2,
        });
      }
      if (body.command.type === 'cancel') {
        return jsonResponse({
          ok: true,
          command: 'cancel',
          run: { ...run, state: 'cancelled', terminalAt: 1_700_000_000_900 },
          lastSeq: 3,
        });
      }
      throw new Error(`unexpected command ${body.command.type}`);
    },
  });

  assert.deepEqual(await client.hello(1234), hostIdentity);
  assert.deepEqual(await client.refreshRuns(), [run]);
  assert.deepEqual(client.listRuns(), [run]);
  await client.sendCommand({ type: 'cancel', runId: run.runId });
  assert.equal(client.listRuns()[0]?.state, 'cancelled');
  assert.deepEqual(
    calls.map((call) => [call.url, call.command.type]),
    [
      ['http://127.0.0.1:43123/command', 'hello'],
      ['http://127.0.0.1:43123/command', 'list-runs'],
      ['http://127.0.0.1:43123/command', 'cancel'],
    ],
  );
  client.close();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
