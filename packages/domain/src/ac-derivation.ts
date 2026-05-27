// Section 26 — derive the tier-1 acceptance-criteria predicate set from the
// orchestrator's `expected_output` spec. Pure function; no IO, no runtime
// deps. Reusable across MCP, future workflow-runtime node-evaluation, and
// the (future) UI editor.
//
// Derivation rules (locked at design time — the agent output contract
// § "AC derivation rules"):
//
//   text         → body_contains per section + min-chars regex if specified
//   files        → files_exist for every declared path
//   structured   → fields_populated for the declared field keys
//   side-effect  → bash_exit_zero if verify_via_bash was provided; else []
//   mixed        → union of the constituent derivations
//
// An empty result is legal — it means "trust the agent's end-of-turn signal"
// (tier-1 verification effectively passes by default). The orchestrator can
// always opt in to a stricter tier per dispatch.

import type {
  AcceptanceCriteria,
  AcceptancePredicate,
  ExpectedOutput,
} from './work-item-contract.ts';

export function deriveAcceptanceCriteria(spec: ExpectedOutput): AcceptanceCriteria {
  switch (spec.kind) {
    case 'text':
      return deriveText(spec);
    case 'files':
      return deriveFiles(spec);
    case 'structured':
      return deriveStructured(spec);
    case 'side-effect':
      return deriveSideEffect(spec);
    case 'mixed':
      return deriveMixed(spec);
  }
}

function deriveText(
  spec: Extract<ExpectedOutput, { kind: 'text' }>,
): AcceptancePredicate[] {
  const preds: AcceptancePredicate[] = [];
  if (spec.sections) {
    for (const section of spec.sections) {
      // Section name appears verbatim in the body. Authors typically render
      // them as markdown headers (`## Summary`); the bare-substring check
      // works either way.
      preds.push({ kind: 'body_contains', pattern: section });
    }
  }
  if (typeof spec.min_chars === 'number' && spec.min_chars > 0) {
    // Regex: any sequence of at least N chars (including whitespace + newlines).
    preds.push({
      kind: 'body_contains',
      pattern: `^[\\s\\S]{${spec.min_chars},}$`,
      regex: true,
    });
  }
  return preds;
}

function deriveFiles(
  spec: Extract<ExpectedOutput, { kind: 'files' }>,
): AcceptancePredicate[] {
  if (spec.paths.length === 0) return [];
  const pred: AcceptancePredicate = { kind: 'files_exist', paths: spec.paths };
  if (typeof spec.min_size_bytes === 'number') {
    pred.min_size_bytes = spec.min_size_bytes;
  }
  return [pred];
}

function deriveStructured(
  spec: Extract<ExpectedOutput, { kind: 'structured' }>,
): AcceptancePredicate[] {
  const keys = Object.keys(spec.fields);
  if (keys.length === 0) return [];
  return [{ kind: 'fields_populated', keys }];
}

function deriveSideEffect(
  spec: Extract<ExpectedOutput, { kind: 'side-effect' }>,
): AcceptancePredicate[] {
  if (!spec.verify_via_bash) return [];
  return [{ kind: 'bash_exit_zero', command: spec.verify_via_bash, cwd: 'worktree' }];
}

function deriveMixed(
  spec: Extract<ExpectedOutput, { kind: 'mixed' }>,
): AcceptancePredicate[] {
  const preds: AcceptancePredicate[] = [];
  if (spec.text) {
    preds.push(...deriveText({ kind: 'text', ...spec.text }));
  }
  if (spec.files) {
    preds.push(...deriveFiles({ kind: 'files', ...spec.files }));
  }
  if (spec.structured) {
    preds.push(...deriveStructured({ kind: 'structured', ...spec.structured }));
  }
  if (spec.side_effect) {
    preds.push(...deriveSideEffect({ kind: 'side-effect', ...spec.side_effect }));
  }
  return preds;
}
