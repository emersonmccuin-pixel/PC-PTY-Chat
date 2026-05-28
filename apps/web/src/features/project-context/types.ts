export type MemoryScope = 'user' | 'project' | 'workspace';

export interface MemoryFile {
  scope: MemoryScope;
  path: string;
  content: string;
  exists: boolean;
}

export interface CustomCommand {
  name: string;
  body: string;
  scope: 'project' | 'user';
}
