// Output substitution + expression evaluator (Slice 9 M6).
//
// Two pure functions plugged into the WorkflowRuntime via constructor options:
//
//   substituteOutputs(text, run): string
//     Replaces every `$<node-id>.output[.path]` and `$inputs.<key>[.path]`
//     token in `text` with the value resolved from `run`. Outputs read from
//     run.nodeOutputs[id].output; inputs read from run.inputs[key]. Strings
//     are inlined verbatim; numbers/booleans use String(); arrays/objects
//     are JSON.stringify'd. Missing values resolve to the empty string.
//
//   evaluateBoolean(expression, run): boolean
//     Evaluates a tiny JS-ish expression. Grammar:
//       expr    : or
//       or      : and ( '||' and )*
//       and     : equality ( '&&' equality )*
//       equality: comparison ( ('==' | '!=') comparison )*
//       compare : unary ( ('<' | '>' | '<=' | '>=') unary )*
//       unary   : '!' unary | primary
//       primary : NUMBER | STRING | true | false | null | VAR | '(' expr ')'
//       VAR     : '$' IDENT ( '.' IDENT )*
//
//     `==` and `!=` are STRICT (`===` / `!==`) — predictable beats JS-loose
//     for workflow authors. Comparison ops coerce to number via Number(); NaN
//     comparisons return false. Missing variables resolve to undefined; a top-
//     level coercion turns the final result into boolean (truthy / falsy per
//     JS rules; empty arrays + empty objects are falsy too).
//
// Errors (bad token, unterminated string, mismatched parens, etc.) throw —
// the caller decides how to surface them. The scheduler in M5 lets them
// bubble; a future M4 add-on may pre-validate expression syntax at YAML load
// time so the runtime never sees a broken expression in flight.

import type { WorkflowRun } from '@pc/domain';

// Inputs token must precede outputs in the alternation so `$inputs.foo`
// doesn't get mis-tokenized as `$inputs` followed by `.foo` (it can't, since
// outputs require literal `.output`, but the explicit ordering documents intent).
const INPUTS_TOKEN = /\$inputs\.([a-zA-Z_][a-zA-Z0-9_]*)((?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)/g;
const OUTPUT_TOKEN = /\$([a-zA-Z][a-zA-Z0-9_-]*)\.output((?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)/g;

export function substituteOutputs(text: string, run: WorkflowRun): string {
  // Resolve $inputs.* first so a workflow author can't accidentally name a
  // step `inputs` and have its `.output` collide with the inputs grammar.
  const afterInputs = text.replace(INPUTS_TOKEN, (_match, key: string, path: string) => {
    const value = resolveInputPath(run, key, path);
    return stringifyValue(value);
  });
  return afterInputs.replace(OUTPUT_TOKEN, (_match, id: string, path: string) => {
    const value = resolveOutputPath(run, id, path);
    return stringifyValue(value);
  });
}

function resolveOutputPath(run: WorkflowRun, id: string, dottedPath: string): unknown {
  const nodeOut = run.nodeOutputs[id];
  if (!nodeOut) return undefined;
  let cur: unknown = nodeOut.output;
  return walkPath(cur, dottedPath);
}

function resolveInputPath(run: WorkflowRun, key: string, dottedPath: string): unknown {
  const inputs = run.inputs;
  if (!inputs || !(key in inputs)) return undefined;
  return walkPath(inputs[key], dottedPath);
}

function walkPath(root: unknown, dottedPath: string): unknown {
  if (!dottedPath) return root;
  let cur = root;
  const segments = dottedPath.slice(1).split('.');
  for (const seg of segments) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function stringifyValue(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ── Expression evaluator ────────────────────────────────────────────────────

export function evaluateBoolean(expression: string, run: WorkflowRun): boolean {
  const tokens = tokenize(expression);
  const parser = new Parser(tokens, expression);
  const ast = parser.parseExpr();
  parser.expectEnd();
  return coerceBoolean(evalAst(ast, run));
}

type ComparisonOp = '<' | '>' | '<=' | '>=';
type EqualityOp = '==' | '!=';
type LogicalOp = '&&' | '||';
type UnaryOp = '!';
type OpValue = ComparisonOp | EqualityOp | LogicalOp | UnaryOp;

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'var'; path: string[] }
  | { kind: 'op'; value: OpValue }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'end' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { tokens.push({ kind: 'lparen' }); i++; continue; }
    if (c === ')') { tokens.push({ kind: 'rparen' }); i++; continue; }

    if (c === '$') {
      const re = /\$([a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)/y;
      re.lastIndex = i;
      const match = re.exec(input);
      if (!match) throw new Error(`expression: bad variable at offset ${i}: "${input}"`);
      tokens.push({ kind: 'var', path: match[1]!.split('.') });
      i += match[0].length;
      continue;
    }

    if (c === '"' || c === "'") {
      const quote = c;
      let end = i + 1;
      while (end < input.length && input[end] !== quote) {
        if (input[end] === '\\') end++;
        end++;
      }
      if (end >= input.length) {
        throw new Error(`expression: unterminated string starting at offset ${i}`);
      }
      const raw = input.slice(i + 1, end).replace(/\\(.)/g, '$1');
      tokens.push({ kind: 'string', value: raw });
      i = end + 1;
      continue;
    }

    if (/[0-9]/.test(c)) {
      const re = /[0-9]+(\.[0-9]+)?/y;
      re.lastIndex = i;
      const match = re.exec(input);
      if (!match) throw new Error(`expression: bad number at offset ${i}`);
      tokens.push({ kind: 'number', value: Number(match[0]) });
      i += match[0].length;
      continue;
    }

    // Two-char operators
    const two = input.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '&&' || two === '||') {
      tokens.push({ kind: 'op', value: two });
      i += 2;
      continue;
    }
    // Single-char operators
    if (c === '<' || c === '>' || c === '!') {
      tokens.push({ kind: 'op', value: c });
      i++;
      continue;
    }

    // Keywords (true / false / null). Bare identifiers are disallowed —
    // every variable must be prefixed with `$`.
    const word = /[a-zA-Z_][a-zA-Z0-9_]*/y;
    word.lastIndex = i;
    const wm = word.exec(input);
    if (wm) {
      const w = wm[0];
      if (w === 'true') tokens.push({ kind: 'bool', value: true });
      else if (w === 'false') tokens.push({ kind: 'bool', value: false });
      else if (w === 'null') tokens.push({ kind: 'null' });
      else {
        throw new Error(
          `expression: unexpected identifier "${w}" at offset ${i}; variables must be prefixed with "$"`,
        );
      }
      i += w.length;
      continue;
    }

    throw new Error(`expression: unexpected character "${c}" at offset ${i}: "${input}"`);
  }
  tokens.push({ kind: 'end' });
  return tokens;
}

type Ast =
  | { type: 'literal'; value: unknown }
  | { type: 'var'; path: string[] }
  | { type: 'binary'; op: ComparisonOp | EqualityOp | LogicalOp; left: Ast; right: Ast }
  | { type: 'unary'; op: UnaryOp; arg: Ast };

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[], private readonly source: string) {}

  parseExpr(): Ast { return this.parseOr(); }

  expectEnd(): void {
    if (this.peek().kind !== 'end') {
      throw new Error(`expression: trailing content at position ${this.pos} in "${this.source}"`);
    }
  }

  private parseOr(): Ast {
    let left = this.parseAnd();
    while (this.matchOp('||')) left = { type: 'binary', op: '||', left, right: this.parseAnd() };
    return left;
  }

  private parseAnd(): Ast {
    let left = this.parseEquality();
    while (this.matchOp('&&')) left = { type: 'binary', op: '&&', left, right: this.parseEquality() };
    return left;
  }

  private parseEquality(): Ast {
    let left = this.parseComparison();
    let op: EqualityOp | undefined;
    while ((op = this.matchAny(['==', '!=']) as EqualityOp | undefined)) {
      left = { type: 'binary', op, left, right: this.parseComparison() };
    }
    return left;
  }

  private parseComparison(): Ast {
    let left = this.parseUnary();
    let op: ComparisonOp | undefined;
    while ((op = this.matchAny(['<=', '>=', '<', '>']) as ComparisonOp | undefined)) {
      left = { type: 'binary', op, left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): Ast {
    if (this.matchOp('!')) return { type: 'unary', op: '!', arg: this.parseUnary() };
    return this.parsePrimary();
  }

  private parsePrimary(): Ast {
    const t = this.peek();
    if (t.kind === 'lparen') {
      this.pos++;
      const inner = this.parseExpr();
      if (this.peek().kind !== 'rparen') {
        throw new Error(`expression: expected ) at position ${this.pos} in "${this.source}"`);
      }
      this.pos++;
      return inner;
    }
    if (t.kind === 'number' || t.kind === 'string' || t.kind === 'bool') {
      this.pos++;
      return { type: 'literal', value: t.value };
    }
    if (t.kind === 'null') {
      this.pos++;
      return { type: 'literal', value: null };
    }
    if (t.kind === 'var') {
      this.pos++;
      return { type: 'var', path: t.path };
    }
    throw new Error(`expression: unexpected token at position ${this.pos} in "${this.source}"`);
  }

  private peek(): Token { return this.tokens[this.pos]!; }

  private matchOp(op: OpValue): boolean {
    const t = this.peek();
    if (t.kind === 'op' && t.value === op) { this.pos++; return true; }
    return false;
  }

  private matchAny(ops: OpValue[]): OpValue | undefined {
    const t = this.peek();
    if (t.kind === 'op' && ops.includes(t.value)) { this.pos++; return t.value; }
    return undefined;
  }
}

function evalAst(ast: Ast, run: WorkflowRun): unknown {
  switch (ast.type) {
    case 'literal':
      return ast.value;
    case 'var': {
      const [head, ...rest] = ast.path;
      let cur: unknown;
      if (head === 'inputs') {
        // `$inputs.<key>[.path]` — resolve through run.inputs. The first
        // remaining segment is the input key; subsequent segments walk the
        // value's object graph.
        const [key, ...deeper] = rest;
        if (!key) return undefined;
        const inputs = run.inputs;
        if (!inputs || !(key in inputs)) return undefined;
        cur = inputs[key];
        for (const s of deeper) {
          if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
          cur = (cur as Record<string, unknown>)[s];
        }
        return cur;
      }
      cur = run.nodeOutputs[head!];
      for (const s of rest) {
        if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[s];
      }
      return cur;
    }
    case 'unary':
      return !coerceBoolean(evalAst(ast.arg, run));
    case 'binary': {
      if (ast.op === '&&') {
        return coerceBoolean(evalAst(ast.left, run)) && coerceBoolean(evalAst(ast.right, run));
      }
      if (ast.op === '||') {
        return coerceBoolean(evalAst(ast.left, run)) || coerceBoolean(evalAst(ast.right, run));
      }
      const left = evalAst(ast.left, run);
      const right = evalAst(ast.right, run);
      if (ast.op === '==') return left === right;
      if (ast.op === '!=') return left !== right;
      const ln = numberize(left);
      const rn = numberize(right);
      if (Number.isNaN(ln) || Number.isNaN(rn)) return false;
      if (ast.op === '<') return ln < rn;
      if (ast.op === '>') return ln > rn;
      if (ast.op === '<=') return ln <= rn;
      if (ast.op === '>=') return ln >= rn;
      return false;
    }
  }
}

function numberize(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return NaN;
}

function coerceBoolean(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return false;
}
