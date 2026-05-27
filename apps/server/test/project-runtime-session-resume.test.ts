import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Project, Stage, ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-pr-session-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createOrchestratorSession,
  createProject,
  endOrchestratorSession,
  getOrchestratorSession,
  runMigrations,
} = await import('@pc/db');
const { ProjectRuntime } = await import('../src/services/project-runtime.ts');

const stages: Stage[] = [
  { id: 'backlog', name: 'Backlog', order: 0 },
  { id: 'done', name: 'Done', order: 1 },
];

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

let seq = 0;

function mkRuntime(): { runtime: InstanceType<typeof ProjectRuntime>; project: Project } {
  seq += 1;
  const folder = resolve(tmpDir, `proj-${String(seq)}`);
  mkdirSync(folder, { recursive: true });
  const project = createProject({
    slug: `resume-${String(seq)}`,
    name: `Resume ${String(seq)}`,
    stages,
    folderPath: folder,
  }) as unknown as Project;
  const runtime = new ProjectRuntime(project, {
    dataDir: tmpDir,
    serverPort: 0,
    channelPort: 0,
    broadcast: () => {},
    templatesDir: resolve(tmpDir, 'templates'),
    trunkPath: tmpDir,
  });
  return { runtime, project };
}

test('resumeSession reactivates legacy rows even when provider JSONL is missing', () => {
  const { runtime, project } = mkRuntime();
  const legacy = createOrchestratorSession({
    projectId: project.id as ULID,
    providerSessionId: '11111111-1111-4111-8111-111111111111',
  });
  endOrchestratorSession(legacy.id as ULID, 'user_ended');
  const active = createOrchestratorSession({
    projectId: project.id as ULID,
    providerSessionId: '22222222-2222-4222-8222-222222222222',
  });

  const resumed = runtime.resumeSession(legacy.id as ULID);

  assert.equal(resumed.id, legacy.id);
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.providerSessionId, legacy.providerSessionId);
  assert.equal(getOrchestratorSession(active.id as ULID)?.status, 'ended');
});
