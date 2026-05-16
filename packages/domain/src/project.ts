// Project + Stage domain types. A project owns an ordered list of stages
// (kanban columns); work items flow between them.
//
// In the rig the project lives in data/project.json. In PC, projects are a row
// in sqlite; stages live on the project row (architecture §5).
//
// Slice 8b: `on_enter` removed from Stage. Triggers now live on workflow YAMLs
// in workspace/.project-companion/workflows/; the runtime looks up matching
// workflows by stage_id when a work item moves.

export interface Stage {
  /** Immutable id — auto-slugged from the initial name, locked at create. */
  id: string;
  /** Display name. Freely editable; id stays the same so workflow triggers don't break. */
  name: string;
  /** Position in the kanban (low → high, left → right). */
  order: number;
}

export interface Project {
  id: string;
  name: string;
  stages: Stage[];
}
