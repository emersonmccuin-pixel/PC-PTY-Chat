// Subagent output-schema validation (Section 4h / 4h.6 / D78).
//
// At pc_complete_node time, the subagent passes back an `output` payload —
// typically `{ result: '...', ... }`. The author-declared `output_schema:`
// on the subagent node (parsed into edges[nodeId].output_schema during
// 4h.3) is the contract: declared fields must be present and carry the
// declared catalog type. Mismatch → the runtime fails the node with a
// shape-mismatch error (same surface as `done_when` violation).
//
// What the validator IS:
//   - Checks every field the schema declares: present + typed correctly.
//   - Catalog primitive types per D78: ulid / string / text / int / bool /
//     object / array. `ulid` accepts any string (we don't strictly enforce
//     the ULID byte shape — overkill for v1; the author can layer a
//     stricter check in their subagent if they want).
//
// What the validator ISN'T:
//   - Strict — extra fields beyond the schema are allowed. Adding fields
//     later is a non-breaking change for consumers.
//   - A type-inference engine — `object` and `array` are escape hatches;
//     we don't drill into their shape.
//
// Returns a structured result so the runtime can fold the failure into the
// existing done_when-fail path (retry → terminal failed status + broadcast).

import type { CatalogType } from '@pc/domain';

export interface OutputSchemaValidationOk {
  readonly ok: true;
}

export interface OutputSchemaValidationErr {
  readonly ok: false;
  /** Human-readable single-sentence summary. Lands on the node's `error`
   *  field; rendered in the run-detail view. */
  readonly message: string;
}

export type OutputSchemaValidationResult =
  | OutputSchemaValidationOk
  | OutputSchemaValidationErr;

/** Validate a `pc_complete_node` output payload against the subagent
 *  node's declared output schema. Empty schema (no declared fields) is
 *  trivially OK — there's nothing to enforce. */
export function validateSubagentOutput(
  output: unknown,
  schema: Readonly<Record<string, CatalogType>>,
): OutputSchemaValidationResult {
  const declaredFields = Object.keys(schema);
  if (declaredFields.length === 0) return { ok: true };

  if (output === null || output === undefined) {
    return {
      ok: false,
      message: `output_schema mismatch: expected an object with field${declaredFields.length === 1 ? '' : 's'} ${formatFieldList(declaredFields)}, got ${output === null ? 'null' : 'no output'}`,
    };
  }
  if (typeof output !== 'object' || Array.isArray(output)) {
    return {
      ok: false,
      message: `output_schema mismatch: expected an object with field${declaredFields.length === 1 ? '' : 's'} ${formatFieldList(declaredFields)}, got ${describeKind(output)}`,
    };
  }

  const record = output as Record<string, unknown>;
  for (const [fieldName, type] of Object.entries(schema)) {
    if (!(fieldName in record) || record[fieldName] === undefined) {
      return {
        ok: false,
        message: `output_schema mismatch: missing field "${fieldName}" (expected ${type})`,
      };
    }
    const value = record[fieldName];
    if (!matchesType(value, type)) {
      return {
        ok: false,
        message: `output_schema mismatch: field "${fieldName}" expected ${type}, got ${describeKind(value)}`,
      };
    }
  }
  return { ok: true };
}

function matchesType(value: unknown, type: CatalogType): boolean {
  switch (type) {
    case 'ulid':
    case 'string':
    case 'text':
      return typeof value === 'string';
    case 'int':
      return typeof value === 'number' && Number.isInteger(value);
    case 'bool':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
  }
}

function describeKind(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function formatFieldList(fields: readonly string[]): string {
  return fields.map((f) => `"${f}"`).join(', ');
}
