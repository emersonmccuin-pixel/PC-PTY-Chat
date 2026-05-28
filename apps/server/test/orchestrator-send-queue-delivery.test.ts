import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-server-orch-send-delivery-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createOrchestratorSession,
  createProject,
  enqueueOrchestratorSend,
  getOrchestratorSendQueueRow,
  listQueuedOrchestratorSendsForSession,
  runMigrations,
} = await import('@pc/db');
const {
  deliverNextQueuedPromptOnce,
  maybeAdvanceSendQueueConfirmation,
} = await import('../src/services/orchestrator-send-queue-delivery.ts');

const stages = [
  { id: 'todo', name: 'Todo', order: 0 },
  { id: 'done', name: 'Done', order: 1 },
];
let seq = 0;

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeSession() {
  seq += 1;
  const project = createProject({
    slug: `queue-delivery-${Date.now().toString(36)}-${seq}`,
    name: 'Queue Delivery',
    stages,
    folderPath: tmpDir,
  });
  const session = createOrchestratorSession({
    projectId: project.id,
    providerSessionId: `provider-${Date.now().toString(36)}-${seq}`,
  });
  return { project, session };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(condition(), true);
}

test('jsonl confirmation continues queued delivery if the runtime is already ready', async () => {
  const { project, session } = makeSession();
  const first = enqueueOrchestratorSend({
    projectId: project.id,
    sessionId: session.id,
    clientMessageId: 'client-first',
    text: 'first prompt',
    status: 'queued_busy',
  });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = enqueueOrchestratorSend({
    projectId: project.id,
    sessionId: session.id,
    clientMessageId: 'client-second',
    text: 'second prompt',
    status: 'queued_backlog',
  });

  const sent: string[] = [];
  const runtime = {
    ptySession: () => ({
      getState: () => 'ready',
      send: async (text: string) => {
        sent.push(text);
        return 'ok';
      },
    }),
  };
  const broadcasts: string[] = [];
  const broadcast = (_projectId: string, sessionId: string) => broadcasts.push(sessionId);

  await deliverNextQueuedPromptOnce(project.id, runtime, session.id, broadcast);

  assert.deepEqual(sent, ['first prompt']);
  assert.equal(getOrchestratorSendQueueRow(first.id)?.status, 'delivered_to_pty');
  assert.deepEqual(
    listQueuedOrchestratorSendsForSession(session.id).map((row) => row.clientMessageId),
    ['client-second'],
  );

  maybeAdvanceSendQueueConfirmation(
    project.id,
    session.id,
    { kind: 'jsonl-user', text: 'first prompt' },
    runtime,
    broadcast,
  );

  await waitFor(() => sent.length === 2);
  assert.deepEqual(sent, ['first prompt', 'second prompt']);
  assert.equal(getOrchestratorSendQueueRow(first.id)?.status, 'observed_in_jsonl');
  assert.equal(getOrchestratorSendQueueRow(second.id)?.status, 'delivered_to_pty');
  assert.ok(broadcasts.length >= 4);
});
