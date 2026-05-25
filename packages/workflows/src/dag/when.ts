// Section 19.4 — `when:` condition evaluation. Pure, I/O-free.
//
// Lifted from Archon's condition-evaluator, parameterized by a RefResolver
// (refs.ts) so value resolution stays server-side. Grammar:
//   string eq:   $a.output == 'X'   / != 'X'
//   dot field:   $a.output.field == 'X'
//   numeric:     $a.output > '80'   / >= <= <   (both sides must parse finite)
//   compound:    A && B || C        (AND binds tighter than OR; no parens)
// Returns { result, parsed }. Unparseable → { result:false, parsed:false }
// (fail-closed: the executor SKIPS the node and surfaces a clear message).

import type { RefResolver } from './refs.ts';

/** Split on `sep`, but not inside single-quoted regions. */
function splitOutsideQuotes(expr: string, sep: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  let i = 0;
  while (i < expr.length) {
    if (expr[i] === "'") {
      inQuote = !inQuote;
      current += expr[i++];
    } else if (!inQuote && expr.startsWith(sep, i)) {
      parts.push(current.trim());
      current = '';
      i += sep.length;
    } else {
      current += expr[i++];
    }
  }
  parts.push(current.trim());
  return parts;
}

/** `$nodeId.output[.field] OP 'value'` */
const ATOM_PATTERN =
  /^\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?\s*(==|!=|<=|>=|<|>)\s*'([^']*)'$/;

function evaluateAtom(expr: string, resolve: RefResolver): { result: boolean; parsed: boolean } {
  const match = ATOM_PATTERN.exec(expr.trim());
  if (!match) return { result: false, parsed: false };

  const [, nodeId, field, operator, expected] = match;
  if (nodeId === undefined || operator === undefined || expected === undefined) {
    return { result: false, parsed: false };
  }

  const actual = resolve(nodeId, field) ?? '';

  if (operator === '==' || operator === '!=') {
    return { result: operator === '==' ? actual === expected : actual !== expected, parsed: true };
  }

  const a = Number.parseFloat(actual);
  const b = Number.parseFloat(expected);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { result: false, parsed: false };
  let result: boolean;
  if (operator === '<') result = a < b;
  else if (operator === '>') result = a > b;
  else if (operator === '<=') result = a <= b;
  else result = a >= b; // '>='
  return { result, parsed: true };
}

/**
 * Evaluate a (possibly compound) `when:` expression. `result` = run the node;
 * `parsed` = false when any atom failed to parse (fail-closed).
 */
export function evaluateCondition(
  expr: string,
  resolve: RefResolver
): { result: boolean; parsed: boolean } {
  const orClauses = splitOutsideQuotes(expr.trim(), '||');

  for (const orClause of orClauses) {
    const andAtoms = splitOutsideQuotes(orClause, '&&');
    let andResult = true;
    for (const atom of andAtoms) {
      const { result, parsed } = evaluateAtom(atom, resolve);
      if (!parsed) return { result: false, parsed: false };
      if (!result) {
        andResult = false;
        break; // short-circuit AND
      }
    }
    if (andResult) return { result: true, parsed: true }; // short-circuit OR
  }
  return { result: false, parsed: true };
}

/** Join-rule evaluation: given a node's forward-predecessors' terminal states,
 *  decide run vs skip. Mirrors Archon's checkTriggerRule. */
export function checkTriggerRule(
  rule: 'all_success' | 'one_success' | 'all_done' | 'none_failed_min_one_success' | undefined,
  upstreamStates: readonly ('completed' | 'failed' | 'skipped' | 'pending' | 'running')[]
): 'run' | 'skip' {
  if (upstreamStates.length === 0) return 'run';
  const effective = rule ?? 'all_success';
  switch (effective) {
    case 'all_success':
      return upstreamStates.every((s) => s === 'completed') ? 'run' : 'skip';
    case 'one_success':
      return upstreamStates.some((s) => s === 'completed') ? 'run' : 'skip';
    case 'none_failed_min_one_success':
      return !upstreamStates.some((s) => s === 'failed') && upstreamStates.some((s) => s === 'completed')
        ? 'run'
        : 'skip';
    case 'all_done':
      return upstreamStates.every((s) => s !== 'pending' && s !== 'running') ? 'run' : 'skip';
  }
}
