import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-db-orch-send-queue-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  cancelOpenOrchestratorSendsForSession,
  cancelQueuedOrchestratorSend,
  closeDb,
  createOrchestratorSession,
  createProject,
  enqueueOrchestratorSend,
  getOrchestratorSendQueueRow,
  hasOpenOrchestratorSendsForSession,
  listOpenOrchestratorSendsForSession,
  listQueuedOrchestratorSendsForSession,
  listVisibleOrchestratorSendsForSession,
  markOrchestratorSendDelivered,
  markOrchestratorSendDelivering,
  markOrchestratorSendFailed,
  markNextDeliveredOrchestratorSendObservedInJsonl,
  recordDeliveredOrchestratorSend,
  retryFailedOrchestratorSend,
  runMigrations,
} = await import('../src/index.ts');

const stages = [{ name: 'Todo' }, { name: 'Done' }];
let sessionSeq = 0;

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeSession() {
  sessionSeq += 1;
  const project = createProject({
    slug: `queue-${Date.now().toString(36)}-${sessionSeq}`,
    name: 'Queue Test',
    stages,
    folderPath: tmpDir,
  });
  const session = createOrchestratorSession({
    projectId: project.id,
    providerSessionId: `provider-${Date.now().toString(36)}-${sessionSeq}`,
  });
  return { project, session };
}

const waitTick = () => new Promise((resolve) => setTimeout(resolve, 2));

test('orchestrator send queue tracks queued, delivering, delivered, failed, and cancelled rows', async () => {
  const { project, session } = makeSession();

  const first = enqueueOrchestratorSend({
    projectId: project.id,
    sessionId: session.id,
    clientMessageId: 'client-1',
    text: 'first',
    status: 'queued_busy',
  });
  await waitTick();
  const second = enqueueOrchestratorSend({
    projectId: project.id,
    sessionId: session.id,
    clientMessageId: 'client-2',
    text: 'second',
    status: 'queued_backlog',
  });

  assert.equal(hasOpenOrchestratorSendsForSession(session.id), true);
  assert.deepEqual(
    listQueuedOrchestratorSendsForSession(session.id).map((row) => row.clientMessageId),
    ['client-1', 'client-2'],
  );

  markOrchestratorSendDelivering(first.id);
  assert.deepEqual(
    listQueuedOrchestratorSendsForSession(session.id).map((row) => row.clientMessageId),
    ['client-2'],
  );
  assert.equal(
    listOpenOrchestratorSendsForSession(session.id).find((row) => row.id === first.id)?.status,
    'delivering',
  );

  markOrchestratorSendDelivered(first.id);
  assert.equal(
    listOpenOrchestratorSendsForSession(session.id).find((row) => row.id === first.id)?.status,
    'delivered_to_pty',
  );
  assert.deepEqual(
    listVisibleOrchestratorSendsForSession(session.id).map((row) => row.clientMessageId),
    ['client-1', 'client-2'],
  );
  const observed = markNextDeliveredOrchestratorSendObservedInJsonl(session.id, 'first');
  assert.equal(observed?.id, first.id);
  assert.equal(observed?.status, 'observed_in_jsonl');
  assert.deepEqual(
    listOpenOrchestratorSendsForSession(session.id).map((row) => row.clientMessageId),
    ['client-2'],
  );

  markOrchestratorSendFailed(second.id, 'boom');
  assert.deepEqual(listOpenOrchestratorSendsForSession(session.id), []);

  const third = enqueueOrchestratorSend({
    projectId: project.id,
    sessionId: session.id,
    clientMessageId: 'client-3',
    text: 'third',
    status: 'queued_spawning',
  });
  assert.equal(third.status, 'queued_spawning');
  cancelOpenOrchestratorSendsForSession(session.id, 'session replaced');
  assert.deepEqual(listOpenOrchestratorSendsForSession(session.id), []);
});

test('immediate delivered sends stay open and visible until jsonl confirmation', () => {
  const { project, session } = makeSession();
  const row = recordDeliveredOrchestratorSend({
    projectId: project.id,
    sessionId: session.id,
    clientMessageId: 'client-delivered',
    text: 'delivered',
  });
  assert.equal(row.status, 'delivered_to_pty');
  assert.equal(row.deliveryAttempts, 1);
  assert.deepEqual(
    listOpenOrchestratorSendsForSession(session.id).map((item) => item.clientMessageId),
    ['client-delivered'],
  );
  assert.deepEqual(
    listVisibleOrchestratorSendsForSession(session.id).map((item) => item.status),
    ['delivered_to_pty'],
  );
  const observed = markNextDeliveredOrchestratorSendObservedInJsonl(session.id, 'delivered');
  assert.equal(observed?.status, 'observed_in_jsonl');
  assert.deepEqual(listOpenOrchestratorSendsForSession(session.id), []);
  assert.deepEqual(listVisibleOrchestratorSendsForSession(session.id), []);
});

test('jsonl confirmation observes the oldest delivered row for matching session text', async () => {
  const { project, session } = makeSession();
  const other = makeSession();
  const first = recordDeliveredOrchestratorSend({
    projectId: project.id,
    sessionId: session.id,
    clientMessageId: 'client-dup-1',
    text: 'same text',
  });
  await waitTick();
  const second = recordDeliveredOrchestratorSend({
    projectId: project.id,
    sessionId: session.id,
    clientMessageId: 'client-dup-2',
    text: 'same text',
  });
  recordDeliveredOrchestratorSend({
    projectId: other.project.id,
    sessionId: other.session.id,
    clientMessageId: 'client-other',
    text: 'same text',
  });

  const observedFirst = markNextDeliveredOrchestratorSendObservedInJsonl(session.id, 'same text');
  assert.equal(observedFirst?.id, first.id);
  assert.equal(getOrchestratorSendQueueRow(first.id)?.status, 'observed_in_jsonl');
  assert.equal(getOrchestratorSendQueueRow(second.id)?.status, 'delivered_to_pty');
  assert.deepEqual(
    listOpenOrchestratorSendsForSession(other.session.id).map((item) => item.clientMessageId),
    ['client-other'],
  );

  const observedSecond = markNextDeliveredOrchestratorSendObservedInJsonl(session.id, 'same text');
  assert.equal(observedSecond?.id, second.id);
  assert.equal(
    markNextDeliveredOrchestratorSendObservedInJsonl(session.id, 'same text'),
    undefined,
  );
});

test('queued sends can be cancelled before delivery, but delivering sends cannot', () => {
  const { project, session } = makeSession();
  const queued = enqueueOrchestratorSend({
    projectId: project.id,
    sessionId: session.id,
    clientMessageId: 'client-cancel',
    text: 'cancel me',
    status: 'queued_busy',
  });
  const delivering = enqueueOrchestratorSend({
    projectId: project.id,
    sessionId: session.id,
    clientMessageId: 'client-delivering',
    text: 'already going',
    status: 'queued_busy',
  });
  markOrchestratorSendDelivering(delivering.id);

  const cancelled = cancelQueuedOrchestratorSend(queued.id, session.id, 'user cancelled');
  assert.equal(cancelled?.status, 'cancelled');
  assert.equal(cancelled?.failureReason, 'user cancelled');
  assert.equal(cancelQueuedOrchestratorSend(delivering.id, session.id, 'too late'), undefined);
  assert.equal(getOrchestratorSendQueueRow(delivering.id)?.status, 'delivering');
  assert.deepEqual(
    listOpenOrchestratorSendsForSession(session.id).map((row) => row.clientMessageId),
    ['client-delivering'],
  );
});

test('failed sends stay visible and can be retried into the queued FIFO', () => {
  const { project, session } = makeSession();
  const row = enqueueOrchestratorSend({
    projectId: project.id,
    sessionId: session.id,
    clientMessageId: 'client-failed',
    text: 'retry me',
    status: 'queued_busy',
  });
  markOrchestratorSendFailed(row.id, 'pty exited');

  assert.deepEqual(
    listVisibleOrchestratorSendsForSession(session.id).map((item) => item.status),
    ['failed'],
  );

  const retried = retryFailedOrchestratorSend(row.id, session.id, 'queued_backlog');
  assert.equal(retried?.status, 'queued_backlog');
  assert.equal(retried?.failureReason, null);
  assert.equal(retried?.failedAt, null);
  assert.deepEqual(
    listQueuedOrchestratorSendsForSession(session.id).map((item) => item.clientMessageId),
    ['client-failed'],
  );
});
