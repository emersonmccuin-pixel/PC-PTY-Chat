import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Hono } from 'hono';
import type { ULID } from '@pc/domain';
import {
  registerTransientSessionRoutes,
  type TransientSessionPty,
  type TransientSessionsRuntime,
} from '../src/features/transient-sessions/routes.ts';

const projectId = '01HWTRANSIENTSESSIONS0000000' as ULID;

class FakePty extends EventEmitter implements TransientSessionPty {
  state = 'spawning';
  sent: string[] = [];
  rawWrites: string[] = [];
  interrupted = false;

  getState(): string {
    return this.state;
  }

  send(text: string): string {
    this.sent.push(text);
    return 'ok';
  }

  interrupt(): void {
    this.interrupted = true;
  }

  writeRaw(bytes: string): boolean {
    this.rawWrites.push(bytes);
    return true;
  }
}

class FakeRuntime implements TransientSessionsRuntime<FakePty> {
  agentDesigner = new FakePty();
  workflowBuilder = new FakePty();
  setupWizard = new FakePty();
  activeAgentDesigner: FakePty | null = null;
  activeWorkflowBuilder: FakePty | null = null;
  activeSetupWizard: FakePty | null = null;
  resized: Array<{ kind: string; cols: number; rows: number }> = [];
  ended: string[] = [];
  throwAgentStart = false;

  startAgentDesigner(): FakePty {
    if (this.throwAgentStart) throw new Error('agent start failed');
    this.activeAgentDesigner = this.agentDesigner;
    return this.agentDesigner;
  }

  agentDesignerPty(): FakePty | null {
    return this.activeAgentDesigner;
  }

  agentDesignerSession(): string | null {
    return 'ad-session';
  }

  resizeAgentDesigner(cols: number, rows: number): void {
    this.resized.push({ kind: 'agent-designer', cols, rows });
  }

  endAgentDesigner(): void {
    this.ended.push('agent-designer');
    this.activeAgentDesigner = null;
  }

  startWorkflowBuilder(): FakePty {
    this.activeWorkflowBuilder = this.workflowBuilder;
    return this.workflowBuilder;
  }

  workflowBuilderPty(): FakePty | null {
    return this.activeWorkflowBuilder;
  }

  workflowBuilderSession(): string | null {
    return 'wb-session';
  }

  resizeWorkflowBuilder(cols: number, rows: number): void {
    this.resized.push({ kind: 'workflow-builder', cols, rows });
  }

  endWorkflowBuilder(): void {
    this.ended.push('workflow-builder');
    this.activeWorkflowBuilder = null;
  }

  startSetupWizard(): FakePty {
    this.activeSetupWizard = this.setupWizard;
    return this.setupWizard;
  }

  setupWizardPty(): FakePty | null {
    return this.activeSetupWizard;
  }

  setupWizardSession(): string | null {
    return 'sw-session';
  }

  resizeSetupWizard(cols: number, rows: number): void {
    this.resized.push({ kind: 'setup-wizard', cols, rows });
  }

  endSetupWizard(): void {
    this.ended.push('setup-wizard');
    this.activeSetupWizard = null;
  }
}

function makeHarness() {
  const runtime = new FakeRuntime();
  const broadcasts: Array<{ projectId: ULID; msg: unknown }> = [];
  const app = new Hono();
  registerTransientSessionRoutes(app, {
    resolveProject: (id) => (id === projectId ? runtime : null),
    broadcastTo: (id, msg) => broadcasts.push({ projectId: id, msg }),
  });
  return { app, broadcasts, runtime };
}

async function json<T>(res: Response): Promise<T> {
  return await res.json() as T;
}

test('agent-designer start attaches handlers and preserves wire envelope shapes', async () => {
  const { app, broadcasts, runtime } = makeHarness();

  const res = await app.request(`/api/projects/${projectId}/agent-designer/start`, {
    method: 'POST',
  });
  const body = await json<{ ok: boolean; state: string; sessionId: string | null }>(res);

  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true, state: 'spawning', sessionId: 'ad-session' });
  assert.deepEqual(broadcasts.map(({ msg }) => msg), [
    { type: 'agent-designer-state', sessionId: 'ad-session', state: 'spawning' },
  ]);

  runtime.agentDesigner.emit('raw', 'hello');
  runtime.agentDesigner.emit('raw', 'again');
  runtime.agentDesigner.emit('state', 'ready');
  runtime.agentDesigner.emit('event', { hook: 'legacy' });
  runtime.agentDesigner.emit('jsonl-event', { kind: 'jsonl-user' });
  runtime.agentDesigner.emit('exit', 0, undefined);

  assert.deepEqual(broadcasts.slice(1).map(({ msg }) => msg), [
    { type: 'agent-designer-raw', sessionId: 'ad-session', terminalSeq: 1, text: 'hello' },
    { type: 'agent-designer-raw', sessionId: 'ad-session', terminalSeq: 2, text: 'again' },
    { type: 'agent-designer-state', sessionId: 'ad-session', state: 'ready' },
    { type: 'agent-designer-event', sessionId: 'ad-session', event: { hook: 'legacy' } },
    { type: 'agent-designer-jsonl', sessionId: 'ad-session', event: { kind: 'jsonl-user' } },
    { type: 'agent-designer-exit', sessionId: 'ad-session', code: 0, signal: undefined },
  ]);
});

test('transient handler attachment is idempotent per PTY session', async () => {
  const { app, broadcasts, runtime } = makeHarness();

  await app.request(`/api/projects/${projectId}/workflow-builder/start`, { method: 'POST' });
  await app.request(`/api/projects/${projectId}/workflow-builder/start`, { method: 'POST' });
  broadcasts.length = 0;

  runtime.workflowBuilder.emit('state', 'ready');

  assert.equal(runtime.workflowBuilder.listenerCount('state'), 1);
  assert.deepEqual(broadcasts.map(({ msg }) => msg), [
    { type: 'workflow-builder-state', sessionId: 'wb-session', state: 'ready' },
  ]);
});

test('shared control routes send, interrupt, terminal-input, resize, and stop a session', async () => {
  const { app, runtime } = makeHarness();
  await app.request(`/api/projects/${projectId}/workflow-builder/start`, { method: 'POST' });

  let res = await app.request(`/api/projects/${projectId}/workflow-builder/send`, {
    method: 'POST',
    body: JSON.stringify({ text: 'draft a workflow' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(runtime.workflowBuilder.sent, ['draft a workflow']);

  res = await app.request(`/api/projects/${projectId}/workflow-builder/terminal-input`, {
    method: 'POST',
    body: JSON.stringify({ data: 'abc' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, bytesWritten: 3 });
  assert.deepEqual(runtime.workflowBuilder.rawWrites, ['abc']);

  res = await app.request(`/api/projects/${projectId}/workflow-builder/resize`, {
    method: 'POST',
    body: JSON.stringify({ cols: 120, rows: 32 }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(runtime.resized, [{ kind: 'workflow-builder', cols: 120, rows: 32 }]);

  res = await app.request(`/api/projects/${projectId}/workflow-builder/interrupt`, {
    method: 'POST',
  });
  assert.equal(res.status, 200);
  assert.equal(runtime.workflowBuilder.interrupted, true);

  res = await app.request(`/api/projects/${projectId}/workflow-builder`, {
    method: 'DELETE',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(runtime.ended, ['workflow-builder']);
  assert.equal(runtime.workflowBuilderPty(), null);
});

test('shared routes preserve not-found, no-session, validation, and start-error responses', async () => {
  const { app, runtime } = makeHarness();

  let res = await app.request('/api/projects/missing/setup-wizard/send', {
    method: 'POST',
    body: JSON.stringify({ text: 'hello' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await json(res), { ok: false, error: 'unknown project: missing' });

  res = await app.request(`/api/projects/${projectId}/setup-wizard/send`, {
    method: 'POST',
    body: JSON.stringify({ text: 'hello' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 409);
  assert.deepEqual(await json(res), { ok: false, error: 'no setup-wizard session' });

  await app.request(`/api/projects/${projectId}/setup-wizard/start`, { method: 'POST' });
  res = await app.request(`/api/projects/${projectId}/setup-wizard/send`, {
    method: 'POST',
    body: JSON.stringify({ text: '' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), { ok: false, error: 'text required' });

  runtime.throwAgentStart = true;
  res = await app.request(`/api/projects/${projectId}/agent-designer/start`, {
    method: 'POST',
  });
  assert.equal(res.status, 500);
  assert.deepEqual(await json(res), { ok: false, error: 'agent start failed' });
});
