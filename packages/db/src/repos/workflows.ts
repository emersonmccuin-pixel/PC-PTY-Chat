// Section 19.16 — Repository layer for the promoted `workflows` table.
//
// CRUD + scope/promote/duplicate/soft-delete affordances mirroring repos/pods.ts.
// Every mutation writes a `workflow_audit` row in the same transaction.
//
// Identity model (mirrors agents):
//   - `id` is an internal ULID (PK). Cross-scope unique by construction.
//   - `slug` is the author-readable kebab-case identifier from the YAML's
//     `id:` field. Per-scope partial UNIQUE — two projects can both define
//     `triage`; one global may also exist.
//   - `name` is the per-scope-unique display label. UI surfaces use this.
//
// Resolution at dispatch (mirrors `resolveAgentForDispatch`): project-scope
// row for this project wins, then live global row with the same slug.

import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import type {
  PodScope,
  ULID,
  WorkflowAuditField,
  WorkflowOrigin,
  WorkflowRow,
  WorkflowRowStatus,
} from '@pc/domain';
import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { workflowAudit, workflows } from '../schema.ts';
import {
  type WorkflowAuditInput,
  buildWorkflowAuditRow,
} from './workflow-audit.ts';

// --- conversion ------------------------------------------------------------

function rowToWorkflow(row: typeof workflows.$inferSelect): WorkflowRow {
  return {
    id: row.id as ULID,
    scope: row.scope,
    projectId: row.projectId ?? null,
    slug: row.slug,
    name: row.name,
    displayName: row.displayName ?? null,
    description: row.description ?? null,
    yaml: row.yaml,
    yamlHash: row.yamlHash,
    parsedDefinition: row.parsedDefinition ?? null,
    status: row.status,
    parseError: row.parseError ?? null,
    disabled: row.disabled,
    origin: row.origin,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? null,
  };
}

/** Compact JSON snapshot used by `created` / `deleted` audit rows. */
function workflowSnapshot(row: WorkflowRow): string {
  return JSON.stringify({
    scope: row.scope,
    projectId: row.projectId,
    slug: row.slug,
    name: row.name,
    displayName: row.displayName,
    description: row.description,
    yamlHash: row.yamlHash,
    status: row.status,
    disabled: row.disabled,
    origin: row.origin,
  });
}

// --- create ----------------------------------------------------------------

export interface CreateWorkflowInput {
  /** Optional pre-minted ULID. The repo mints one when omitted. */
  id?: ULID;
  /** Kebab-case slug from the YAML's `id:`. Required. */
  slug: string;
  scope: PodScope;
  /** Required when `scope === 'project'`. */
  projectId?: ULID | null;
  name: string;
  displayName?: string | null;
  description?: string | null;
  yaml: string;
  yamlHash: string;
  parsedDefinition?: unknown | null;
  status?: WorkflowRowStatus;
  parseError?: string | null;
  disabled?: boolean;
  origin?: WorkflowOrigin;
}

export function createWorkflow(
  input: CreateWorkflowInput,
  audit: WorkflowAuditInput,
): WorkflowRow {
  if (input.scope === 'project' && !input.projectId) {
    throw new Error('createWorkflow: projectId is required when scope === "project"');
  }
  const now = Date.now();
  const id = (input.id ?? newId()) as ULID;
  const row = {
    id,
    scope: input.scope,
    projectId: input.scope === 'project' ? input.projectId ?? null : null,
    slug: input.slug,
    name: input.name,
    displayName: input.displayName ?? null,
    description: input.description ?? null,
    yaml: input.yaml,
    yamlHash: input.yamlHash,
    parsedDefinition: input.parsedDefinition ?? null,
    status: input.status ?? 'active',
    parseError: input.parseError ?? null,
    disabled: input.disabled ?? false,
    origin: input.origin ?? 'user-created',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  const out = rowToWorkflow(row as typeof workflows.$inferSelect);
  const auditValues = buildWorkflowAuditRow(
    {
      workflowId: id,
      field: 'created',
      newValue: workflowSnapshot(out),
      audit,
    },
    now,
  );
  getDb().transaction((tx) => {
    tx.insert(workflows).values(row).run();
    tx.insert(workflowAudit).values(auditValues).run();
  });
  return out;
}

// --- read ------------------------------------------------------------------

export function getWorkflowById(id: ULID): WorkflowRow | null {
  const row = getDb()
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, id), isNull(workflows.deletedAt)))
    .get();
  return row ? rowToWorkflow(row) : null;
}

/** Include soft-deleted rows. Used by the restore path. */
export function getWorkflowByIdIncludingDeleted(id: ULID): WorkflowRow | null {
  const row = getDb().select().from(workflows).where(eq(workflows.id, id)).get();
  return row ? rowToWorkflow(row) : null;
}

export interface GetWorkflowBySlugInput {
  slug: string;
  scope: PodScope;
  projectId?: ULID | null;
  /** Include soft-deleted rows. Defaults to false. */
  includeDeleted?: boolean;
}

export function getWorkflowBySlug(input: GetWorkflowBySlugInput): WorkflowRow | null {
  if (input.scope === 'project' && !input.projectId) {
    throw new Error('getWorkflowBySlug: projectId is required when scope === "project"');
  }
  const projectCmp =
    input.scope === 'project'
      ? eq(workflows.projectId, input.projectId!)
      : isNull(workflows.projectId);
  const conditions = [
    eq(workflows.slug, input.slug),
    eq(workflows.scope, input.scope),
    projectCmp,
  ];
  if (!input.includeDeleted) conditions.push(isNull(workflows.deletedAt));
  const row = getDb()
    .select()
    .from(workflows)
    .where(and(...conditions))
    .get();
  return row ? rowToWorkflow(row) : null;
}

export interface GetWorkflowByNameInput {
  name: string;
  scope: PodScope;
  projectId?: ULID | null;
}

export function getWorkflowByName(input: GetWorkflowByNameInput): WorkflowRow | null {
  if (input.scope === 'project' && !input.projectId) {
    throw new Error('getWorkflowByName: projectId is required when scope === "project"');
  }
  const projectCmp =
    input.scope === 'project'
      ? eq(workflows.projectId, input.projectId!)
      : isNull(workflows.projectId);
  const row = getDb()
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.name, input.name),
        eq(workflows.scope, input.scope),
        projectCmp,
        isNull(workflows.deletedAt),
      ),
    )
    .get();
  return row ? rowToWorkflow(row) : null;
}

export interface ListWorkflowsOptions {
  scope?: PodScope;
  projectId?: ULID;
  includeGlobals?: boolean;
}

export function listWorkflows(opts: ListWorkflowsOptions = {}): WorkflowRow[] {
  const conditions = [isNull(workflows.deletedAt)];
  if (opts.projectId !== undefined) {
    if (opts.includeGlobals) {
      conditions.push(
        or(
          eq(workflows.scope, 'global'),
          and(eq(workflows.scope, 'project'), eq(workflows.projectId, opts.projectId)),
        )!,
      );
    } else {
      conditions.push(eq(workflows.scope, 'project'));
      conditions.push(eq(workflows.projectId, opts.projectId));
    }
  } else if (opts.scope !== undefined) {
    conditions.push(eq(workflows.scope, opts.scope));
  }
  const rows = getDb()
    .select()
    .from(workflows)
    .where(and(...conditions))
    .orderBy(asc(workflows.name))
    .all();
  return rows.map(rowToWorkflow);
}

// --- update ----------------------------------------------------------------

export interface UpdateWorkflowInput {
  name?: string;
  displayName?: string | null;
  description?: string | null;
  yaml?: string;
  yamlHash?: string;
  parsedDefinition?: unknown | null;
  status?: WorkflowRowStatus;
  parseError?: string | null;
  disabled?: boolean;
}

/** Map UpdateWorkflowInput keys → (audit field, db column). Order matters:
 *  audit rows are emitted in this order for deterministic test output. */
const UPDATE_WORKFLOW_FIELD_MAP: ReadonlyArray<
  [keyof UpdateWorkflowInput, WorkflowAuditField, keyof typeof workflows.$inferSelect]
> = [
  ['name', 'name', 'name'],
  ['displayName', 'display_name', 'displayName'],
  ['description', 'description', 'description'],
  ['yaml', 'yaml', 'yaml'],
  ['disabled', 'disabled', 'disabled'],
];

export function updateWorkflow(
  id: ULID,
  patch: UpdateWorkflowInput,
  audit: WorkflowAuditInput,
): WorkflowRow | null {
  const existing = getWorkflowById(id);
  if (!existing) return null;

  type Change = {
    auditField: WorkflowAuditField;
    column: string;
    prior: string;
    next: string;
  };
  const changes: Change[] = [];
  for (const [patchKey, auditField, column] of UPDATE_WORKFLOW_FIELD_MAP) {
    const nextRaw = patch[patchKey];
    if (nextRaw === undefined) continue;
    const priorRaw = existing[patchKey as keyof WorkflowRow];
    if (JSON.stringify(nextRaw) === JSON.stringify(priorRaw)) continue;
    changes.push({
      auditField,
      column,
      prior: JSON.stringify(priorRaw),
      next: JSON.stringify(nextRaw),
    });
  }

  // Non-audited shadow fields (yamlHash / parsedDefinition / status / parseError
  // ride with `yaml`).
  const shadowChanges: Record<string, unknown> = {};
  if (patch.yamlHash !== undefined && patch.yamlHash !== existing.yamlHash) {
    shadowChanges.yamlHash = patch.yamlHash;
  }
  if (
    patch.parsedDefinition !== undefined &&
    JSON.stringify(patch.parsedDefinition) !== JSON.stringify(existing.parsedDefinition)
  ) {
    shadowChanges.parsedDefinition = patch.parsedDefinition;
  }
  if (patch.status !== undefined && patch.status !== existing.status) {
    shadowChanges.status = patch.status;
  }
  if (patch.parseError !== undefined && patch.parseError !== existing.parseError) {
    shadowChanges.parseError = patch.parseError;
  }

  if (changes.length === 0 && Object.keys(shadowChanges).length === 0) {
    return existing;
  }

  const now = Date.now();
  const set: Record<string, unknown> = { updatedAt: now, ...shadowChanges };
  for (const [patchKey, , column] of UPDATE_WORKFLOW_FIELD_MAP) {
    if (patch[patchKey] !== undefined) set[column] = patch[patchKey];
  }
  const groupedAudit: WorkflowAuditInput =
    changes.length > 1 && !audit.changeSetId
      ? { ...audit, changeSetId: newId() as ULID }
      : audit;
  const auditRows = changes.map((c) =>
    buildWorkflowAuditRow(
      {
        workflowId: id,
        field: c.auditField,
        priorValue: c.prior,
        newValue: c.next,
        audit: groupedAudit,
      },
      now,
    ),
  );
  getDb().transaction((tx) => {
    tx.update(workflows).set(set).where(eq(workflows.id, id)).run();
    for (const r of auditRows) tx.insert(workflowAudit).values(r).run();
  });
  return getWorkflowById(id);
}

// --- soft-delete + restore ------------------------------------------------

export function softDeleteWorkflow(
  id: ULID,
  audit: WorkflowAuditInput,
): WorkflowRow | null {
  const existing = getWorkflowById(id);
  if (!existing) return null;
  const now = Date.now();
  const out = { ...existing, deletedAt: now, updatedAt: now };
  const auditValues = buildWorkflowAuditRow(
    {
      workflowId: id,
      field: 'deleted',
      priorValue: workflowSnapshot(existing),
      audit,
    },
    now,
  );
  getDb().transaction((tx) => {
    tx.update(workflows)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(workflows.id, id))
      .run();
    tx.insert(workflowAudit).values(auditValues).run();
  });
  return out;
}

/** Clear `deleted_at`. Returns the restored row, or null if id unknown or not
 *  currently deleted. Intentionally NOT audited (mirrors agents). */
export function restoreWorkflow(id: ULID): WorkflowRow | null {
  const row = getDb().select().from(workflows).where(eq(workflows.id, id)).get();
  if (!row || row.deletedAt === null) return null;
  const now = Date.now();
  getDb()
    .update(workflows)
    .set({ deletedAt: null, updatedAt: now })
    .where(eq(workflows.id, id))
    .run();
  return getWorkflowById(id);
}

// --- promote-to-global -----------------------------------------------------

/** Flip `scope='global'`, clear `projectId`. Throws if the row is already
 *  global. UNIQUE constraint on `workflows_global_slug_idx` or
 *  `workflows_global_name_idx` may throw if a global with the same slug or
 *  name already exists — caller surfaces as 409. */
export function promoteWorkflowToGlobal(
  id: ULID,
  audit: WorkflowAuditInput,
): WorkflowRow | null {
  const existing = getWorkflowById(id);
  if (!existing) return null;
  if (existing.scope === 'global') {
    throw new Error('already global');
  }
  const now = Date.now();
  const prior = JSON.stringify({
    scope: existing.scope,
    projectId: existing.projectId,
  });
  const next = JSON.stringify({ scope: 'global', projectId: null });
  const auditRow = buildWorkflowAuditRow(
    {
      workflowId: id,
      field: 'scope',
      priorValue: prior,
      newValue: next,
      audit,
    },
    now,
  );
  getDb().transaction((tx) => {
    tx.update(workflows)
      .set({ scope: 'global', projectId: null, updatedAt: now })
      .where(eq(workflows.id, id))
      .run();
    tx.insert(workflowAudit).values(auditRow).run();
  });
  return getWorkflowById(id);
}

// --- duplicate -------------------------------------------------------------

export interface DuplicateWorkflowInput {
  sourceId: ULID;
  /** New slug for the clone. Defaults to `<sourceSlug>-copy`. */
  newSlug?: string;
  /** New name for the clone. Defaults to `<sourceName> (copy)`. */
  newName?: string;
  /** Override the target project. Defaults to the source's projectId (or
   *  null for global sources, in which case `projectId` MUST be supplied to
   *  clone into a project). */
  targetProjectId?: ULID | null;
  /** Override the scope. Defaults to source's scope. */
  targetScope?: PodScope;
}

/** Clone a workflow as a NEW row with a fresh ULID. Force-disabled. Audit row
 *  on the clone carries `field='duplicated_from'` with the source slug in
 *  `priorValue` for History lineage. */
export function duplicateWorkflow(
  input: DuplicateWorkflowInput,
  audit: WorkflowAuditInput,
): WorkflowRow {
  const source = getWorkflowById(input.sourceId);
  if (!source) throw new Error(`unknown source workflow: ${input.sourceId}`);

  const targetScope = input.targetScope ?? source.scope;
  const targetProjectId =
    input.targetProjectId !== undefined ? input.targetProjectId : source.projectId;
  if (targetScope === 'project' && !targetProjectId) {
    throw new Error('duplicateWorkflow: projectId required for project-scope clone');
  }

  const newSlug = input.newSlug ?? `${source.slug}-copy`;
  const newName = input.newName ?? `${source.name} (copy)`;

  const slugCollision = getWorkflowBySlug({
    slug: newSlug,
    scope: targetScope,
    projectId: targetScope === 'project' ? targetProjectId! : null,
  });
  if (slugCollision) {
    throw new Error(`workflow slug "${newSlug}" already exists in the target scope`);
  }
  const nameCollision = getWorkflowByName({
    name: newName,
    scope: targetScope,
    projectId: targetScope === 'project' ? targetProjectId! : null,
  });
  if (nameCollision) {
    throw new Error(`a workflow named "${newName}" already exists in the target scope`);
  }

  const now = Date.now();
  const newId_ = newId() as ULID;
  const cloneRow = {
    id: newId_,
    scope: targetScope,
    projectId: targetScope === 'project' ? targetProjectId! : null,
    slug: newSlug,
    name: newName,
    displayName: source.displayName,
    description: source.description,
    yaml: source.yaml,
    yamlHash: source.yamlHash,
    parsedDefinition: source.parsedDefinition,
    status: source.status,
    parseError: source.parseError,
    disabled: true,
    origin: 'user-created' as WorkflowOrigin,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  const out = rowToWorkflow(cloneRow as typeof workflows.$inferSelect);
  const auditRow = buildWorkflowAuditRow(
    {
      workflowId: newId_,
      field: 'duplicated_from',
      priorValue: source.id,
      newValue: workflowSnapshot(out),
      audit,
    },
    now,
  );
  getDb().transaction((tx) => {
    tx.insert(workflows).values(cloneRow).run();
    tx.insert(workflowAudit).values(auditRow).run();
  });
  return out;
}

// --- dispatch resolution ---------------------------------------------------

/** Prefer a project-scoped row for this project; fall back to a live global
 *  row with the same slug. Returns null when neither exists. Mirrors
 *  `resolveAgentForDispatch`. */
export function resolveWorkflowForDispatch(
  slug: string,
  projectId?: ULID | null,
): WorkflowRow | null {
  if (projectId) {
    const project = getWorkflowBySlug({ slug, scope: 'project', projectId });
    if (project) return project;
  }
  return getWorkflowBySlug({ slug, scope: 'global' });
}

// --- raw count (used by importer health-check) -----------------------------

export function countActiveWorkflowsForProject(projectId: ULID): number {
  const rows = getDb()
    .select({ c: sql<number>`count(*)` })
    .from(workflows)
    .where(
      and(
        eq(workflows.scope, 'project'),
        eq(workflows.projectId, projectId),
        isNull(workflows.deletedAt),
      ),
    )
    .get();
  return rows?.c ?? 0;
}
