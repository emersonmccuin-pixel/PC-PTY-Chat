import { asc, eq } from 'drizzle-orm';
import type { FieldSchema, FieldSchemaType, ULID } from '@pc/domain';
import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { fieldSchemas } from '../schema.ts';

interface FieldSchemaRow {
  id: ULID;
  projectId: ULID;
  key: string;
  label: string;
  type: FieldSchemaType;
  options: string[] | null;
  default: unknown;
  required: boolean;
  description: string | null;
  order: number;
}

function toDomain(row: FieldSchemaRow): FieldSchema {
  const out: FieldSchema = {
    id: row.id,
    projectId: row.projectId,
    key: row.key,
    label: row.label,
    type: row.type,
    required: row.required,
    order: row.order,
  };
  if (row.options !== null) out.options = row.options;
  if (row.default !== null && row.default !== undefined) out.default = row.default;
  if (row.description !== null) out.description = row.description;
  return out;
}

export function listFieldSchemas(projectId: ULID): FieldSchema[] {
  const rows = getDb()
    .select()
    .from(fieldSchemas)
    .where(eq(fieldSchemas.projectId, projectId))
    .orderBy(asc(fieldSchemas.order), asc(fieldSchemas.key))
    .all() as FieldSchemaRow[];
  return rows.map(toDomain);
}

export interface ReplaceFieldSchemasInput {
  projectId: ULID;
  items: Array<Omit<FieldSchema, 'id' | 'projectId'> & { id?: ULID }>;
}

/** Bulk replace: delete all existing schemas for the project, insert the new
 *  set. Preserves explicit ids in the input so callers can keep stable ids
 *  across edits; mints a fresh ULID for entries without one. */
export function replaceFieldSchemas(input: ReplaceFieldSchemasInput): FieldSchema[] {
  const db = getDb();
  db.delete(fieldSchemas).where(eq(fieldSchemas.projectId, input.projectId)).run();
  const rows: FieldSchemaRow[] = input.items.map((item, idx) => ({
    id: (item.id ?? newId()) as ULID,
    projectId: input.projectId,
    key: item.key,
    label: item.label,
    type: item.type,
    options: item.options ?? null,
    default: item.default ?? null,
    required: item.required,
    description: item.description ?? null,
    order: item.order ?? idx,
  }));
  if (rows.length > 0) {
    db.insert(fieldSchemas).values(rows).run();
  }
  return rows.map(toDomain);
}
