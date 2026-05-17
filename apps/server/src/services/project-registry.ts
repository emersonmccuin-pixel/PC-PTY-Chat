// ProjectRegistry — owns one ProjectRuntime per project. Resolves requests by
// project id, lazily loads runtimes for known projects, lets the bootstrap
// pre-populate from the DB at server start.

import type { Project, ULID } from '@pc/domain';
import { getProjectById, listProjects } from '@pc/db';

import { ProjectRuntime } from './project-runtime.ts';
import type { BroadcastFn } from './workflow-runtime.ts';

export interface ProjectRegistryDeps {
  dataDir: string;
  channelPort: number;
  /** Factory: produces a broadcast fn pre-bound to the given project id. */
  broadcastFor: (projectId: ULID) => BroadcastFn;
}

export class ProjectRegistry {
  private readonly runtimes = new Map<ULID, ProjectRuntime>();

  constructor(private readonly deps: ProjectRegistryDeps) {}

  /** Load every non-deleted project from the DB into the registry. */
  loadAll(): void {
    for (const p of listProjects()) {
      this.runtimes.set(p.id, this.construct(p));
    }
  }

  /** Resolve (or hydrate) the runtime for `projectId`. Returns null if no such project. */
  ensure(projectId: ULID): ProjectRuntime | null {
    const cached = this.runtimes.get(projectId);
    if (cached) return cached;
    const project = getProjectById(projectId);
    if (!project) return null;
    const runtime = this.construct(project);
    this.runtimes.set(projectId, runtime);
    return runtime;
  }

  get(projectId: ULID): ProjectRuntime | null {
    return this.runtimes.get(projectId) ?? null;
  }

  /** Register a freshly-created project so subsequent calls skip the DB hit. */
  register(project: Project): ProjectRuntime {
    const runtime = this.construct(project);
    this.runtimes.set(project.id, runtime);
    return runtime;
  }

  /** Drop a runtime (e.g. on soft-delete). Kills its PtySession + clears caches. */
  remove(projectId: ULID): void {
    const runtime = this.runtimes.get(projectId);
    if (!runtime) return;
    runtime.shutdown();
    this.runtimes.delete(projectId);
  }

  list(): ProjectRuntime[] {
    return Array.from(this.runtimes.values());
  }

  shutdownAll(): void {
    for (const r of this.runtimes.values()) r.shutdown();
    this.runtimes.clear();
  }

  private construct(project: Project): ProjectRuntime {
    return new ProjectRuntime(project, {
      dataDir: this.deps.dataDir,
      channelPort: this.deps.channelPort,
      broadcast: this.deps.broadcastFor(project.id),
    });
  }
}
