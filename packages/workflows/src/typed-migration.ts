// Legacy → typed-edge YAML migration (Section 4h / 4h.7 / D80).
//
// Rewrites today's free-form `$<node>.output[.field]` / `$inputs.<key>` /
// `$ENV.<NAME>` strings into the new D77 typed-edge shape:
//
//   - Typed-port single-value fields: a compact `'@X.Y'` reference replaces
//     the legacy `$X.Y` whole-value string.
//   - Template-text fields (subagent prompt, bash body, HTTP body, attach
//     content, write-to-worktree content, …): every embedded `$X.Y` token
//     extracts to a `wire:` block entry on the node, and the text gets a
//     `{{ localName }}` placeholder in its place.
//   - Workflow-level `inputs:` block: dropped entirely (per the 4f.4
//     revert; the structural equivalent is trigger-node wiring).
//
// Aborts (no on-disk write) when migration can't preserve semantics:
//   - `$<node>.output` without a field — whole-output references have no
//     typed-edge equivalent. Author must specify which field they meant.
//   - `$inputs.<key>` where `<key>` isn't in the D75 catalog — authors
//     cannot invent variable names in the closed-world model.
//
// Idempotent: when the file is already in the new shape, returns
// `status: 'already-typed'` with no changes. Running migration twice is
// a no-op. Lossy on comments + key ordering (js-yaml dump round-trip);
// the runtime's boot-migration writes a `.pre-4h.bak` backup before
// rewriting so the original is recoverable.
//
// Not in scope for v1: inferring subagent `output_schema:` from
// downstream consumers' refs. Subagents that emit structured output via
// pc_complete_node still need an author-declared schema — the 4h.4 typed
// validator catches the missing case at save-time post-migration.

import { dump as yamlDump, load as yamlLoad } from 'js-yaml';

import { isCatalogName, NODE_PORT_SCHEMAS } from '@pc/domain';
import type { DagNode, NodePortSchema } from '@pc/domain';

export interface MigrationOk {
  readonly ok: true;
  readonly status: 'migrated' | 'already-typed';
  readonly text: string;
  /** True when `migrateWorkflowText` made any structural edit. False when
   *  the YAML was already in the new shape (round-trip safe to skip the
   *  on-disk write). */
  readonly mutated: boolean;
}

export interface MigrationErr {
  readonly ok: false;
  readonly message: string;
}

export type MigrationResult = MigrationOk | MigrationErr;

/** Body-field name per kind. Top-level (null) vs nested under
 *  `node[bodyField]`. Mirrors the same map in the typed parser. */
const KIND_BODY_FIELD: Record<DagNode['kind'], string | null> = {
  subagent: null,
  bash: null,
  http: 'http',
  script: null,
  approval: 'approval',
  cancel: null,
  workflow: null,
  loop: 'loop',
  'attach-to-work-item': 'attach-to-work-item',
  'create-work-item': 'create-work-item',
  'update-work-item': 'update-work-item',
  'write-to-worktree': 'write-to-worktree',
  'orchestrator-review': 'orchestrator-review',
};

/** Token patterns (mirror output-substitution.ts grammar). Authoritative
 *  source for what the migrator recognises as a legacy ref. */
const INPUTS_RE = /\$inputs\.([a-zA-Z_][a-zA-Z0-9_]*)((?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)/g;
const ENV_RE = /\$ENV\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
const OUTPUT_RE = /\$([a-zA-Z][a-zA-Z0-9_-]*)\.output((?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)/g;

/** Single-token whole-value forms — matches one legacy ref consuming the
 *  ENTIRE string (anchored). Used for typed-port single-value migration:
 *  if the field value is exactly one legacy token and nothing else, we
 *  rewrite to a compact `'@X.Y'` form. */
const SINGLE_INPUTS_RE = /^\$inputs\.([a-zA-Z_][a-zA-Z0-9_]*)$/;
const SINGLE_ENV_RE = /^\$ENV\.([a-zA-Z_][a-zA-Z0-9_]*)$/;
const SINGLE_OUTPUT_RE = /^\$([a-zA-Z][a-zA-Z0-9_-]*)\.output\.([a-zA-Z_][a-zA-Z0-9_]*)$/;
const SINGLE_OUTPUT_WHOLE_RE = /^\$([a-zA-Z][a-zA-Z0-9_-]*)\.output$/;

/** Migrate a single workflow YAML text. Pure function — no filesystem
 *  side-effects; caller decides whether to write + back up. */
export function migrateWorkflowText(yamlText: string): MigrationResult {
  let raw: unknown;
  try {
    raw = yamlLoad(yamlText);
  } catch (err) {
    return { ok: false, message: `yaml parse failed: ${(err as Error).message}` };
  }
  if (!isObj(raw)) {
    return { ok: false, message: 'top-level YAML must be a mapping' };
  }

  let mutated = false;

  // (1) Drop workflow-level inputs: block per D80.
  if (raw.inputs !== undefined) {
    delete raw.inputs;
    mutated = true;
  }

  // (2) Walk nodes (recursive — loop bodies + nested workflow inputs).
  const nodesField = raw.nodes;
  if (!Array.isArray(nodesField)) {
    return { ok: false, message: 'workflow has no `nodes:` list' };
  }

  const walkErr = migrateNodes(nodesField, (touched) => {
    if (touched) mutated = true;
  });
  if (walkErr) return walkErr;

  if (!mutated) {
    return { ok: true, status: 'already-typed', text: yamlText, mutated: false };
  }

  const newText = yamlDump(raw, { lineWidth: 0, noRefs: true });
  return { ok: true, status: 'migrated', text: newText, mutated: true };
}

function migrateNodes(
  rawNodes: unknown[],
  markMutated: (touched: boolean) => void,
): MigrationErr | null {
  for (let i = 0; i < rawNodes.length; i++) {
    const node = rawNodes[i];
    if (!isObj(node)) continue;
    const kind = pickKind(node);
    if (!kind) continue;
    const err = migrateNode(node, kind, markMutated);
    if (err) return err;

    // Recurse into loop bodies.
    if (kind === 'loop' && isObj(node.loop) && Array.isArray(node.loop.body)) {
      const inner = migrateNodes(node.loop.body, markMutated);
      if (inner) return inner;
    }
  }
  return null;
}

function migrateNode(
  rawNode: Record<string, unknown>,
  kind: DagNode['kind'],
  markMutated: (touched: boolean) => void,
): MigrationErr | null {
  const schema = NODE_PORT_SCHEMAS[kind] as NodePortSchema;
  const bodyField = KIND_BODY_FIELD[kind];
  const body = bodyField
    ? ((rawNode[bodyField] as Record<string, unknown> | undefined) ?? null)
    : rawNode;
  if (!body) return null;

  // (a) Typed-port single-value rewrite. For each declared port, look for a
  //     whole-value legacy ref; replace with compact `'@X.Y'` form.
  if (schema.inputs.mode === 'fixed') {
    for (const port of schema.inputs.ports) {
      const value = body[port.name];
      if (typeof value !== 'string') continue;
      // Already typed (`'@X.Y'` literal); skip.
      if (value.startsWith('@')) continue;
      const converted = convertSingleValueRef(value);
      if (converted === null) continue;
      if (typeof converted === 'object') return converted; // error
      body[port.name] = converted;
      markMutated(true);
    }
  }

  // (b) Template-text fields. Walk each field, extract every embedded
  //     legacy token, replace with `{{ localName }}`, build a wire entry.
  const wireMap = isObj(rawNode.wire) ? { ...rawNode.wire } : {};
  let wireChanged = false;
  for (const template of schema.templates) {
    const target = readDotted(body, template.name);
    if (typeof target.value !== 'string') continue;
    const result = convertTemplateText(target.value, wireMap);
    if (!result.ok) return result;
    if (result.text === target.value) continue;
    writeDotted(body, template.name, result.text);
    wireChanged = true;
  }
  if (wireChanged) {
    rawNode.wire = wireMap;
    markMutated(true);
  }

  return null;
}

interface ConvertTemplateOk {
  readonly ok: true;
  readonly text: string;
}

/** Walk a string, extract every legacy token, build wire entries, and
 *  replace tokens with `{{ localName }}` placeholders. Mutates `wireMap`
 *  in place (caller decides whether to assign it back). */
function convertTemplateText(
  text: string,
  wireMap: Record<string, unknown>,
): ConvertTemplateOk | MigrationErr {
  // Pass 1: $inputs.<key>. Reject nested paths + unknown catalog names.
  let working = text;
  let pass: ConvertTemplateOk | MigrationErr = { ok: true, text: working };

  pass = replaceAll(working, INPUTS_RE, (m) => {
    const key = m[1]!;
    const rest = m[2] ?? '';
    if (rest !== '') {
      return {
        ok: false,
        message: `cannot migrate "$inputs.${key}${rest}" — nested input paths have no typed-edge equivalent (catalog entries are primitives)`,
      };
    }
    if (!isCatalogName(key)) {
      return {
        ok: false,
        message: `cannot migrate "$inputs.${key}" — "${key}" is not a catalog entry (closed-world rule; authors cannot invent variable names)`,
      };
    }
    const localName = uniqueLocalName(key, wireMap);
    wireMap[localName] = `@trigger.${key}`;
    return { ok: true, replacement: `{{ ${localName} }}` };
  });
  if (!pass.ok) return pass;
  working = pass.text;

  // Pass 2: $ENV.<NAME>.
  pass = replaceAll(working, ENV_RE, (m) => {
    const name = m[1]!;
    const localName = uniqueLocalName(`env_${name}`, wireMap);
    wireMap[localName] = `@env.${name}`;
    return { ok: true, replacement: `{{ ${localName} }}` };
  });
  if (!pass.ok) return pass;
  working = pass.text;

  // Pass 3: $<nodeId>.output[.<field>]. Reject whole-output refs.
  pass = replaceAll(working, OUTPUT_RE, (m) => {
    const nodeId = m[1]!;
    const rest = m[2] ?? '';
    if (rest === '') {
      return {
        ok: false,
        message: `cannot migrate "$${nodeId}.output" (whole-output reference). Specify a field — e.g. "$${nodeId}.output.summary" — and add it to the node's output_schema where applicable.`,
      };
    }
    const segments = rest.slice(1).split('.');
    if (segments.length > 1) {
      return {
        ok: false,
        message: `cannot migrate "$${nodeId}.output${rest}" — nested output paths have no typed-edge equivalent (catalog entries are primitives)`,
      };
    }
    const field = segments[0]!;
    const localName = uniqueLocalName(`${nodeId}_${field}`, wireMap);
    wireMap[localName] = `@${nodeId}.${field}`;
    return { ok: true, replacement: `{{ ${localName} }}` };
  });
  if (!pass.ok) return pass;

  return { ok: true, text: pass.text };
}

interface ReplaceOk {
  readonly ok: true;
  readonly replacement: string;
}

function replaceAll(
  input: string,
  re: RegExp,
  fn: (m: RegExpExecArray) => ReplaceOk | MigrationErr,
): ConvertTemplateOk | MigrationErr {
  const localRe = new RegExp(re.source, re.flags); // fresh state
  let out = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = localRe.exec(input)) !== null) {
    const result = fn(match);
    if (!result.ok) return result;
    out += input.slice(lastIndex, match.index) + result.replacement;
    lastIndex = match.index + match[0].length;
  }
  out += input.slice(lastIndex);
  return { ok: true, text: out };
}

function uniqueLocalName(
  base: string,
  existing: Record<string, unknown>,
): string {
  if (!(base in existing)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`;
    if (!(candidate in existing)) return candidate;
  }
  throw new Error(`uniqueLocalName: exceeded 1000 attempts for base "${base}"`);
}

/** Convert a single-token whole-value field. Returns:
 *   - a new string (the compact `'@X.Y'` form) when a clean conversion
 *     applies,
 *   - null when the value isn't a single-token legacy ref (the migration
 *     leaves it alone),
 *   - a MigrationErr when the form is a legacy ref but can't be migrated
 *     (whole-output / non-catalog input). */
function convertSingleValueRef(value: string): string | null | MigrationErr {
  // Mixed strings (text with embedded refs) are NOT single-token — those go
  // through template-text migration only. Single-token migration only
  // applies when the whole string is one ref.
  const inputsMatch = SINGLE_INPUTS_RE.exec(value);
  if (inputsMatch) {
    const key = inputsMatch[1]!;
    if (!isCatalogName(key)) {
      return {
        ok: false,
        message: `cannot migrate "$inputs.${key}" — "${key}" is not a catalog entry (closed-world rule; authors cannot invent variable names)`,
      };
    }
    return `@trigger.${key}`;
  }
  const envMatch = SINGLE_ENV_RE.exec(value);
  if (envMatch) {
    return `@env.${envMatch[1]!}`;
  }
  const outMatch = SINGLE_OUTPUT_RE.exec(value);
  if (outMatch) {
    return `@${outMatch[1]!}.${outMatch[2]!}`;
  }
  const wholeOutMatch = SINGLE_OUTPUT_WHOLE_RE.exec(value);
  if (wholeOutMatch) {
    const nodeId = wholeOutMatch[1]!;
    return {
      ok: false,
      message: `cannot migrate "$${nodeId}.output" (whole-output reference). Specify a field — e.g. "$${nodeId}.output.summary" — and add it to the node's output_schema where applicable.`,
    };
  }
  return null;
}

/** Pick the kind discriminator the same way the typed parser does. */
function pickKind(raw: Record<string, unknown>): DagNode['kind'] | undefined {
  const fields: Array<DagNode['kind']> = [
    'subagent',
    'bash',
    'http',
    'script',
    'approval',
    'cancel',
    'workflow',
    'loop',
    'attach-to-work-item',
    'create-work-item',
    'update-work-item',
    'write-to-worktree',
    'orchestrator-review',
  ];
  const present: DagNode['kind'][] = [];
  for (const k of fields) {
    if (raw[k] !== undefined) present.push(k);
  }
  if (raw.agent !== undefined && !present.includes('subagent')) {
    present.push('subagent');
  }
  if (raw['human-review'] !== undefined && !present.includes('approval')) {
    present.push('approval');
  }
  return present.length === 1 ? present[0] : undefined;
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Read a dotted field path off an object. Returns `{ value: undefined }`
 *  when any segment doesn't exist. */
function readDotted(obj: Record<string, unknown>, dotted: string): { value: unknown } {
  const segments = dotted.split('.');
  let cur: unknown = obj;
  for (const seg of segments) {
    if (!isObj(cur)) return { value: undefined };
    cur = (cur as Record<string, unknown>)[seg];
  }
  return { value: cur };
}

/** Write a dotted field path on an object, creating intermediate objects
 *  as needed. */
function writeDotted(
  obj: Record<string, unknown>,
  dotted: string,
  value: unknown,
): void {
  const segments = dotted.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const next = cur[seg];
    if (!isObj(next)) {
      const fresh: Record<string, unknown> = {};
      cur[seg] = fresh;
      cur = fresh;
    } else {
      cur = next;
    }
  }
  cur[segments[segments.length - 1]!] = value;
}
