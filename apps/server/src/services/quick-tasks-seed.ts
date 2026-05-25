// Section 34.1 — boot-time seed for the Quick Tasks pinned cross-project surface.
//
// On first boot, ensures a singleton project row with `kind = 'quick-tasks'`
// exists. Scaffolds a server-managed git-tracked folder under
// `<dataDir>/quick-tasks-workspace/` (NOT under the user's projectsFolder —
// this project is system-seeded, not user-created). Idempotent: subsequent
// boots find the existing row + folder and no-op.
//
// The folder gets the normal PC scaffold (`.mcp.json`, `.claude/`,
// `.project-companion/`) so claude.exe can spawn with `--agent quick-tasks-pm`
// (added in 34.2) with the same plumbing every other project uses.
//
// Order at boot: this seed must run BEFORE `projectRegistry.loadAll()` so the
// runtime picks Quick Tasks up like any other project. Idempotent on every
// subsequent boot.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type { Stage } from '@pc/domain';
import { createProject, findQuickTasksProject, newId } from '@pc/db';

import type { ProjectScaffold, ProjectScaffoldTarget } from './project-scaffold.ts';

const exec = promisify(execFile);

const QUICK_TASKS_NAME = 'Quick Tasks';
const QUICK_TASKS_SLUG = 'quick-tasks';
const QUICK_TASKS_FOLDER = 'quick-tasks-workspace';

/** Two stages — Inbox (intake) + Done (terminal). Quick Tasks isn't a kanban
 *  flow; the rail row routes straight to the dedicated Tasks-tab UI (34.8)
 *  which renders a flat list with filter chips, not a board. Stages still
 *  carry the standard flags so `pc_log_bug`-style cross-project writes and
 *  the auto-status-flip-on-Done plumbing keep working. */
const QUICK_TASKS_STAGES: Stage[] = [
  { id: 'inbox', name: 'Inbox', order: 0, isNew: true },
  { id: 'done', name: 'Done', order: 1, isDone: true },
];

export interface EnsureQuickTasksProjectDeps {
  /** PC's data dir. Quick Tasks folder lands at `<dataDir>/quick-tasks-workspace/`. */
  dataDir: string;
  /** Scaffold writer — renders `.mcp.json` / `.claude/` / `.project-companion/`. */
  scaffold: ProjectScaffold;
}

export type EnsureQuickTasksAction = 'existed' | 'created';

export interface EnsureQuickTasksProjectResult {
  action: EnsureQuickTasksAction;
  projectId: string;
  folderPath: string;
}

export async function ensureQuickTasksProject(
  deps: EnsureQuickTasksProjectDeps,
): Promise<EnsureQuickTasksProjectResult> {
  const existing = findQuickTasksProject();
  if (existing) {
    return { action: 'existed', projectId: existing.id, folderPath: existing.folderPath };
  }

  const folderPath = resolve(deps.dataDir, QUICK_TASKS_FOLDER);
  mkdirSync(folderPath, { recursive: true });

  const folderIsRepo = existsSync(resolve(folderPath, '.git'));
  if (!folderIsRepo) {
    await exec('git', ['init', '-b', 'main'], { cwd: folderPath });
  }

  const id = newId();
  const target: ProjectScaffoldTarget = {
    folderPath,
    projectId: id,
    projectSlug: QUICK_TASKS_SLUG,
    projectName: QUICK_TASKS_NAME,
  };
  deps.scaffold.writeAll(target);

  await exec('git', ['add', '.'], { cwd: folderPath });
  await exec('git', ['commit', '-m', 'Quick Tasks scaffold'], { cwd: folderPath });

  const project = createProject({
    id,
    slug: QUICK_TASKS_SLUG,
    name: QUICK_TASKS_NAME,
    stages: QUICK_TASKS_STAGES,
    folderPath,
    kind: 'quick-tasks',
  });
  return { action: 'created', projectId: project.id, folderPath };
}
