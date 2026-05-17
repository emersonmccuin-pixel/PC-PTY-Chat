// Project scaffold writer. Renders trunk-side templates into a project folder
// with per-project tokens substituted. P8's create-project endpoint calls into
// this after `git init` to produce `<folder>/.mcp.json` and
// `<folder>/.claude/settings.json` (then commits them as part of the scaffold).
//
// Template format: `{{TOKEN}}` placeholders, alnum + underscore. Unknown tokens
// are left as-is so a malformed template is visible on inspection rather than
// silently emptied.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface ProjectScaffoldDeps {
  /** Absolute trunk root (`<pc-repo>/`). Substituted into `{{PC_TRUNK_PATH}}`. */
  trunkPath: string;
  /** Absolute path to the `templates/` dir. */
  templatesDir: string;
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

  /**
   * Write the two generated configs into the project folder:
   *  - `<folder>/.mcp.json` from `templates/.mcp.template.json`
   *  - `<folder>/.claude/settings.json` from `templates/.claude/settings.template.json`
   *
   * Parent dirs are created if missing. Overwrites existing files — P8 commits
   * pre-existing user files first, so the scaffold pass is allowed to clobber.
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

  /** Build the token map for `target`. Exposed for callers that need to render
   *  a different template (e.g. P8's README pass). */
  buildTokens(target: ProjectScaffoldTarget): Record<string, string> {
    return {
      PC_TRUNK_PATH: this.deps.trunkPath,
      PC_SERVER_PORT: String(this.deps.serverPort),
      PC_CHANNEL_PORT: String(this.deps.channelPort),
      PROJECT_ID: target.projectId,
      PROJECT_SLUG: target.projectSlug,
      PROJECT_FOLDER: target.folderPath,
      PROJECT_NAME: target.projectName,
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
