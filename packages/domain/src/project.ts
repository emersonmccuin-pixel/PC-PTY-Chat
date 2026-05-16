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
}

export interface Project {
  id: ULID;
  name: string;
  stages: Stage[];
}
