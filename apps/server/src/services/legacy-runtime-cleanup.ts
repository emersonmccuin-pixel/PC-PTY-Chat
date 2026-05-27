// Legacy project-root Claude runtime cleanup.
//
// PC used to scaffold Claude Code runtime files directly into project roots:
// `.mcp.json`, `.claude/settings.json`, `.claude/hooks/*.cjs`, and sometimes
// PC agent files. Claude Code auto-discovers those files when a user launches
// a normal terminal session in the same folder, so they must be removed from
// the project root now that PC renders runtime state into per-session data.
//
// This pass only removes PC-recognised files/entries and copies originals into
// PC's data dir first. User-owned Claude config stays in place.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface LegacyRuntimeProject {
  id: string;
  slug: string;
  folderPath: string;
}

export interface LegacyRuntimeCleanupOptions {
  dataDir: string;
  now?: () => Date;
}

export interface LegacyRuntimeCleanupResult {
  projectsScanned: number;
  removed: LegacyRuntimeCleanupChange[];
  rewritten: LegacyRuntimeCleanupChange[];
  skipped: Array<{ projectId: string; folderPath: string; path: string; reason: string }>;
}

export interface LegacyRuntimeCleanupChange {
  projectId: string;
  folderPath: string;
  path: string;
  reason: string;
  backupPath: string;
}

const PC_HOOK_FILES = [
  'ask-intercept.cjs',
  'event-capture.cjs',
  'inbox-drain.cjs',
  'path-guard.cjs',
  'pc-statusline.cjs',
  'stop.cjs',
] as const;

const PC_MCP_SUFFIXES = [
  '/packages/mcp/dist/server.mjs',
  '/packages/mcp/src/server.ts',
  '/channel-server/server.js',
] as const;

const PC_PERMISSION_ALLOW = ['Read', 'Glob', 'Grep', 'Bash(echo:*)', 'Bash(node:*)'];
const PC_PERMISSION_DENY = ['Bash(rm:*)', 'Bash(del:*)', 'Bash(format:*)'];

export function cleanupLegacyProjectRuntimeFiles(
  projects: readonly LegacyRuntimeProject[],
  opts: LegacyRuntimeCleanupOptions,
): LegacyRuntimeCleanupResult {
  const stamp = isoStamp(opts.now?.() ?? new Date());
  const result: LegacyRuntimeCleanupResult = {
    projectsScanned: 0,
    removed: [],
    rewritten: [],
    skipped: [],
  };

  for (const project of projects) {
    result.projectsScanned++;
    const ctx = {
      project,
      dataDir: opts.dataDir,
      backupRoot: resolve(opts.dataDir, 'projects', project.id, 'legacy-claude-runtime', stamp),
      result,
    };
    cleanupLegacyMcp(ctx);
    cleanupLegacySettings(ctx);
    cleanupLegacyHooks(ctx);
    cleanupLegacyAgents(ctx);
    removeEmptyDir(resolve(project.folderPath, '.claude', 'hooks'));
    removeEmptyDir(resolve(project.folderPath, '.claude', 'agents'));
    removeEmptyDir(resolve(project.folderPath, '.claude'));
  }

  return result;
}

interface CleanupCtx {
  project: LegacyRuntimeProject;
  dataDir: string;
  backupRoot: string;
  result: LegacyRuntimeCleanupResult;
}

function cleanupLegacyMcp(ctx: CleanupCtx): void {
  const path = resolve(ctx.project.folderPath, '.mcp.json');
  if (!existsSync(path)) return;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    ctx.result.skipped.push({
      projectId: ctx.project.id,
      folderPath: ctx.project.folderPath,
      path: '.mcp.json',
      reason: 'malformed JSON',
    });
    return;
  }

  const servers = isRecord(parsed.mcpServers) ? { ...parsed.mcpServers } : null;
  if (!servers) return;

  let removedPcServer = false;
  for (const name of ['pc-rig', 'webhook']) {
    const entry = servers[name];
    if (isPcMcpServerEntry(name, entry)) {
      delete servers[name];
      removedPcServer = true;
    }
  }
  if (!removedPcServer) return;

  const backupPath = backupFile(ctx, path, '.mcp.json');
  const next: Record<string, unknown> = { ...parsed };
  if (Object.keys(servers).length > 0) {
    next.mcpServers = servers;
    writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf8');
    ctx.result.rewritten.push({
      projectId: ctx.project.id,
      folderPath: ctx.project.folderPath,
      path: '.mcp.json',
      reason: 'removed legacy PC MCP servers',
      backupPath,
    });
    return;
  }

  delete next.mcpServers;
  if (Object.keys(next).length > 0) {
    writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf8');
    ctx.result.rewritten.push({
      projectId: ctx.project.id,
      folderPath: ctx.project.folderPath,
      path: '.mcp.json',
      reason: 'removed legacy PC MCP servers',
      backupPath,
    });
  } else {
    unlinkSync(path);
    ctx.result.removed.push({
      projectId: ctx.project.id,
      folderPath: ctx.project.folderPath,
      path: '.mcp.json',
      reason: 'legacy PC-only MCP config',
      backupPath,
    });
  }
}

function cleanupLegacySettings(ctx: CleanupCtx): void {
  const path = resolve(ctx.project.folderPath, '.claude', 'settings.json');
  if (!existsSync(path)) return;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    ctx.result.skipped.push({
      projectId: ctx.project.id,
      folderPath: ctx.project.folderPath,
      path: '.claude/settings.json',
      reason: 'malformed JSON',
    });
    return;
  }

  const { value: next, changed } = stripPcSettings(parsed);
  if (!changed) return;

  const backupPath = backupFile(ctx, path, '.claude/settings.json');
  if (Object.keys(next).length === 0) {
    unlinkSync(path);
    ctx.result.removed.push({
      projectId: ctx.project.id,
      folderPath: ctx.project.folderPath,
      path: '.claude/settings.json',
      reason: 'legacy PC-only Claude settings',
      backupPath,
    });
  } else {
    writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf8');
    ctx.result.rewritten.push({
      projectId: ctx.project.id,
      folderPath: ctx.project.folderPath,
      path: '.claude/settings.json',
      reason: 'removed legacy PC hooks/statusline/permissions',
      backupPath,
    });
  }
}

function cleanupLegacyHooks(ctx: CleanupCtx): void {
  for (const file of PC_HOOK_FILES) {
    const path = resolve(ctx.project.folderPath, '.claude', 'hooks', file);
    if (!existsSync(path)) continue;
    const body = readFileSync(path, 'utf8');
    if (!isPcHookFile(body)) continue;
    const relPath = `.claude/hooks/${file}`;
    const backupPath = backupFile(ctx, path, relPath);
    unlinkSync(path);
    ctx.result.removed.push({
      projectId: ctx.project.id,
      folderPath: ctx.project.folderPath,
      path: relPath,
      reason: 'legacy PC hook',
      backupPath,
    });
  }
}

function cleanupLegacyAgents(ctx: CleanupCtx): void {
  const dir = resolve(ctx.project.folderPath, '.claude', 'agents');
  if (!existsSync(dir)) return;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const path = resolve(dir, entry.name);
    const body = readFileSync(path, 'utf8');
    if (!isPcAgentFile(body)) continue;
    const relPath = `.claude/agents/${entry.name}`;
    const backupPath = backupFile(ctx, path, relPath);
    unlinkSync(path);
    ctx.result.removed.push({
      projectId: ctx.project.id,
      folderPath: ctx.project.folderPath,
      path: relPath,
      reason: 'legacy PC agent file',
      backupPath,
    });
  }
}

function stripPcSettings(settings: Record<string, unknown>): {
  value: Record<string, unknown>;
  changed: boolean;
} {
  let changed = false;
  const next: Record<string, unknown> = { ...settings };

  if (isPcPermissions(next.permissions)) {
    delete next.permissions;
    changed = true;
  }

  if (isRecord(next.statusLine) && commandReferencesPcHook(next.statusLine.command)) {
    delete next.statusLine;
    changed = true;
  }

  if (isRecord(next.hooks)) {
    const beforeHooks = JSON.stringify(next.hooks);
    const cleanHooks: Record<string, unknown> = {};
    for (const [eventName, entries] of Object.entries(next.hooks)) {
      if (!Array.isArray(entries)) {
        cleanHooks[eventName] = entries;
        continue;
      }
      const cleanEntries = entries
        .map(stripPcHookEntry)
        .filter((entry): entry is Record<string, unknown> => entry !== null);
      if (cleanEntries.length > 0) cleanHooks[eventName] = cleanEntries;
    }
    if (Object.keys(cleanHooks).length > 0) {
      next.hooks = cleanHooks;
    } else {
      delete next.hooks;
    }
    if (JSON.stringify(next.hooks ?? {}) !== beforeHooks) changed = true;
  }

  return { value: next, changed };
}

function stripPcHookEntry(entry: unknown): Record<string, unknown> | null {
  if (!isRecord(entry)) return entry as Record<string, unknown>;
  if (!Array.isArray(entry.hooks)) return entry;

  const hooks = entry.hooks.filter((hook) => {
    if (!isRecord(hook)) return true;
    return !commandReferencesPcHook(hook.command);
  });
  if (hooks.length === entry.hooks.length) return entry;

  const next: Record<string, unknown> = { ...entry, hooks };
  if (hooks.length > 0) return next;
  const rest = { ...next };
  delete rest.hooks;
  return Object.keys(rest).length === 0 || Object.keys(rest).every((k) => k === 'matcher')
    ? null
    : rest;
}

function isPcMcpServerEntry(name: string, entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  if (name !== 'pc-rig' && name !== 'webhook') return false;
  const args = Array.isArray(entry.args) ? entry.args : [];
  const pointsAtPcScript = args.some((arg) => {
    if (typeof arg !== 'string') return false;
    const normalized = arg.replace(/\\/g, '/');
    return PC_MCP_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
  });
  if (!pointsAtPcScript) return false;
  const env = isRecord(entry.env) ? entry.env : {};
  return (
    Object.prototype.hasOwnProperty.call(env, 'PC_PROJECT_ID') ||
    Object.prototype.hasOwnProperty.call(env, 'PC_PROJECT_SLUG') ||
    Object.prototype.hasOwnProperty.call(env, 'PC_SERVER_PORT') ||
    Object.prototype.hasOwnProperty.call(env, 'CHANNEL_PORT')
  );
}

function isPcPermissions(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'allow,deny') return false;
  return sameStringSet(value.allow, PC_PERMISSION_ALLOW) && sameStringSet(value.deny, PC_PERMISSION_DENY);
}

function commandReferencesPcHook(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  const normalized = command.replace(/\\/g, '/');
  return PC_HOOK_FILES.some((file) => normalized.includes(`/.claude/hooks/${file}`));
}

function isPcHookFile(body: string): boolean {
  return (
    body.includes('PC_SESSION_ID') ||
    body.includes('PROJECT_DATA_DIR') ||
    body.includes('PC_DB_PATH') ||
    body.includes('PC_TRUNK_PATH') ||
    body.includes('Project Companion')
  );
}

function isPcAgentFile(body: string): boolean {
  return body.includes('mcp__pc-rig__') || body.includes('pc_invoke_agent');
}

function backupFile(ctx: CleanupCtx, sourcePath: string, relPath: string): string {
  const backupPath = resolve(ctx.backupRoot, ...relPath.split('/'));
  mkdirSync(dirname(backupPath), { recursive: true });
  copyFileSync(sourcePath, backupPath);
  return backupPath;
}

function removeEmptyDir(path: string): void {
  if (!existsSync(path)) return;
  try {
    if (readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function sameStringSet(value: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return false;
  const actual = [...value].sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((v, i) => v === wanted[i]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isoStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}
