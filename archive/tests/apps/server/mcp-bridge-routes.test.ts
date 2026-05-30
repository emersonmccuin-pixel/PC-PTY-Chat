import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Hono } from 'hono';

import {
  registerMcpBridgeRoutes,
  type McpBridgeActiveRunRegistry,
  type McpBridgeHostClient,
} from '../src/features/mcp-bridge/routes.ts';

async function json<T>(res: Response): Promise<T> {
  return await res.json() as T;
}

function makeStatusHarness(files: Map<string, string | null>, now: number) {
  const app = new Hono();
  const readPaths: string[] = [];
  registerMcpBridgeRoutes(app, {
    dataDir: 'E:/pc-data',
    resolveProject: () => null,
    now: () => now,
    readFileText: (path) => {
      readPaths.push(path);
      return files.get(path) ?? null;
    },
    getActiveRunRegistry: () => ({ getByCcSession: () => null }),
    notifyWorkflowSubagentHandshake: () => false,
  });
  return { app, readPaths };
}

test('mcp status route preserves missing, alive, stale, and corrupt envelopes', async () => {
  const now = Date.parse('2026-05-27T12:00:07.000Z');
  const alivePath = 'E:\\pc-data\\projects\\project-1\\mcp-status.json';
  const stalePath = 'E:\\pc-data\\projects\\project-2\\mcp-status.json';
  const corruptPath = 'E:\\pc-data\\mcp-status.json';
  const files = new Map<string, string | null>([
    [
      alivePath,
      JSON.stringify({
        aliveAt: '2026-05-27T12:00:00.000Z',
        toolCount: 3,
        tools: ['pc_a', 'pc_b', 'pc_c'],
      }),
    ],
    [
      stalePath,
      JSON.stringify({
        aliveAt: '2026-05-27T11:59:58.999Z',
        toolCount: 3,
        tools: ['pc_a'],
      }),
    ],
    [corruptPath, '{'],
  ]);
  const { app } = makeStatusHarness(files, now);

  let res = await app.request('/api/mcp-status?projectId=project-1');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), {
    alive: true,
    toolCount: 3,
    tools: ['pc_a', 'pc_b', 'pc_c'],
  });

  res = await app.request('/api/mcp-status?projectId=project-2');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { alive: false, toolCount: 0, tools: [] });

  res = await app.request('/api/mcp-status');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { alive: false, toolCount: 0, tools: [] });

  res = await app.request('/api/mcp-status?projectId=missing');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { alive: false, toolCount: 0, tools: [] });
});

test('mcp handshake route preserves validation and agent/workflow/orchestrator priority', async () => {
  const notified: string[] = [];
  const workflowNotifications: string[] = [];
  const hostNotifications: string[] = [];
  const orchestratorNotifications: string[] = [];
  const registry: McpBridgeActiveRunRegistry = {
    getByCcSession: (sessionId) =>
      sessionId === 'agent-session'
        ? {
            run: {
              notifyMcpHandshake: () => notified.push(sessionId),
            },
          }
        : null,
  };
  const app = new Hono();
  const hostClient: McpBridgeHostClient = {
    sendCommand: (command) => {
      if (command.type !== 'notify-mcp-handshake') {
        throw new Error(`unexpected command ${command.type}`);
      }
      hostNotifications.push(command.ccSessionId);
      if (command.ccSessionId === 'host-workflow-session') {
        return {
          ok: true,
          command: 'notify-mcp-handshake',
          lastSeq: 1,
        };
      }
      return {
        ok: false,
        command: 'notify-mcp-handshake',
        code: 'not-found',
        error: 'missing',
        lastSeq: 1,
      };
    },
  };
  registerMcpBridgeRoutes(app, {
    dataDir: 'E:/pc-data',
    resolveProject: (projectId) =>
      projectId === 'project-1'
        ? {
            notifyOrchestratorMcpHandshake: (sessionId) => {
              orchestratorNotifications.push(sessionId);
              return sessionId === 'orchestrator-session';
            },
          }
        : null,
    readFileText: () => null,
    getActiveRunRegistry: () => registry,
    notifyWorkflowSubagentHandshake: (sessionId) => {
      workflowNotifications.push(sessionId);
      return sessionId === 'workflow-session';
    },
    getHostClient: () => hostClient,
  });

  let res = await app.request('/api/internal/mcp-handshake', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'project-1' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), {
    ok: false,
    error: 'projectId + agentSessionId required',
  });

  res = await app.request('/api/internal/mcp-handshake', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'project-1', agentSessionId: 'agent-session' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, found: true, transport: 'agent' });
  assert.deepEqual(notified, ['agent-session']);
  assert.deepEqual(workflowNotifications, []);
  assert.deepEqual(orchestratorNotifications, []);

  res = await app.request('/api/internal/mcp-handshake', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'project-1', agentSessionId: 'workflow-session' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, found: true, transport: 'workflow' });
  assert.deepEqual(hostNotifications, []);

  res = await app.request('/api/internal/mcp-handshake', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'project-1', agentSessionId: 'host-workflow-session' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, found: true, transport: 'workflow-host' });
  assert.deepEqual(hostNotifications, ['host-workflow-session']);

  res = await app.request('/api/internal/mcp-handshake', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'project-1', agentSessionId: 'orchestrator-session' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, found: true, transport: 'orchestrator' });
  assert.deepEqual(hostNotifications, ['host-workflow-session', 'orchestrator-session']);

  res = await app.request('/api/internal/mcp-handshake', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'project-1', agentSessionId: 'missing-session' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, found: false });
  assert.deepEqual(hostNotifications, [
    'host-workflow-session',
    'orchestrator-session',
    'missing-session',
  ]);
});
