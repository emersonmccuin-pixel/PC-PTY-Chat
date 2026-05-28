import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import type { Project, Stage, ULID, WorkItem } from '@pc/domain';
import type { WorkItemRoutesRuntime } from '../src/features/work-items/routes.ts';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-work-item-routes-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createProject: dbCreateProject,
  getWorkItem,
  listFieldSchemas,
  runMigrations,
} = await import('@pc/db');
const { WorkItemService } = await import('../src/services/work-item.ts');
const { AttachmentService } = await import('../src/services/attachment.ts');
const { FieldSchemaService } = await import('../src/services/field-schema.ts');
const { registerWorkItemRoutes } = await import('../src/features/work-items/routes.ts');

const baseStages: Stage[] = [
  { id: 'todo', name: 'Todo', order: 0, isNew: true },
  { id: 'doing', name: 'Doing', order: 1 },
  { id: 'done', name: 'Done', order: 2, isDone: true },
  { id: 'cancelled', name: 'Cancelled', order: 3, isCancelled: true },
];
let seq = 0;

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function cloneStages(stages: Stage[]): Stage[] {
  return stages.map((stage) => ({ ...stage }));
}

function makeProject(label: string, stages = baseStages): Project {
  seq += 1;
  const folderPath = join(tmpDir, `project-${label}-${seq}`);
  mkdirSync(folderPath, { recursive: true });
  return dbCreateProject({
    slug: `work-item-routes-${label}-${Date.now().toString(36)}-${seq}`,
    name: `Work Item Routes ${label}`,
    stages: cloneStages(stages),
    folderPath,
  });
}

function makeHarness(project: Project) {
  let currentProject = project;
  const events: Array<{ projectId: ULID; msg: unknown }> = [];
  const workItemService = new WorkItemService({
    projectId: project.id,
    getProject: () => currentProject,
    getFieldSchemas: () => listFieldSchemas(project.id),
    broadcast: (msg) => events.push({ projectId: project.id, msg }),
  });
  const attachmentService = new AttachmentService({
    projectId: project.id,
    getWorkItem,
    broadcast: (msg) => events.push({ projectId: project.id, msg }),
  });
  const fieldSchemaService = new FieldSchemaService({
    projectId: project.id,
    broadcast: (msg) => events.push({ projectId: project.id, msg }),
  });
  const runtime: WorkItemRoutesRuntime = {
    get project() {
      return currentProject;
    },
    workItemService: () => workItemService,
    attachmentService: () => attachmentService,
    fieldSchemaService: () => fieldSchemaService,
    moveAndFireV2: async (args) => {
      const current = getWorkItem(args.id as ULID);
      if (!current) throw new Error(`unknown work item: ${args.id}`);
      const input: { expectedVersion: number; stageId: string; position?: number } = {
        expectedVersion: args.expectedVersion ?? current.version,
        stageId: args.toStage,
      };
      if (args.position !== undefined) input.position = args.position;
      return workItemService.move(args.id as ULID, input, args.notes ?? undefined);
    },
  };
  const app = new Hono();
  registerWorkItemRoutes(app, {
    resolveProject: (projectId) => (projectId === project.id ? runtime : null),
    broadcastTo: (projectId, msg) => events.push({ projectId, msg }),
    refreshProject: (next) => {
      currentProject = next;
    },
    channelServer: {} as never,
  });
  return {
    app,
    events,
    getCurrentProject: () => currentProject,
  };
}

async function json<T>(res: Response): Promise<T> {
  return await res.json() as T;
}

async function createWorkItemViaRoute(app: Hono, projectId: ULID, input: {
  title?: string;
  stageId?: string;
  body?: string;
}): Promise<WorkItem> {
  const res = await app.request(`/api/projects/${projectId}/work-items/create`, {
    method: 'POST',
    body: JSON.stringify(input),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  const body = await json<{ ok: boolean; workItem: WorkItem }>(res);
  assert.equal(body.ok, true);
  return body.workItem;
}

test('work item CRUD routes preserve legacy, filtered, and versioned envelopes', async () => {
  const project = makeProject('crud');
  const { app, events } = makeHarness(project);

  let res = await app.request(`/api/projects/${project.id}/work-items/create`, {
    method: 'POST',
    body: JSON.stringify({ title: '', stageId: 'todo' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), { ok: false, error: 'title and stageId required' });

  const created = await createWorkItemViaRoute(app, project.id, {
    title: '  First card  ',
    stageId: 'todo',
    body: 'Initial body',
  });
  assert.equal(created.title, 'First card');
  assert.equal(
    events.some((event) => {
      const msg = event.msg as { type?: string; change?: string };
      return msg.type === 'work-items-changed' && msg.change === 'created';
    }),
    true,
  );

  res = await app.request(`/api/projects/${project.id}/work-items`);
  assert.equal(res.status, 200);
  const legacyList = await json<{ workItems: WorkItem[] }>(res);
  assert.equal(legacyList.workItems.some((wi) => wi.id === created.id), true);

  res = await app.request(`/api/projects/${project.id}/work-items?stage=todo&limit=1`);
  assert.equal(res.status, 200);
  const filteredList = await json<{ items: WorkItem[]; nextCursor: string | null }>(res);
  assert.deepEqual(filteredList.items.map((wi) => wi.id), [created.id]);
  assert.equal(filteredList.nextCursor, null);

  res = await app.request(`/api/projects/${project.id}/work-items/${created.id}`);
  assert.equal(res.status, 200);
  assert.equal((await json<{ ok: boolean; workItem: WorkItem }>(res)).workItem.id, created.id);

  res = await app.request(`/api/projects/${project.id}/work-items/${created.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: 'Missing version' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), { ok: false, error: 'version required' });

  res = await app.request(`/api/projects/${project.id}/work-items/${created.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ version: created.version, title: 'Renamed card' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  const patched = (await json<{ ok: boolean; workItem: WorkItem }>(res)).workItem;
  assert.equal(patched.title, 'Renamed card');

  res = await app.request(`/api/projects/${project.id}/work-items/update`, {
    method: 'POST',
    body: JSON.stringify({ id: created.id, fields: { legacy: true } }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await json<{ ok: boolean; workItem: WorkItem }>(res)).workItem.fields, {
    legacy: true,
  });

  res = await app.request(`/api/projects/${project.id}/work-items/${created.id}`, {
    method: 'DELETE',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true });

  res = await app.request(`/api/projects/${project.id}/work-items/${created.id}`);
  assert.equal(res.status, 404);

  res = await app.request(`/api/projects/${project.id}/work-items/${created.id}?includeArchived=1`);
  assert.equal(res.status, 200);
  assert.equal((await json<{ ok: boolean; workItem: WorkItem }>(res)).workItem.id, created.id);

  res = await app.request(`/api/projects/${project.id}/work-items/${created.id}/restore`, {
    method: 'POST',
  });
  assert.equal(res.status, 200);
  assert.equal((await json<{ ok: boolean; workItem: WorkItem }>(res)).workItem.deletedAt, null);
});

test('stage replacement routes preserve orphan conflict and forced reassignment behavior', async () => {
  const stages: Stage[] = [
    { id: 'todo', name: 'Todo', order: 0, isNew: true },
    { id: 'blocked', name: 'Blocked', order: 1 },
    { id: 'done', name: 'Done', order: 2, isDone: true },
  ];
  const project = makeProject('stages', stages);
  const { app, events, getCurrentProject } = makeHarness(project);
  const blocked = await createWorkItemViaRoute(app, project.id, {
    title: 'Blocked item',
    stageId: 'blocked',
  });

  let res = await app.request(`/api/projects/${project.id}/stages`, {
    method: 'PATCH',
    body: JSON.stringify({
      stages: [
        { id: 'todo', name: 'Todo', order: 0, isDone: true },
        { id: 'done', name: 'Done', order: 1, isDone: true },
      ],
    }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), {
    ok: false,
    error: 'at most one stage can be marked is_done',
  });

  const retained = [
    { id: 'todo', name: 'Todo', order: 0, isNew: true },
    { id: 'done', name: 'Done', order: 1, isDone: true },
  ];
  res = await app.request(`/api/projects/${project.id}/stages`, {
    method: 'PATCH',
    body: JSON.stringify({ stages: retained }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 409);
  assert.deepEqual(await json(res), {
    ok: false,
    error: 'STAGE_HAS_ITEMS',
    orphans: [{ id: 'blocked', name: 'Blocked', count: 1 }],
  });

  res = await app.request(`/api/projects/${project.id}/stages`, {
    method: 'PATCH',
    body: JSON.stringify({ stages: retained, force: true, fallbackStageId: 'todo' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  const body = await json<{ ok: boolean; project: Project }>(res);
  assert.equal(body.ok, true);
  assert.deepEqual(body.project.stages.map((stage) => stage.id), ['todo', 'done']);
  assert.deepEqual(getCurrentProject().stages.map((stage) => stage.id), ['todo', 'done']);
  assert.equal(getWorkItem(blocked.id)?.stageId, 'todo');
  assert.equal(
    events.some((event) => {
      const msg = event.msg as { type?: string };
      return msg.type === 'stages-changed';
    }),
    true,
  );
});

test('attachment and field schema routes preserve project-scoped envelopes', async () => {
  const project = makeProject('attachments-fields');
  const { app, events } = makeHarness(project);
  const workItem = await createWorkItemViaRoute(app, project.id, {
    title: 'Attachment target',
    stageId: 'todo',
  });

  let res = await app.request(`/api/projects/${project.id}/work-items/${workItem.id}/attachments`, {
    method: 'POST',
    body: JSON.stringify({ content: 'hello' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), { ok: false, error: 'name required' });

  res = await app.request(`/api/projects/${project.id}/work-items/${workItem.id}/attachments`, {
    method: 'POST',
    body: JSON.stringify({
      kind: 'markdown',
      name: 'findings.md',
      content: '# Findings',
      contentType: 'text/markdown',
      source: 'agent',
      agentName: 'researcher',
    }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 201);
  const attachment = (await json<{ ok: boolean; attachment: { id: ULID; name: string } }>(res)).attachment;
  assert.equal(attachment.name, 'findings.md');

  res = await app.request(`/api/projects/${project.id}/work-items/${workItem.id}/attachments`);
  assert.equal(res.status, 200);
  assert.deepEqual((await json<{ ok: boolean; items: Array<{ id: ULID }> }>(res)).items.map((a) => a.id), [
    attachment.id,
  ]);

  res = await app.request(`/api/projects/${project.id}/work-items/${workItem.id}/attachments/${attachment.id}`);
  assert.equal(res.status, 200);
  assert.equal((await json<{ ok: boolean; attachment: { id: ULID } }>(res)).attachment.id, attachment.id);

  res = await app.request(`/api/projects/${project.id}/attachments/${attachment.id}`);
  assert.equal(res.status, 200);
  assert.equal((await json<{ ok: boolean; attachment: { id: ULID } }>(res)).attachment.id, attachment.id);

  res = await app.request(`/api/projects/${project.id}/work-items/${workItem.id}/attachments/${attachment.id}`, {
    method: 'DELETE',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true });

  res = await app.request(`/api/projects/${project.id}/field-schemas`);
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, items: [] });

  res = await app.request(`/api/projects/${project.id}/field-schemas`, {
    method: 'PUT',
    body: JSON.stringify({}),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), { ok: false, error: 'items array required' });

  res = await app.request(`/api/projects/${project.id}/field-schemas`, {
    method: 'PUT',
    body: JSON.stringify({
      items: [
        { key: 'sev', label: 'Severity', type: 'enum', options: ['low', 'high'], required: true, order: 0 },
      ],
    }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  const fields = await json<{ ok: boolean; items: Array<{ id: ULID; key: string }> }>(res);
  assert.equal(fields.ok, true);
  assert.equal(fields.items[0].key, 'sev');
  assert.equal(typeof fields.items[0].id, 'string');
  assert.equal(
    events.some((event) => {
      const msg = event.msg as { type?: string };
      return msg.type === 'field-schemas-changed';
    }),
    true,
  );
});
