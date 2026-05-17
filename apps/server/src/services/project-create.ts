// Project create flow. The `POST /api/projects` endpoint thin-wraps this.
//
// Order of operations (per docs/design/multi-tenancy.md §6):
//
//   1. Validate name + folder.
//   2. Resolve a unique slug from the name.
//   3. Mint a ULID up-front so the scaffold pass (which embeds the id into
//      hooks + .mcp.json) and the DB row share an identity.
//   4. `git init -b main` in the project folder.
//   5. If `init-in-place` AND the folder had pre-existing files: commit them
//      first as `Initial import` so the user can `git diff` the next commit
//      to see exactly what PC added.
//   6. Scaffold (templates rendered + agents copied from the user's library).
//   7. Commit the scaffold as `Initial commit` (fresh folder) or
//      `Add Project Companion scaffold` (in-place w/ pre-existing files).
//   8. Insert the DB row with the pre-minted id.
//   9. Register the runtime in the ProjectRegistry.
//
// Failure modes left uncovered for the first cut: partial scaffolds when git
// commit fails midway. The folder is left as-is; user can `rm -rf .git` and
// retry. Atomic-rollback is a followup once the create flow has tests.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type { Project, Stage } from '@pc/domain';
import { createProject, getProjectBySlug, newId } from '@pc/db';

import type { AgentLibrary } from './agent-library.ts';
import type { ProjectRegistry } from './project-registry.ts';
import type { ProjectScaffold, ProjectScaffoldTarget } from './project-scaffold.ts';

const exec = promisify(execFile);

export type CreateProjectMode = 'init-empty' | 'init-in-place';

export interface CreateProjectFlowInput {
  name: string;
  folderPath: string;
  mode: CreateProjectMode;
  gitRemote?: string | null;
}

const DEFAULT_STAGES: Stage[] = [
  { id: 'draft', name: 'Draft', order: 0 },
  { id: 'review', name: 'Review', order: 1 },
  { id: 'done', name: 'Done', order: 2 },
];

export class ProjectCreate {
  constructor(
    private readonly scaffold: ProjectScaffold,
    private readonly agentLibrary: AgentLibrary,
    private readonly registry: ProjectRegistry,
  ) {}

  async create(input: CreateProjectFlowInput): Promise<Project> {
    const name = (input.name ?? '').trim();
    if (!name) throw new Error('name required');
    if (input.mode !== 'init-empty' && input.mode !== 'init-in-place') {
      throw new Error(`invalid mode: ${input.mode}`);
    }
    const folderPath = resolve(input.folderPath);

    mkdirSync(folderPath, { recursive: true });
    if (existsSync(resolve(folderPath, '.git'))) {
      throw new Error(`folder is already a git repo: ${folderPath}`);
    }

    const filesBefore = readdirSync(folderPath).filter((f) => f !== '.git');
    if (input.mode === 'init-empty' && filesBefore.length > 0) {
      throw new Error(
        `folder is not empty: ${folderPath} — use mode 'init-in-place' to commit existing files first`,
      );
    }

    const slug = this.uniqueSlug(name);
    const id = newId();

    await exec('git', ['init', '-b', 'main'], { cwd: folderPath });

    const hadExistingFiles = filesBefore.length > 0;
    if (input.mode === 'init-in-place' && hadExistingFiles) {
      await exec('git', ['add', '.'], { cwd: folderPath });
      await exec('git', ['commit', '-m', 'Initial import'], { cwd: folderPath });
    }

    const target: ProjectScaffoldTarget = {
      folderPath,
      projectId: id,
      projectSlug: slug,
      projectName: name,
    };
    this.scaffold.writeAll(target);
    this.copyAgentsFromLibrary(folderPath);

    await exec('git', ['add', '.'], { cwd: folderPath });
    const scaffoldMsg = hadExistingFiles ? 'Add Project Companion scaffold' : 'Initial commit';
    await exec('git', ['commit', '-m', scaffoldMsg], { cwd: folderPath });

    const project = createProject({
      id,
      slug,
      name,
      stages: DEFAULT_STAGES,
      folderPath,
      gitRemote: input.gitRemote ?? null,
    });
    this.registry.register(project);
    return project;
  }

  /** `name` → kebab-case slug. Uniqued against the DB by appending `-2`, `-3`, … */
  private uniqueSlug(name: string): string {
    const base = slugify(name) || 'project';
    let candidate = base;
    let n = 1;
    while (getProjectBySlug(candidate)) {
      n += 1;
      candidate = `${base}-${n}`;
    }
    return candidate;
  }

  /** Drop every library agent into `<folder>/.claude/agents/`. Default = all,
   *  per docs/design/multi-tenancy.md §5. Per-project edits diverge from the library. */
  private copyAgentsFromLibrary(folderPath: string): void {
    const destDir = resolve(folderPath, '.claude', 'agents');
    mkdirSync(destDir, { recursive: true });
    for (const agent of this.agentLibrary.list()) {
      writeFileSync(resolve(destDir, `${agent.name}.md`), agent.body, 'utf-8');
    }
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
