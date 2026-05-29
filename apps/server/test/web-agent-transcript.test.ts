import assert from 'node:assert/strict';
import { test } from 'node:test';

type AgentTranscriptModule = {
  mergeAgentTranscriptEvents: (input: {
    runId: string;
    backfillEvents: Array<Record<string, unknown>>;
    events: Array<Record<string, unknown>>;
  }) => Array<{ key: string; event: Record<string, unknown> }>;
};

async function loadAgentTranscriptModule(): Promise<AgentTranscriptModule> {
  const moduleUrl = new URL('../../web/src/features/agent-runs/transcript.ts', import.meta.url).href;
  return (await import(moduleUrl)) as AgentTranscriptModule;
}

test('agent transcript merge preserves repeated identical events without stable ids', async () => {
  const { mergeAgentTranscriptEvents } = await loadAgentTranscriptModule();
  const event = { kind: 'jsonl-user', text: 'same prompt' };

  const merged = mergeAgentTranscriptEvents({
    runId: 'run-1',
    backfillEvents: [event, event],
    events: [],
  });

  assert.equal(merged.length, 2);
  assert.notEqual(merged[0]?.key, merged[1]?.key);
  assert.deepEqual(merged.map((item) => item.event), [event, event]);
});

test('agent transcript merge dedupes backfill and live events by stable row id', async () => {
  const { mergeAgentTranscriptEvents } = await loadAgentTranscriptModule();
  const event = {
    kind: 'jsonl-turn-end',
    text: 'done',
    stopReason: 'end_turn',
    row: { uuid: 'row-1' },
  };

  const merged = mergeAgentTranscriptEvents({
    runId: 'run-1',
    backfillEvents: [event],
    events: [
      { projectId: 'project-1', type: 'agent-jsonl-event', runId: 'other', event },
      { projectId: 'project-1', type: 'agent-jsonl-event', runId: 'run-1', event },
    ],
  });

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.key, 'jsonl-turn-end:row:row-1');
  assert.deepEqual(merged[0]?.event, event);
});
