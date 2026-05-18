// FieldSchemaService — project-scoped facade over the field-schemas repo.
//
// list + replace; replace broadcasts so any open Overview tab can re-render
// its typed editors without a refetch.

import type { FieldSchema, ULID } from '@pc/domain';
import {
  listFieldSchemas,
  replaceFieldSchemas,
  type ReplaceFieldSchemasInput,
} from '@pc/db';

export type FieldSchemaBroadcast = (event: {
  type: 'field-schemas-changed';
  items: FieldSchema[];
}) => void;

export interface FieldSchemaServiceOptions {
  projectId: ULID;
  broadcast: FieldSchemaBroadcast;
}

export class FieldSchemaService {
  constructor(private readonly opts: FieldSchemaServiceOptions) {}

  list(): FieldSchema[] {
    return listFieldSchemas(this.opts.projectId);
  }

  replace(items: ReplaceFieldSchemasInput['items']): FieldSchema[] {
    const out = replaceFieldSchemas({ projectId: this.opts.projectId, items });
    this.opts.broadcast({ type: 'field-schemas-changed', items: out });
    return out;
  }
}
