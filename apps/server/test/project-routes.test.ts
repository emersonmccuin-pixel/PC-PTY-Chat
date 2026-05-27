import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import type { Project, ULID } from '@pc/domain';
import type { CreateProjectFlowInput } from '../src/services/project-create.ts';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-project-routes-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createProject: dbCreateProject,
  getProjectById,
  runMigrations,
} = await import('@pc/db');
const {
  registerProjectDetailRoute,
  registerProjectRoutes,
} = await import('../src/features/projects/routes.ts');

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
  const app = new Hono();

  registerProjectRoutes(app, {
    createProject: async (input) => {
      createdInputs.push(input);
      return makeProject(input.name);
    },
    refreshProject: (project) => refreshed.push(project),
    removeProject: (projectId) => removed.push(projectId),
    resolveProject: (projectId) => {
      const project = getProjectById(projectId as ULID);
      return project ? { project: { id: project.id } } : null;
    },
    revealProjectFolder: (folderPath) => revealed.push(folderPath),
  });
  registerProjectDetailRoute(app, {
    resolveProject: (projectId) => {
      const project = getProjectById(projectId as ULID);
      return project ? { project: { id: project.id } } : null;
    },
  });

  return { app, createdInputs, refreshed, removed, revealed };
}

async function json<T>(res: Response): Promise<T> {
  return await res.json() as T;
}

test('project create route validates input and delegates with the existing envelope', async () => {
  const { app, createdInputs } = makeHarness();

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
});

test('project list, patch, detail, and soft-delete routes preserve registry side effects', async () => {
  const { app, refreshed, removed } = makeHarness();
  const project = makeProject('crud');

  let res = await app.request('/api/projects');
  let body = await json<{ projects: Project[] }>(res);
  assert.equal(res.status, 200);
  assert.equal(body.projects.some((p) => p.id === project.id), true);

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
});

test('project filesystem cleanup resolves soft-deleted rows and preserves unmarked claude dirs', async () => {
  const { app, removed } = makeHarness();
  const project = makeProject('files');
  mkdirSync(join(project.folderPath, '.project-companion'), { recursive: true });
  mkdirSync(join(project.folderPath, '.claude'), { recursive: true });

  await app.request(`/api/projects/${project.id}`, { method: 'DELETE' });
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
});

test('project reveal route validates the folder and delegates opener behavior', async () => {
  const { app, revealed } = makeHarness();
  const project = makeProject('reveal');

  let res = await app.request(`/api/projects/${project.id}/reveal`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true });
  assert.deepEqual(revealed, [project.folderPath]);

  rmSync(project.folderPath, { recursive: true, force: true });
  res = await app.request(`/api/projects/${project.id}/reveal`, { method: 'POST' });
  const body = await json<{ ok: boolean; error: string }>(res);
  assert.equal(res.status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.error, `folder does not exist on disk: ${project.folderPath}`);
});
