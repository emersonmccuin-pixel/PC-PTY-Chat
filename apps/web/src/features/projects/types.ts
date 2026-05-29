export type ULID = string;

export interface Stage {
  id: string;
  name: string;
  order: number;
  isDone?: boolean;
  isCancelled?: boolean;
  isNew?: boolean;
  /** UI Spine step 3 — stamped from project.stagesRev on every stages write.
   *  Frontend store-slice uses this to discard stale WS deliveries. */
  rev?: number;
}

export interface ProjectSettings {
  cancelledVisibility: 'use-global' | 'force-visible' | 'force-hidden';
}

export interface Project {
  id: ULID;
  slug: string;
  name: string;
  stages: Stage[];
  folderPath: string;
  gitRemote: string | null;
  settings: ProjectSettings;
}

export type CreateProjectMode = 'init-empty' | 'init-in-place' | 'attach-to-git';
