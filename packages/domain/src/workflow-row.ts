// Section 19.16 — DB row + audit shapes for the promoted `workflows` table.
//
// These describe the persisted row, not the workflow graph itself. The graph
// shape lives in `workflow-v2.ts` under the `WorkflowV2` namespace and is
// stored (a) as YAML text in `workflows.yaml` and (b) as a parsed JSON blob
// in `workflows.parsed_definition`.
//
// Mirrors the agents pattern (see pod.ts) so the workflows surface can reuse
// the audit-on-mutate + scope/promote/duplicate/soft-delete affordances the
// History tab + rail already understand.

import type { PodAuditActor, PodScope } from './pod.ts';
import type { ULID } from './ulid.ts';

/** v1: every row is `'user-created'`. Reserved for forward compat with the
 *  agents stock-vs-user-created split. */
export type WorkflowOrigin = 'stock' | 'user-created';

/** Lifecycle status of the persisted row. `'active'` = parsed cleanly + ready
 *  to fire; `'invalid'` = YAML failed parse/validation and `parseError` carries
 *  the user-visible reason. */
export type WorkflowRowStatus = 'active' | 'invalid';

/** Persisted workflow row. The graph itself lives in `yaml` + `parsedDefinition`. */
export interface WorkflowRow {
  /** Internal ULID PK (mirrors agents — author-readable identity lives in
   *  `slug`). Cross-scope unique by construction. */
  id: ULID;
  scope: PodScope;
  /** NULL when `scope === 'global'`. Required when `scope === 'project'`. */
  projectId: ULID | null;
  /** Author-readable slug from the YAML's `id:`. Kebab-case, unique per
   *  (scope, projectId) among live rows. */
  slug: string;
  name: string;
  displayName: string | null;
  description: string | null;
  yaml: string;
  yamlHash: string;
  /** JSON-encoded `WorkflowV2.Workflow` shape. Null when status === 'invalid'. */
  parsedDefinition: unknown | null;
  status: WorkflowRowStatus;
  parseError: string | null;
  /** Lifted out of YAML so disable/enable is a cheap DB write. */
  disabled: boolean;
  origin: WorkflowOrigin;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

/** Audit `field` discriminates which slice of the workflow changed.
 *  `field_ref` disambiguates list-shaped fields (reserved for future per-node
 *  edits; v1 mutations are whole-YAML so `'yaml'` covers everything). */
export type WorkflowAuditField =
  | 'created'
  | 'deleted'
  | 'restored'
  | 'name'
  | 'display_name'
  | 'description'
  | 'yaml'
  | 'disabled'
  | 'scope'
  | 'duplicated_from'
  | 'promoted_to_global';

export const WORKFLOW_AUDIT_FIELDS: readonly WorkflowAuditField[] = [
  'created',
  'deleted',
  'restored',
  'name',
  'display_name',
  'description',
  'yaml',
  'disabled',
  'scope',
  'duplicated_from',
  'promoted_to_global',
];

export interface WorkflowAuditRow {
  id: ULID;
  workflowId: ULID;
  changeSetId: ULID | null;
  actor: PodAuditActor;
  field: WorkflowAuditField;
  fieldRef: string | null;
  priorValue: string | null;
  newValue: string | null;
  reason: string | null;
  createdAt: number;
}
