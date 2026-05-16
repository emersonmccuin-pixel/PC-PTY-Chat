// Worktree row type. Slimmer than v1's IsolationEnvironment — v2's rig-shape
// worktree tracking is just "name → absolute path, optionally bound to a
// work item or run". When multi-tenant + multi-repo lands, this grows.

import type { ULID } from './ulid.ts';

export type WorktreeStatus = 'active' | 'destroyed';

export interface Worktree {
  id: ULID;
  /** Branch name == worktree dir name (the rig's convention, e.g. `wi-<id>` or `run-<short>`). */
  name: string;
  /** Absolute filesystem path to the worktree dir. */
  path: string;
  /** Bound work item if this is a `wi-<id>` worktree. */
  workItemId: ULID | null;
  /** Bound run if this is a `run-<short>` worktree. */
  workflowRunId: ULID | null;
  status: WorktreeStatus;
  createdAt: number;
  destroyedAt: number | null;
}
