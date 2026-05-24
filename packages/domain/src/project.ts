// Project + Stage domain types. A project owns an ordered list of stages
// (kanban columns); work items flow between them.

import type { ULID } from './ulid.ts';

export interface Stage {
  /** Slug-style id (e.g. 'draft', 'review', 'done'). String, not ULID — workflow
   *  YAMLs reference stages by slug for human readability. */
  id: string;
  /** Display name. Freely editable; id stays the same so workflow triggers don't break. */
  name: string;
  /** Position in the kanban (low → high, left → right). */
  order: number;
  /** Section 27 — terminal-success stage. At most one per project. Cards landing
   *  here auto-flip status to `complete`; agent verification auto-advances. */
  isDone?: boolean;
  /** Section 27 — terminal-abandon stage. At most one per project. Cards landing
   *  here auto-flip status to `cancelled`. Visible on the kanban by default; can
   *  be hidden via global setting + per-project override. */
  isCancelled?: boolean;
  /** Section 27 — intake stage. At most one per project. `pc_log_bug` +
   *  `create-work-item` step land new cards here when no explicit stage is supplied. */
  isNew?: boolean;
}

export interface Project {
  id: ULID;
  /** URL-safe routing key. Derived from name + uniqued at create; locked thereafter
   *  (rename → slug migration is a deferred followup). Drives worktree paths, channel
   *  routes, and per-project filesystem layout. */
  slug: string;
  name: string;
  stages: Stage[];
  /** Absolute path to the user's project folder. Git-backed. */
  folderPath: string;
  /** Optional origin URL; null = local-only repo. Editable in project settings. */
  gitRemote: string | null;
}
