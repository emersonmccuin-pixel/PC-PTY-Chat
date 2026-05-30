import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import type { Project, ULID } from '@pc/domain';
import {
  buildLiveEventFrame,
  buildProjectChangedRefetchEnvelope,
  type ProjectChangedLiveEvent,
  type ProjectChangedRefetchEnvelope,
} from '@pc/contracts';
import {
  buildProjectChangedLiveEventDraft,
  toProjectDto,
} from '@pc/app-services';
import type { CreateProjectFlowInput } from '../src/services/project-create.ts';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-project-routes-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createProject: dbCreateProject,
  getProjectById,
  getDb,
  insertLiveEvent,
  listLiveEventsAfter,
  runMigrations,
} = await import('@pc/db');
const {
  registerProjectDetailRoute,
  registerProjectRoutes,
} = await import('../src/features/projects/routes.ts');
const { ProjectWebSocketHub } = await import('../src/services/websocket-hub.ts');

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

function makeProject(label: string): Project {
  seq += 1;
  const folderPath = join(tmpDir, `project-${label}-${seq}`);
  mkdirSync(folderPath, { recursive: true });
  return dbCreateProject({
    slug: `project-${label}-${Date.now().toString(36)}-${seq}`,
    name: `Project ${label}`,
    stages,
    folderPath,
  });
}

function makeHarness() {
  const createdInputs: CreateProjectFlowInput[] = [];
  const refreshed: Project[] = [];
  const removed: ULID[] = [];
  const revealed: string[] = [];
  const published: Array<{
    legacyEvent: ProjectChangedRefetchEnvelope;
    liveEvent: ProjectChangedLiveEvent;
  }> = [];
  const app = new Hono();

  registerProjectRoutes(app, {
    createProject: async (input) => {
      createdInputs.push(input);
      const project = makeProject(input.name);
      const dto = toProjectDto(project);
      const liveEvent = insertLiveEvent(
        getDb(),
        buildProjectChangedLiveEventDraft({
          reason: 'created',
          projectIdChanged: dto.id,
          project: dto,
        }),
      ) as ProjectChangedLiveEvent;
      const legacyEvent = buildProjectChangedRefetchEnvelope(liveEvent.payload);
      return {
        project,
        event: legacyEvent,
        legacyEvent,
        liveEvent,
      };
    },
    refreshProject: (project) => refreshed.push(project as Project),
    removeProject: (projectId) => removed.push(projectId),
    resolveProject: (projectId) => {
      const project = getProjectById(projectId as ULID);
      return project ? { project: { id: project.id } } : null;
    },
    revealProjectFolder: (folderPath) => revealed.push(folderPath),
    publishProjectChanged: (legacyEvent, liveEvent) => published.push({ legacyEvent, liveEvent }),
  });
  registerProjectDetailRoute(app, {
    resolveProject: (projectId) => {
      const project = getProjectById(projectId as ULID);
      return project ? { project: { id: project.id } } : null;
    },
  });

  return { app, createdInputs, refreshed, removed, revealed, published };
}

class FakeSocket {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = this.OPEN;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = this.CLOSED;
  }
}

async function json<T>(res: Response): Promise<T> {
  return await res.json() as T;
}

test('project create route validates input, delegates, and publishes project.changed', async () => {
  const { app, createdInputs, published } = makeHarness();

  let res = await app.request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: '', folder_path: tmpDir, mode: 'init-empty' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), {
    ok: false,
    error: 'name, folder_path, and mode required',
  });
  assert.equal(published.length, 0);

  res = await app.request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: '  Delegated Project  ',
      folder_path: `  ${join(tmpDir, 'delegated')}  `,
      mode: 'attach-to-git',
      git_remote: 'https://example.invalid/repo.git',
    }),
    headers: { 'content-type': 'application/json' },
  });
  const body = await json<{ ok: boolean; project: Project }>(res);

  assert.equal(res.status, 201);
  assert.equal(body.ok, true);
  assert.equal(typeof body.project.id, 'string');
  assert.deepEqual(createdInputs, [
    {
      name: 'Delegated Project',
      folderPath: join(tmpDir, 'delegated'),
      mode: 'attach-to-git',
      gitRemote: 'https://example.invalid/repo.git',
    },
  ]);
  assert.equal(published.length, 1);
  assert.equal(published[0]!.legacyEvent.type, 'project.changed');
  assert.equal(published[0]!.legacyEvent.scope, 'global');
  assert.equal(published[0]!.legacyEvent.projectId, null);
  assert.equal(published[0]!.legacyEvent.reason, 'created');
  assert.equal(published[0]!.legacyEvent.projectIdChanged, body.project.id);
  assert.deepEqual(buildLiveEventFrame(published[0]!.liveEvent), {
    type: 'live-event',
    event: published[0]!.liveEvent,
  });
});

test('project list, patch, detail, soft-delete, and reorder preserve route parity', async () => {
  const { app, refreshed, removed, published } = makeHarness();
  const project = makeProject('crud');
  const other = makeProject('other');

  let res = await app.request('/api/projects');
  let body = await json<{ projects: Project[] }>(res);
  assert.equal(res.status, 200);
  assert.equal(body.projects.some((p) => p.id === project.id), true);
  assert.equal(published.length, 0);

  res = await app.request(`/api/projects/${project.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: '  Renamed  ', git_remote: '   ' }),
    headers: { 'content-type': 'application/json' },
  });
  const patchBody = await json<{ ok: boolean; project: Project }>(res);
  assert.equal(res.status, 200);
  assert.equal(patchBody.ok, true);
  assert.equal(patchBody.project.name, 'Renamed');
  assert.equal(patchBody.project.gitRemote, null);
  assert.deepEqual(refreshed.map((p) => p.id), [project.id]);

  res = await app.request(`/api/projects/${project.id}`);
  assert.equal(res.status, 200);
  assert.equal((await json<Project>(res)).name, 'Renamed');

  const remainingIds = body.projects
    .map((p) => p.id)
    .filter((id) => id !== project.id && id !== other.id);
  res = await app.request('/api/projects/reorder', {
    method: 'PATCH',
    body: JSON.stringify({ orderedIds: [other.id, project.id, ...remainingIds] }),
    headers: { 'content-type': 'application/json' },
  });
  const reorderBody = await json<{ ok: boolean; projects: Project[] }>(res);
  assert.equal(res.status, 200);
  assert.equal(reorderBody.ok, true);
  assert.deepEqual(reorderBody.projects.slice(0, 2).map((p) => p.id), [other.id, project.id]);

  res = await app.request(`/api/projects/${project.id}`, { method: 'DELETE' });
  const deleteBody = await json<{ ok: boolean; project: Project }>(res);
  assert.equal(res.status, 200);
  assert.equal(deleteBody.ok, true);
  assert.equal(removed.includes(project.id), true);

  res = await app.request('/api/projects');
  body = await json(res);
  assert.equal(body.projects.some((p) => p.id === project.id), false);

  res = await app.request('/api/projects?include_deleted=1');
  body = await json(res);
  assert.equal(body.projects.some((p) => p.id === project.id), true);

  assert.deepEqual(published.map((event) => event.legacyEvent.reason), [
    'metadata-updated',
    'reordered',
    'soft-deleted',
  ]);
  const outbox = listLiveEventsAfter({ after: '0', type: 'project.changed' });
  for (const event of published) {
    assert.equal(outbox.events.some((candidate) => candidate.id === event.liveEvent.id), true);
  }
});

test('project routes preserve validation and unknown-project failure shapes', async () => {
  const { app, published } = makeHarness();

  let res = await app.request('/api/projects/reorder', {
    method: 'PATCH',
    body: JSON.stringify({ orderedIds: ['ok', 123] }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), {
    ok: false,
    error: 'orderedIds must be an array of strings',
  });

  res = await app.request('/api/projects/missing', {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Missing' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await json(res), { ok: false, error: 'unknown project: missing' });

  res = await app.request('/api/projects/missing');
  assert.equal(res.status, 404);
  assert.deepEqual(await json(res), { ok: false, error: 'unknown project: missing' });
  assert.equal(published.length, 0);
});

test('project filesystem cleanup and reveal do not publish project.changed', async () => {
  const { app, removed, revealed, published } = makeHarness();
  const project = makeProject('files');
  mkdirSync(join(project.folderPath, '.project-companion'), { recursive: true });
  mkdirSync(join(project.folderPath, '.claude'), { recursive: true });

  await app.request(`/api/projects/${project.id}`, { method: 'DELETE' });
  assert.equal(published.length, 1);
  const res = await app.request(`/api/projects/${project.id}/files`, { method: 'DELETE' });
  const body = await json<{
    ok: boolean;
    removed: string[];
    skipped: Array<{ dir: string; reason: string }>;
  }>(res);

  assert.equal(res.status, 200);
  assert.deepEqual(body, {
    ok: true,
    removed: ['.project-companion'],
    skipped: [
      {
        dir: '.claude',
        reason: 'no .pc-managed marker — PC did not create this directory',
      },
    ],
  });
  assert.equal(existsSync(join(project.folderPath, '.project-companion')), false);
  assert.equal(existsSync(join(project.folderPath, '.claude')), true);
  assert.equal(removed.filter((id) => id === project.id).length, 2);

  const revealProject = makeProject('reveal');
  let revealRes = await app.request(`/api/projects/${revealProject.id}/reveal`, { method: 'POST' });
  assert.equal(revealRes.status, 200);
  assert.deepEqual(await json(revealRes), { ok: true });
  assert.deepEqual(revealed, [revealProject.folderPath]);

  rmSync(revealProject.folderPath, { recursive: true, force: true });
  revealRes = await app.request(`/api/projects/${revealProject.id}/reveal`, { method: 'POST' });
  const revealBody = await json<{ ok: boolean; error: string }>(revealRes);
  assert.equal(revealRes.status, 404);
  assert.equal(revealBody.ok, false);
  assert.equal(revealBody.error, `folder does not exist on disk: ${revealProject.folderPath}`);
  assert.equal(published.length, 1);
});

test('project changed dual fanout reaches two clients and replay recovers missed events', async () => {
  const project = makeProject('fanout');
  const hub = new ProjectWebSocketHub<string>();
  const clientA = new FakeSocket();
  const clientB = new FakeSocket();
  hub.subscribe('client-a', clientA);
  hub.subscribe('client-b', clientB);
  const app = new Hono();
  const published: ProjectChangedLiveEvent[] = [];

  registerProjectRoutes(app, {
    createProject: async (input) => {
      const created = makeProject(input.name);
      const dto = toProjectDto(created);
      const liveEvent = insertLiveEvent(
        getDb(),
        buildProjectChangedLiveEventDraft({
          reason: 'created',
          projectIdChanged: dto.id,
          project: dto,
        }),
      ) as ProjectChangedLiveEvent;
      const legacyEvent = buildProjectChangedRefetchEnvelope(liveEvent.payload);
      return {
        project: created,
        event: legacyEvent,
        legacyEvent,
        liveEvent,
      };
    },
    refreshProject: () => {},
    removeProject: () => {},
    resolveProject: (projectId) => {
      const resolved = getProjectById(projectId as ULID);
      return resolved ? { project: { id: resolved.id } } : null;
    },
    publishProjectChanged: (legacyEvent, liveEvent) => {
      published.push(liveEvent);
      hub.broadcastAll(buildLiveEventFrame(liveEvent));
      hub.broadcastAll(legacyEvent);
    },
  });

  const beforeRename = listLiveEventsAfter({}).nextCursor ?? '0';
  const rename = await app.request(`/api/projects/${project.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Fanout Renamed' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(rename.status, 200);
  assert.equal(published.length, 1);
  assert.equal(clientA.sent.length, 2);
  assert.equal(clientB.sent.length, 2);
  assert.equal(JSON.parse(clientA.sent[0]!).type, 'live-event');
  assert.equal(JSON.parse(clientA.sent[1]!).type, 'project.changed');
  assert.equal(JSON.parse(clientB.sent[0]!).event.id, published[0]!.id);

  clientB.close();
  const beforeDelete = published[0]!.cursor;
  const deleted = await app.request(`/api/projects/${project.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal(published.length, 2);
  assert.equal(clientB.sent.length, 2);

  assert.equal(
    listLiveEventsAfter({ after: beforeRename, type: 'project.changed' }).events.some(
      (event) => event.id === published[0]!.id,
    ),
    true,
  );
  assert.equal(
    listLiveEventsAfter({ after: beforeDelete, type: 'project.changed' }).events.some(
      (event) => event.id === published[1]!.id,
    ),
    true,
  );
});
