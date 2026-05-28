import assert from 'node:assert/strict';
import { test } from 'node:test';

type PendingPromptsModule = {
  confirmedPendingIds: (events: unknown[], pendingPrompts: unknown[]) => Set<string>;
  pendingPromptEnvelope: (projectId: string, pending: unknown) => unknown;
};

async function loadPendingPromptsModule(): Promise<PendingPromptsModule> {
  const moduleUrl = new URL(
    '../../web/src/features/chat/usePendingPrompts.ts',
    import.meta.url,
  ).href;
  return (await import(moduleUrl)) as PendingPromptsModule;
}

test('pending prompt envelope preserves optimistic prompt metadata', async () => {
  const { pendingPromptEnvelope } = await loadPendingPromptsModule();
  const envelope = pendingPromptEnvelope('project-1', {
    id: 'client-message-1',
    text: 'Ship the refactor',
    createdAt: 1234,
    eventFloor: 2,
    status: 'sending',
    expectsAck: true,
    queued: false,
  }) as { projectId: string; type: string; event: unknown };

  assert.equal(envelope.projectId, 'project-1');
  assert.equal(envelope.type, 'event');
  assert.deepEqual(envelope.event, {
    kind: 'user',
    text: 'Ship the refactor',
    ts: new Date(1234).toISOString(),
    pendingStatus: 'sending',
    pendingReason: undefined,
    pendingClientMessageId: 'client-message-1',
    pendingQueued: false,
  });
});

test('pending prompts confirm from matching transcript text after their event floor', async () => {
  const { confirmedPendingIds } = await loadPendingPromptsModule();
  const pending = {
    id: 'client-message-1',
    text: 'Run the focused typecheck',
    createdAt: 1234,
    eventFloor: 1,
    status: 'sending' as const,
    expectsAck: true,
    queued: false,
  };
  const events = [
    {
      projectId: 'project-1',
      type: 'jsonl',
      event: { kind: 'jsonl-user', text: 'Run the focused typecheck' },
    },
    {
      projectId: 'project-1',
      type: 'event',
      event: { kind: 'user', text: 'Run the focused typecheck' },
    },
  ];

  assert.deepEqual(confirmedPendingIds(events, [pending]), new Set(['client-message-1']));
});

test('pending prompts confirm from observed send-queue snapshots', async () => {
  const { confirmedPendingIds } = await loadPendingPromptsModule();
  const pending = {
    id: 'client-message-1',
    text: 'Run the focused typecheck',
    createdAt: 1234,
    eventFloor: 99,
    status: 'server-received' as const,
    expectsAck: true,
    queued: true,
  };
  const events = [
    {
      projectId: 'project-1',
      type: 'send-queue-snapshot',
      sessionId: 'session-1',
      items: [
        {
          id: 'send-1',
          clientMessageId: 'client-message-1',
          text: 'Run the focused typecheck',
          status: 'observed_in_jsonl',
          createdAt: 1,
          updatedAt: 2,
          deliveryAttempts: 1,
          failureReason: null,
        },
      ],
    },
  ];

  assert.deepEqual(confirmedPendingIds(events, [pending]), new Set(['client-message-1']));
});
