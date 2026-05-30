import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-live-outbox-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createProject,
  getDb,
  getProjectById,
  insertLiveEvent,
  listLiveEventsAfter,
  runMigrations,
  updateProjectMetaInDb,
  LiveEventCursorError,
} = await import('../src/index.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

test('live outbox inserts global events and replays by exclusive cursor', () => {
  const first = insertLiveEvent(getDb(), {
    scope: 'global',
    projectId: null,
    type: 'project.changed',
    entity: 'project',
    entityId: 'p1',
    version: null,
    payload: { reason: 'created', projectIdChanged: 'p1' },
    createdAt: 1,
  });
  const second = insertLiveEvent(getDb(), {
    scope: 'global',
    projectId: null,
    type: 'project.changed',
    entity: 'project',
    entityId: 'p2',
    version: null,
    payload: { reason: 'metadata-updated', projectIdChanged: 'p2' },
    createdAt: 2,
  });

  assert.equal(first.cursor, '1');
  assert.equal(second.cursor, '2');
  assert.deepEqual(listLiveEventsAfter({ after: first.cursor, type: 'project.changed' }), {
    events: [second],
    nextCursor: second.cursor,
  });
});

test('live replay filters global/project rows and excludes other projects', () => {
  const p1 = createProject({
    slug: `outbox-p1-${Date.now()}`,
    name: 'Outbox P1',
    stages,
    folderPath: join(tmpDir, 'p1'),
  });
  const p2 = createProject({
    slug: `outbox-p2-${Date.now()}`,
    name: 'Outbox P2',
    stages,
    folderPath: join(tmpDir, 'p2'),
  });
  const highWater = listLiveEventsAfter({}).nextCursor ?? '0';

  const global = insertLiveEvent(getDb(), {
    scope: 'global',
    projectId: null,
    type: 'project.changed',
    entity: 'project',
    entityId: p1.id,
    version: null,
    payload: { reason: 'reordered' },
  });
  const scopedP1 = insertLiveEvent(getDb(), {
    scope: 'project',
    projectId: p1.id,
    type: 'project.changed',
    entity: 'project',
    entityId: p1.id,
    version: null,
    payload: { reason: 'metadata-updated', projectIdChanged: p1.id },
  });
  insertLiveEvent(getDb(), {
    scope: 'project',
    projectId: p2.id,
    type: 'project.changed',
    entity: 'project',
    entityId: p2.id,
    version: null,
    payload: { reason: 'metadata-updated', projectIdChanged: p2.id },
  });

  assert.deepEqual(
    listLiveEventsAfter({ after: highWater, projectId: p1.id, includeGlobal: true }).events.map(
      (event) => event.id,
    ),
    [global.id, scopedP1.id],
  );
  assert.deepEqual(
    listLiveEventsAfter({ after: highWater, projectId: p1.id, includeGlobal: false }).events.map(
      (event) => event.id,
    ),
    [scopedP1.id],
  );
  assert.deepEqual(
    listLiveEventsAfter({ after: highWater }).events.map((event) => event.id),
    [global.id],
  );
});

test('no-cursor replay returns no history and advances to high-water', () => {
  const highWater = listLiveEventsAfter({}).nextCursor;
  const replay = listLiveEventsAfter({ limit: 10 });

  assert.deepEqual(replay.events, []);
  assert.equal(replay.nextCursor, highWater);
});

test('live outbox rejects malformed cursors and invalid scope/project combinations', () => {
  assert.throws(
    () => listLiveEventsAfter({ after: 'not-a-cursor' }),
    LiveEventCursorError,
  );
  assert.throws(
    () =>
      insertLiveEvent(getDb(), {
        scope: 'global',
        projectId: 'p1',
        type: 'project.changed',
        entity: 'project',
        entityId: 'p1',
        version: null,
        payload: { reason: 'created' },
      }),
    /global live events must not carry projectId/,
  );
});

test('project mutation and outbox insert roll back together in one transaction', () => {
  const project = createProject({
    slug: `rollback-${Date.now()}`,
    name: 'Rollback Original',
    stages,
    folderPath: join(tmpDir, 'rollback'),
  });
  const after = listLiveEventsAfter({}).nextCursor ?? '0';

  assert.throws(() => {
    getDb().transaction((tx) => {
      updateProjectMetaInDb(tx, project.id, { name: 'Rolled Back' });
      insertLiveEvent(tx, {
        scope: 'global',
        projectId: project.id,
        type: 'project.changed',
        entity: 'project',
        entityId: project.id,
        version: null,
        payload: { reason: 'metadata-updated', projectIdChanged: project.id },
      });
    });
  }, /global live events must not carry projectId/);

  assert.equal(getProjectById(project.id)?.name, 'Rollback Original');
  assert.deepEqual(listLiveEventsAfter({ after }).events, []);
});
