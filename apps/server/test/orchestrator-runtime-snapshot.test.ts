import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ULID } from '@pc/domain';
import type { RuntimeSnapshotRuntime } from '../src/services/orchestrator-runtime-snapshot.ts';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-server-runtime-snapshot-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createOrchestratorSession,
  createProject,
  enqueueOrchestratorSend,
  runMigrations,
  setOrchestratorSessionJsonlCursor,
  setOrchestratorSessionJsonlPath,
} = await import('@pc/db');
const {
  OrchestratorRuntimeSnapshots,
} = await import('../src/services/orchestrator-runtime-snapshot.ts');

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
    slug: `runtime-snapshot-${Date.now().toString(36)}-${seq}`,
    name: 'Runtime Snapshot',
    stages,
    folderPath: join(tmpDir, `project-${seq}`),
  });
  const session = createOrchestratorSession({
    projectId: project.id,
    providerSessionId: `provider-${Date.now().toString(36)}-${seq}`,
  });
  return { project, session };
}

function makeRuntime(): RuntimeSnapshotRuntime {
  return {
    folderPath: join(tmpDir, 'worktree'),
    sessionDataPath: (sessionId: ULID) => {
      const dir = join(tmpDir, 'sessions', sessionId);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    orchestratorPtyState: () => 'ready',
    orchestratorRuntimeSnapshot: () => ({
      spawnAttemptId: 'spawn-1',
      spawnAttempt: 1,
      lastReadyAt: 1_000,
      nextRetryAt: null,
      runtimeFailureReason: null,
    }),
  };
}

function replayFileFor(runtime: RuntimeSnapshotRuntime, sessionId: ULID): string {
  return join(runtime.sessionDataPath(sessionId), 'jsonl-events.jsonl');
}

test('refresh snapshot recomputes replay high-water and line count from disk', () => {
  const { project, session } = makeSession();
  const runtime = makeRuntime();
  const rawJsonlPath = join(tmpDir, 'raw', `${session.id}.jsonl`);
  mkdirSync(join(tmpDir, 'raw'), { recursive: true });
  writeFileSync(rawJsonlPath, JSON.stringify({ type: 'user', message: 'first' }) + '\n');
  setOrchestratorSessionJsonlPath(session.id, rawJsonlPath);
  setOrchestratorSessionJsonlCursor(session.id, 7);

  const replayFile = replayFileFor(runtime, session.id);
  appendFileSync(
    replayFile,
    JSON.stringify({
      id: `${session.id}:1`,
      sessionId: session.id,
      seq: 1,
      type: 'jsonl',
      kind: 'jsonl-user',
      event: { kind: 'jsonl-user', text: 'first' },
      source: { kind: 'claude-jsonl', cursor: 7 },
    }) + '\n',
  );

  const snapshots = new OrchestratorRuntimeSnapshots();
  const first = snapshots.payload(project.id, runtime);

  assert.equal(first.sessionId, session.id);
  assert.equal(first.rawJsonlPath, rawJsonlPath);
  assert.equal(first.rawJsonlExists, true);
  assert.equal(first.rawJsonlCursor, 7);
  assert.equal(first.replayHighWaterSeq, 1);
  assert.equal(first.replayLineCount, 1);

  appendFileSync(
    replayFile,
    JSON.stringify({
      id: `${session.id}:2`,
      sessionId: session.id,
      seq: 2,
      type: 'jsonl',
      kind: 'jsonl-assistant',
      event: { kind: 'jsonl-assistant', text: 'second' },
      source: { kind: 'claude-jsonl', cursor: 8 },
    }) + '\n',
  );
  setOrchestratorSessionJsonlCursor(session.id, 8);

  const refreshed = snapshots.payload(project.id, runtime);
  assert.equal(refreshed.replayHighWaterSeq, 2);
  assert.equal(refreshed.replayLineCount, 2);
  assert.equal(refreshed.rawJsonlCursor, 8);
});

test('reconnect snapshot rebuilds persisted replay and queue state without lifecycle memory', () => {
  const { project, session } = makeSession();
  const runtime = makeRuntime();
  const replayFile = replayFileFor(runtime, session.id);
  appendFileSync(
    replayFile,
    JSON.stringify({
      id: `${session.id}:5`,
      sessionId: session.id,
      seq: 5,
      type: 'jsonl',
      kind: 'jsonl-user',
      event: { kind: 'jsonl-user', text: 'persisted prompt' },
      source: { kind: 'claude-jsonl', cursor: 12 },
    }) + '\n',
  );
  const queued = enqueueOrchestratorSend({
    projectId: project.id,
    sessionId: session.id,
    clientMessageId: 'client-reconnect',
    text: 'queued while busy',
    status: 'queued_busy',
  });

  const reconnectSnapshots = new OrchestratorRuntimeSnapshots();
  const snapshot = reconnectSnapshots.payload(project.id, runtime);

  assert.equal(snapshot.sessionId, session.id);
  assert.equal(snapshot.replayExists, true);
  assert.equal(snapshot.replayHighWaterSeq, 5);
  assert.equal(snapshot.replayLineCount, 1);
  assert.equal(snapshot.queueDepth, 1);
  assert.equal(snapshot.queue[0]?.id, queued.id);
  assert.equal(snapshot.lastActivityAt, session.startedAt);
});
