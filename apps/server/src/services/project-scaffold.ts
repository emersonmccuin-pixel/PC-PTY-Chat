// Project scaffold writer. Renders trunk-side templates into a project folder
// with per-project tokens substituted. P8's create-project flow calls into
// this after `git init` to produce the full PC scaffold:
//
//   <folder>/.mcp.json                          (rendered)
//   <folder>/.claude/settings.json              (rendered)
//   <folder>/.claude/hooks/*.cjs                (rendered)
//   <folder>/.project-companion/workflows/*.yaml (plain copy)
//   <folder>/README.md                          (rendered)
//
// The orchestrator's identity used to land here as
// `.project-companion/orchestrator-prompt.md` (rendered + appended at spawn
// via `--append-system-prompt-file`). Section 16a moved it into the
// `agents` DB table (pod-resident); the scaffold no longer writes a per-
// project file. See `apps/server/src/services/orchestrator-pod-content.ts`.
//
// Agents are DB-resident pod rows (Section 17e, 2026-05-21). The scaffold
// writes no `.claude/agents/` files — pods materialize at spawn time via
// the pod-spawn pipeline.
//
// Template format: `{{TOKEN}}` placeholders, alnum + underscore. Unknown tokens
// pass through so a malformed template is visible on inspection rather than
// silently emptied.

import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface ProjectScaffoldDeps {
  /** Absolute trunk root (`<pc-repo>/`). Substituted into `{{PC_TRUNK_PATH}}`. */
  trunkPath: string;
  /** Absolute path to the `templates/` dir. */
  templatesDir: string;
  /** Trunk data dir. PROJECT_DATA_DIR is `<dataDir>/projects/<projectId>/`. */
  dataDir: string;
  /** apps/server bind port. Substituted into `{{PC_SERVER_PORT}}`. */
  serverPort: number;
  /** Channel server bind port. Substituted into `{{PC_CHANNEL_PORT}}`. */
  channelPort: number;
}

export interface ProjectScaffoldTarget {
  /** Absolute path of the user's project folder. */
  folderPath: string;
  /** ULID. */
  projectId: string;
  /** URL-safe slug. */
  projectSlug: string;
  /** Display name. */
  projectName: string;
}

export class ProjectScaffold {
  constructor(private readonly deps: ProjectScaffoldDeps) {}

  /** Full scaffold pass: configs + hooks + workflow seeds + README. */
  writeAll(target: ProjectScaffoldTarget): void {
    this.writeConfigs(target);
    this.writeHooks(target);
    this.writeWorkflowSeeds(target);
    this.writeReadme(target);
    this.writeOwnershipMarker(target);
  }

  /** Like writeAll but skips README.md — used by attach-to-git so the user's
   *  existing project README isn't clobbered. */
  writeWithoutReadme(target: ProjectScaffoldTarget): void {
    this.writeConfigs(target);
    this.writeHooks(target);
    this.writeWorkflowSeeds(target);
    this.writeOwnershipMarker(target);
  }

  /** Section 22.7 — write a marker file inside `.claude/` so the
   *  delete-files endpoint knows the directory is PC-owned. Without this,
   *  a project adopted via attach-to-git could have its pre-existing
   *  `.claude/` configuration wiped on delete. */
  writeOwnershipMarker(target: ProjectScaffoldTarget): void {
    const dir = resolve(target.folderPath, '.claude');
    mkdirSync(dir, { recursive: true });
    const marker = resolve(dir, '.pc-managed');
    const body = [
      'This file marks the parent .claude/ directory as owned by Project',
      'Companion. The DELETE /api/projects/:id/files endpoint will remove',
      "the directory only when this marker is present. Don't add this file",
      "to a .claude/ directory PC didn't create.",
      '',
      `project: ${target.projectName}`,
      `slug: ${target.projectSlug}`,
      `projectId: ${target.projectId}`,
      '',
    ].join('\n');
    writeFileSync(marker, body, 'utf8');
  }

  /**
   * Write the two generated configs into the project folder:
   *  - `<folder>/.mcp.json` from `templates/.mcp.template.json`
   *  - `<folder>/.claude/settings.json` from `templates/.claude/settings.template.json`
   *
   * Overwrites existing files — P8 commits pre-existing user files first, so
   * the scaffold pass is allowed to clobber.
   */
  writeConfigs(target: ProjectScaffoldTarget): void {
    const tokens = this.buildTokens(target);
    this.writeFromTemplate(
      resolve(this.deps.templatesDir, '.mcp.template.json'),
      resolve(target.folderPath, '.mcp.json'),
      tokens,
    );
    this.writeFromTemplate(
      resolve(this.deps.templatesDir, '.claude', 'settings.template.json'),
      resolve(target.folderPath, '.claude', 'settings.json'),
      tokens,
    );
  }

  /** Copy + render every `.cjs` in `templates/.claude/hooks/`. */
  writeHooks(target: ProjectScaffoldTarget): void {
    const srcDir = resolve(this.deps.templatesDir, '.claude', 'hooks');
    const destDir = resolve(target.folderPath, '.claude', 'hooks');
    const tokens = this.buildTokens(target);
    mkdirSync(destDir, { recursive: true });
    for (const f of readdirSync(srcDir)) {
      if (!f.endsWith('.cjs')) continue;
      this.writeFromTemplate(resolve(srcDir, f), resolve(destDir, f), tokens);
    }
  }

  /** Copy seed workflow YAMLs verbatim (no token substitution). */
  writeWorkflowSeeds(target: ProjectScaffoldTarget): void {
    const srcDir = resolve(this.deps.templatesDir, '.project-companion', 'workflows');
    const destDir = resolve(target.folderPath, '.project-companion', 'workflows');
    mkdirSync(destDir, { recursive: true });
    for (const f of readdirSync(srcDir)) {
      if (!f.endsWith('.yaml')) continue;
      copyFileSync(resolve(srcDir, f), resolve(destDir, f));
    }
  }

  /** Render `<folder>/README.md` from template. */
  writeReadme(target: ProjectScaffoldTarget): void {
    this.writeFromTemplate(
      resolve(this.deps.templatesDir, 'README.template.md'),
      resolve(target.folderPath, 'README.md'),
      this.buildTokens(target),
    );
  }

  /** Build the token map for `target`. Exposed for callers that need to render
   *  an ad-hoc template using the same set.
   *
   *  Path tokens are normalized to forward slashes — backslashes from `path.resolve`
   *  on Windows would otherwise produce invalid JSON when substituted into the
   *  .mcp.json / settings.json templates (`"E:\\Claude\\C..."`-style strings).
   *  Node + git accept forward slashes natively on Windows, so this normalization
   *  is cross-platform safe. */
  buildTokens(target: ProjectScaffoldTarget): Record<string, string> {
    return {
      PC_TRUNK_PATH: posixPath(this.deps.trunkPath),
      PC_SERVER_PORT: String(this.deps.serverPort),
      PC_CHANNEL_PORT: String(this.deps.channelPort),
      // 18.4 — Inbox-drain hook reads agent_inbox rows from the global PC db.
      PC_DB_PATH: posixPath(resolve(this.deps.dataDir, 'pc.sqlite')),
      PROJECT_ID: target.projectId,
      PROJECT_SLUG: target.projectSlug,
      PROJECT_FOLDER: posixPath(target.folderPath),
      PROJECT_NAME: target.projectName,
      PROJECT_DATA_DIR: posixPath(resolve(this.deps.dataDir, 'projects', target.projectId)),
    };
  }

  private writeFromTemplate(
    templatePath: string,
    destPath: string,
    tokens: Record<string, string>,
  ): void {
    const raw = readFileSync(templatePath, 'utf-8');
    const rendered = renderTemplate(raw, tokens);
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, rendered, 'utf-8');
  }
}

/** Replace `{{KEY}}` occurrences with `tokens[KEY]`. Unknown keys pass through. */
export function renderTemplate(text: string, tokens: Record<string, string>): string {
  return text.replace(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g, (m, key) => {
    return Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key]! : m;
  });
}

/** Normalize a Windows path to forward slashes so it's safe to embed in a JSON
 *  string literal without escaping. POSIX paths pass through untouched. */
function posixPath(p: string): string {
  return p.replace(/\\/g, '/');
}
