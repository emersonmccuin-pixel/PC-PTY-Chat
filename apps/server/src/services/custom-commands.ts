// Custom command discovery. Scans `<project>/.claude/commands/*.md` AND
// `~/.claude/commands/*.md` (CC parity). Returns the markdown body for each;
// the web tray surfaces them and `$ARGUMENTS` substitution happens client-side
// before the body is sent as a prompt.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface CustomCommand {
  name: string;
  body: string;
  scope: 'project' | 'user';
}

function commandsDir(folderPath: string): string {
  return resolve(folderPath, '.claude', 'commands');
}

function userCommandsDir(): string {
  return resolve(homedir(), '.claude', 'commands');
}

function readDirCommands(dir: string, scope: 'project' | 'user'): CustomCommand[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({
      name: f.replace(/\.md$/, ''),
      body: readFileSync(join(dir, f), 'utf-8'),
      scope,
    }));
}

/** Merge project + user commands. Project shadows user on name collision (same
 *  precedence rule CC uses). Sorted alpha for stable tray order. */
export function listCustomCommands(folderPath: string): CustomCommand[] {
  const project = readDirCommands(commandsDir(folderPath), 'project');
  const user = readDirCommands(userCommandsDir(), 'user');
  const seen = new Set(project.map((c) => c.name));
  const merged = [...project, ...user.filter((c) => !seen.has(c.name))];
  return merged.sort((a, b) => a.name.localeCompare(b.name));
}
