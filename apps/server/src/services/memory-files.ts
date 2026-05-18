// CLAUDE.md memory file read/write for the /memory drawer. Three scopes:
//   - user:      ~/.claude/CLAUDE.md
//   - project:   <project.folderPath>/CLAUDE.md
//   - workspace: <dirname(project.folderPath)>/CLAUDE.md
//
// `exists` is reported truthfully — the UI shows an empty editor for missing
// files, and the first save creates the file. mkdirSync runs on save in case
// the user scope's `~/.claude/` dir doesn't exist yet.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export type MemoryScope = 'user' | 'project' | 'workspace';

export interface MemoryFile {
  scope: MemoryScope;
  path: string;
  content: string;
  exists: boolean;
}

export function memoryPath(scope: MemoryScope, projectFolder: string): string {
  switch (scope) {
    case 'user':
      return resolve(homedir(), '.claude', 'CLAUDE.md');
    case 'project':
      return resolve(projectFolder, 'CLAUDE.md');
    case 'workspace':
      return resolve(dirname(projectFolder), 'CLAUDE.md');
  }
}

export function readMemoryFile(scope: MemoryScope, projectFolder: string): MemoryFile {
  const path = memoryPath(scope, projectFolder);
  const exists = existsSync(path);
  const content = exists ? readFileSync(path, 'utf-8') : '';
  return { scope, path, content, exists };
}

export function writeMemoryFile(
  scope: MemoryScope,
  projectFolder: string,
  content: string,
): MemoryFile {
  const path = memoryPath(scope, projectFolder);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
  return { scope, path, content, exists: true };
}
