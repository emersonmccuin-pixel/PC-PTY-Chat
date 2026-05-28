export type ULID = string;

export interface Stage {
  id: string;
  name: string;
  order: number;
  isDone?: boolean;
  isCancelled?: boolean;
  isNew?: boolean;
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
