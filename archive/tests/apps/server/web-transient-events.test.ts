import assert from 'node:assert/strict';
import { test } from 'node:test';

type TransientEventsModule = {
  adaptTransientEvents: (input: {
    events: readonly WsEvent[];
    projectId: string;
    sessionId: string | null;
    initialState: 'spawning' | 'ready' | 'thinking' | 'exited';
    prefix: string;
    includeAsk?: boolean;
    includeSessionIdOnJsonl?: boolean;
    hiddenUserText?: (text: string) => false | 'drop' | 'drop-with-next-turn-end';
  }) => { envelopes: WsEvent[]; state: 'spawning' | 'ready' | 'thinking' | 'exited' };
  belongsToTransientSession: (env: WsEvent, sessionId: string | null) => boolean;
  isTransientSessionState: (value: unknown) => boolean;
  isWarmupOkUserText: (text: string) => boolean;
  mergeTransientSessionState: (
    prev: 'spawning' | 'ready' | 'thinking' | 'exited',
    next: 'spawning' | 'ready' | 'thinking' | 'exited',
  ) => 'spawning' | 'ready' | 'thinking' | 'exited';
};

type WsEvent = {
  projectId: string;
  type: string;
  [key: string]: unknown;
};

async function loadTransientEventsModule(): Promise<TransientEventsModule> {
  const moduleUrl = new URL('../../web/src/features/transient-sessions/events.ts', import.meta.url).href;
  return (await import(moduleUrl)) as TransientEventsModule;
}

function env(type: string, patch: Record<string, unknown> = {}): WsEvent {
  return { projectId: 'project-1', type, ...patch };
}

test('transient event adapter normalizes state, jsonl, raw, and exit envelopes by session', async () => {
  const { adaptTransientEvents } = await loadTransientEventsModule();

  const adapted = adaptTransientEvents({
    projectId: 'project-1',
    sessionId: 'session-1',
    initialState: 'spawning',
    prefix: 'agent-designer',
    events: [
      env('agent-designer-state', { sessionId: 'other', state: 'ready' }),
      env('agent-designer-state', { sessionId: 'session-1', state: 'ready' }),
      env('agent-designer-jsonl', {
        sessionId: 'session-1',
        event: { kind: 'jsonl-user', text: 'hello' },
      }),
      env('agent-designer-raw', {
        sessionId: 'session-1',
        terminalSeq: 1,
        text: 'raw',
      }),
      env('agent-designer-exit', { sessionId: 'session-1' }),
    ],
  });

  assert.equal(adapted.state, 'exited');
  assert.deepEqual(adapted.envelopes, [
    { projectId: 'project-1', type: 'state', state: 'ready' },
    {
      projectId: 'project-1',
      type: 'jsonl',
      event: { kind: 'jsonl-user', text: 'hello' },
    },
    {
      projectId: 'project-1',
      type: 'raw',
      sessionId: 'session-1',
      terminalSeq: 1,
      text: 'raw',
    },
  ]);
});

test('transient event adapter filters hidden user text and optional following turn end', async () => {
  const { adaptTransientEvents, isWarmupOkUserText } = await loadTransientEventsModule();

  const adapted = adaptTransientEvents({
    projectId: 'project-1',
    sessionId: 'session-1',
    initialState: 'ready',
    prefix: 'workflow-builder',
    hiddenUserText: (text) =>
      isWarmupOkUserText(text) ? 'drop-with-next-turn-end' : false,
    events: [
      env('workflow-builder-jsonl', {
        sessionId: 'session-1',
        event: { kind: 'jsonl-user', text: 'Reply with only the word OK.' },
      }),
      env('workflow-builder-jsonl', {
        sessionId: 'session-1',
        event: { kind: 'jsonl-turn-end', text: 'ok', stopReason: 'end_turn' },
      }),
      env('workflow-builder-jsonl', {
        sessionId: 'session-1',
        event: { kind: 'jsonl-user', text: 'real prompt' },
      }),
    ],
  });

  assert.deepEqual(adapted.envelopes, [
    {
      projectId: 'project-1',
      type: 'jsonl',
      event: { kind: 'jsonl-user', text: 'real prompt' },
    },
  ]);
});

test('transient event adapter supports ask passthrough and setup-wizard jsonl session ids', async () => {
  const { adaptTransientEvents } = await loadTransientEventsModule();

  const adapted = adaptTransientEvents({
    projectId: 'project-1',
    sessionId: 'session-1',
    initialState: 'ready',
    prefix: 'setup-wizard',
    includeAsk: true,
    includeSessionIdOnJsonl: true,
    events: [
      env('setup-wizard-jsonl', {
        sessionId: 'session-1',
        event: { kind: 'jsonl-user', text: 'answer' },
      }),
      env('ask', { sessionId: 'session-1', toolUseId: 'ask-1' }),
      env('ask', { sessionId: 'other', toolUseId: 'ask-2' }),
    ],
  });

  assert.deepEqual(adapted.envelopes, [
    {
      projectId: 'project-1',
      type: 'jsonl',
      sessionId: 'session-1',
      event: { kind: 'jsonl-user', text: 'answer' },
    },
    { projectId: 'project-1', type: 'ask', sessionId: 'session-1', toolUseId: 'ask-1' },
  ]);
});

test('transient state helpers validate states and preserve non-spawning lifecycle state', async () => {
  const {
    belongsToTransientSession,
    isTransientSessionState,
    mergeTransientSessionState,
  } = await loadTransientEventsModule();

  assert.equal(isTransientSessionState('ready'), true);
  assert.equal(isTransientSessionState('paused'), false);
  assert.equal(belongsToTransientSession(env('x', { sessionId: 'session-1' }), 'session-1'), true);
  assert.equal(belongsToTransientSession(env('x', { sessionId: 'other' }), 'session-1'), false);
  assert.equal(mergeTransientSessionState('ready', 'spawning'), 'ready');
  assert.equal(mergeTransientSessionState('spawning', 'ready'), 'ready');
});
