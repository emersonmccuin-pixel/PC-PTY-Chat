import assert from 'node:assert/strict';
import { test } from 'node:test';

type RuntimeStateModule = {
  deriveJsonlBusy: (events: Array<Record<string, unknown>>) => boolean | null;
  deriveLiveState: (events: Array<Record<string, unknown>>) => string | null;
  isRuntimeThinking: (
    liveState: string | null,
    jsonlBusy: boolean | null,
  ) => boolean;
};

async function loadRuntimeStateModule(): Promise<RuntimeStateModule> {
  const moduleUrl = new URL('../../web/src/features/chat/runtimeState.ts', import.meta.url).href;
  return (await import(moduleUrl)) as RuntimeStateModule;
}

test('legacy turn-end remains a live-state ready fallback', async () => {
  const { deriveJsonlBusy, deriveLiveState, isRuntimeThinking } =
    await loadRuntimeStateModule();
  const events = [
    { projectId: 'project-1', type: 'state', state: 'thinking' },
    { projectId: 'project-1', type: 'turn-end' },
  ];

  const liveState = deriveLiveState(events);
  const jsonlBusy = deriveJsonlBusy(events);

  assert.equal(liveState, 'ready');
  assert.equal(jsonlBusy, null);
  assert.equal(isRuntimeThinking(liveState, jsonlBusy), false);
});

test('jsonl turn-end clears busy state without the legacy envelope', async () => {
  const { deriveJsonlBusy, isRuntimeThinking } = await loadRuntimeStateModule();
  const events = [
    { projectId: 'project-1', type: 'state', state: 'thinking' },
    {
      projectId: 'project-1',
      type: 'jsonl',
      event: { kind: 'jsonl-user', text: 'run tests' },
    },
    {
      projectId: 'project-1',
      type: 'jsonl',
      event: { kind: 'jsonl-turn-end', text: 'done', stopReason: 'end_turn' },
    },
  ];

  const jsonlBusy = deriveJsonlBusy(events);

  assert.equal(jsonlBusy, false);
  assert.equal(isRuntimeThinking('thinking', jsonlBusy), false);
});
