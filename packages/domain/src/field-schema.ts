// Per-project field schema. Defines the typed editors in the WorkItem
// detail modal's Overview tab and the validation rules applied on
// create/PATCH.

import type { ULID } from './ulid.ts';

export type FieldSchemaType = 'text' | 'number' | 'boolean' | 'enum' | 'date';

export interface FieldSchema {
  id: ULID;
  projectId: ULID;
  /** Matches `WorkItem.fields[key]`. Author-chosen; renames are a key change. */
  key: string;
  /** Display label in the editor. */
  label: string;
  type: FieldSchemaType;
  /** Required for `type === 'enum'`; ignored otherwise. */
  options?: string[];
  /** Default applied on work-item create when the user didn't provide a value. */
  default?: unknown;
  required: boolean;
  description?: string;
  /** Order within the editor (low → high). */
  order: number;
}

export interface ValidateFieldsOk {
  ok: true;
  value: Record<string, unknown>;
}

export interface ValidateFieldsErrors {
  ok: false;
  errors: Record<string, string>;
}

export type ValidateFieldsResult = ValidateFieldsOk | ValidateFieldsErrors;

export interface ValidateFieldsOptions {
  /** create: enforce `required` on every schema entry, missing key = error.
   *  patch: only validate keys present in `input`. */
  mode: 'create' | 'patch';
}

/** Pure validator. Coerces input values to the declared type, enforces enum
 *  options, and enforces required. Unknown keys (no matching schema) are
 *  preserved as-is in the returned `value` map — they surface in the UI as
 *  orphan fields. */
export function validateFields(
  input: Record<string, unknown>,
  schemas: FieldSchema[],
  options: ValidateFieldsOptions,
): ValidateFieldsResult {
  const errors: Record<string, string> = {};
  const value: Record<string, unknown> = {};

  const schemaByKey = new Map<string, FieldSchema>();
  for (const s of schemas) schemaByKey.set(s.key, s);

  for (const s of schemas) {
    const hasInput = Object.prototype.hasOwnProperty.call(input, s.key);
    const raw = hasInput ? input[s.key] : undefined;

    if (!hasInput) {
      if (options.mode === 'create') {
        if (s.default !== undefined) {
          value[s.key] = s.default;
        } else if (s.required) {
          errors[s.key] = `${s.label} is required`;
        }
      }
      continue;
    }

    if (raw === null || raw === undefined || raw === '') {
      if (s.required) {
        errors[s.key] = `${s.label} is required`;
      }
      continue;
    }

    const coerced = coerce(raw, s, errors);
    if (errors[s.key] === undefined) value[s.key] = coerced;
  }

  for (const key of Object.keys(input)) {
    if (schemaByKey.has(key)) continue;
    value[key] = input[key];
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value };
}

function coerce(raw: unknown, s: FieldSchema, errors: Record<string, string>): unknown {
  switch (s.type) {
    case 'text': {
      if (typeof raw === 'string') return raw;
      errors[s.key] = `${s.label} must be a string`;
      return undefined;
    }
    case 'number': {
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
      if (typeof raw === 'string' && raw.trim() !== '') {
        const n = Number(raw);
        if (Number.isFinite(n)) return n;
      }
      errors[s.key] = `${s.label} must be a number`;
      return undefined;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      errors[s.key] = `${s.label} must be true or false`;
      return undefined;
    }
    case 'enum': {
      const opts = s.options ?? [];
      if (opts.length === 0) {
        errors[s.key] = `${s.label} has no options configured`;
        return undefined;
      }
      if (typeof raw === 'string' && opts.includes(raw)) return raw;
      errors[s.key] = `${s.label} must be one of: ${opts.join(', ')}`;
      return undefined;
    }
    case 'date': {
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
      if (typeof raw === 'string' && raw.trim() !== '') {
        const ms = Date.parse(raw);
        if (Number.isFinite(ms)) return ms;
      }
      errors[s.key] = `${s.label} must be a valid date`;
      return undefined;
    }
    default: {
      errors[s.key] = `${s.label} has unknown type`;
      return undefined;
    }
  }
}
