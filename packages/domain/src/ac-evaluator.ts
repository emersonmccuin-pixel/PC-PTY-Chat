// Section 26 — tier-1 acceptance-criteria evaluator. Walks an
// `AcceptanceCriteria` predicate list and reports pass/fail per predicate.
//
// The pure predicates (fields_populated, field_matches, body_contains,
// attachments_present, child_work_items_done) are evaluated against the
// in-memory `EvaluationContext`. The two side-effecting predicates
// (files_exist, bash_exit_zero) consult the caller-supplied
// `PredicateExecutors` — this keeps `@pc/domain` free of `node:fs` /
// `child_process` so the library remains zero-dep + browser-loadable.

import type {
  AcceptanceCriteria,
  AcceptancePredicate,
  AcceptancePredicateKind,
} from './work-item-contract.ts';
import type { WorkItemStatus } from './work-item.ts';

export interface EvaluationContext {
  body: string;
  fields: Record<string, unknown>;
  /** Attachments on the work item. `content` is optional because some callers
   *  (e.g. UI previews) may not carry the full payload; when omitted,
   *  attachment content is simply absent from `body_contains` searches. */
  attachments: ReadonlyArray<{ name: string; content?: string }>;
  childWorkItems: ReadonlyArray<{ status: WorkItemStatus }>;
}

export interface PredicateExecutors {
  /** Resolves the size of a worktree-relative path in bytes, or null if the
   *  path doesn't exist (or isn't a regular file). */
  fileSize: (relativePath: string) => Promise<number | null>;
  /** Runs the bash command in either the worktree or the project root and
   *  resolves the process exit code. */
  runBash: (command: string, cwd: 'worktree' | 'project') => Promise<number>;
}

export interface PredicateFailure {
  kind: AcceptancePredicateKind;
  reason: string;
}

export interface EvaluationResult {
  pass: boolean;
  failures: PredicateFailure[];
}

export async function evaluateAcceptance(
  criteria: AcceptanceCriteria,
  ctx: EvaluationContext,
  executors: PredicateExecutors,
): Promise<EvaluationResult> {
  const failures: PredicateFailure[] = [];
  for (const pred of criteria) {
    const res = await evaluatePredicate(pred, ctx, executors);
    if (!res.pass) {
      failures.push({ kind: pred.kind, reason: res.reason ?? 'predicate failed' });
    }
  }
  return { pass: failures.length === 0, failures };
}

export async function evaluatePredicate(
  pred: AcceptancePredicate,
  ctx: EvaluationContext,
  executors: PredicateExecutors,
): Promise<{ pass: boolean; reason?: string }> {
  switch (pred.kind) {
    case 'fields_populated':
      return evalFieldsPopulated(pred, ctx);
    case 'field_matches':
      return evalFieldMatches(pred, ctx);
    case 'body_contains':
      return evalBodyContains(pred, ctx);
    case 'attachments_present':
      return evalAttachmentsPresent(pred, ctx);
    case 'child_work_items_done':
      return evalChildrenDone(pred, ctx);
    case 'files_exist':
      return await evalFilesExist(pred, executors);
    case 'bash_exit_zero':
      return await evalBashExitZero(pred, executors);
  }
}

// ── Pure predicates ────────────────────────────────────────────────────────

function evalFieldsPopulated(
  pred: Extract<AcceptancePredicate, { kind: 'fields_populated' }>,
  ctx: EvaluationContext,
): { pass: boolean; reason?: string } {
  const missing: string[] = [];
  for (const key of pred.keys) {
    if (!isPopulated(ctx.fields[key])) missing.push(key);
  }
  if (missing.length === 0) return { pass: true };
  return { pass: false, reason: `missing or empty field(s): ${missing.join(', ')}` };
}

/** Mirrors the workflow runtime's done_when semantics: nullish, '', [], {}
 *  reject; `0` and `false` pass. */
function isPopulated(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

function evalFieldMatches(
  pred: Extract<AcceptancePredicate, { kind: 'field_matches' }>,
  ctx: EvaluationContext,
): { pass: boolean; reason?: string } {
  const raw = ctx.fields[pred.key];
  if (raw === undefined || raw === null) {
    return { pass: false, reason: `field ${pred.key} is missing` };
  }
  const value = String(raw);
  let re: RegExp;
  try {
    re = new RegExp(pred.pattern);
  } catch (err) {
    return {
      pass: false,
      reason: `invalid regex for field ${pred.key}: ${(err as Error).message}`,
    };
  }
  if (re.test(value)) return { pass: true };
  return { pass: false, reason: `field ${pred.key} does not match /${pred.pattern}/` };
}

function evalBodyContains(
  pred: Extract<AcceptancePredicate, { kind: 'body_contains' }>,
  ctx: EvaluationContext,
): { pass: boolean; reason?: string } {
  // Section 26 carry-over #2 (Option A) — `body_contains` searches both the
  // work-item body AND attachment contents. Agents commonly persist
  // non-trivial deliverables as attachments (researcher attaches
  // `findings.md`); requiring the predicate to match only `body` forced
  // duplicate writes. The pure substring/regex semantics are preserved; the
  // search corpus is just wider. Attachments with no `content` (UI previews
  // that didn't load the payload) are skipped.
  const corpus = collectSearchCorpus(ctx);
  if (pred.regex) {
    let re: RegExp;
    try {
      re = new RegExp(pred.pattern);
    } catch (err) {
      return { pass: false, reason: `invalid regex: ${(err as Error).message}` };
    }
    if (re.test(corpus)) return { pass: true };
    return { pass: false, reason: `body or attachments do not match /${pred.pattern}/` };
  }
  if (corpus.includes(pred.pattern)) return { pass: true };
  return {
    pass: false,
    reason: `body or attachments do not contain "${pred.pattern}"`,
  };
}

/** Concatenates the work-item body + every attachment's content into a single
 *  string for `body_contains` searches. Attachments are separated by a marker
 *  so a pattern doesn't accidentally match across a body/attachment seam.
 *  Attachments with no `content` are skipped (treat as empty). */
function collectSearchCorpus(ctx: EvaluationContext): string {
  const parts: string[] = [ctx.body];
  for (const a of ctx.attachments) {
    if (typeof a.content === 'string' && a.content.length > 0) {
      parts.push(`\n--- attachment: ${a.name} ---\n${a.content}`);
    }
  }
  return parts.join('');
}

function evalAttachmentsPresent(
  pred: Extract<AcceptancePredicate, { kind: 'attachments_present' }>,
  ctx: EvaluationContext,
): { pass: boolean; reason?: string } {
  const have = new Set(ctx.attachments.map((a) => a.name));
  const missing = pred.names.filter((n) => !have.has(n));
  if (missing.length === 0) return { pass: true };
  return { pass: false, reason: `missing attachment(s): ${missing.join(', ')}` };
}

function evalChildrenDone(
  pred: Extract<AcceptancePredicate, { kind: 'child_work_items_done' }>,
  ctx: EvaluationContext,
): { pass: boolean; reason?: string } {
  const total = ctx.childWorkItems.length;
  const done = ctx.childWorkItems.filter((c) => c.status === 'complete').length;
  if (pred.all !== false) {
    // `all` defaults to true when both flags omitted; explicit false flips the
    // semantics to "count satisfies if >= pred.count".
    if (total === 0) {
      return { pass: false, reason: 'no child work items present' };
    }
    if (done === total) return { pass: true };
    return { pass: false, reason: `${done}/${total} child work items complete` };
  }
  const need = pred.count ?? 0;
  if (done >= need) return { pass: true };
  return {
    pass: false,
    reason: `${done}/${total} children complete (need at least ${need})`,
  };
}

// ── Side-effecting predicates ──────────────────────────────────────────────

async function evalFilesExist(
  pred: Extract<AcceptancePredicate, { kind: 'files_exist' }>,
  executors: PredicateExecutors,
): Promise<{ pass: boolean; reason?: string }> {
  const min = pred.min_size_bytes ?? 1;
  const failures: string[] = [];
  for (const path of pred.paths) {
    const size = await executors.fileSize(path);
    if (size === null) {
      failures.push(`${path} (missing)`);
    } else if (size < min) {
      failures.push(`${path} (${size}b < min ${min}b)`);
    }
  }
  if (failures.length === 0) return { pass: true };
  return { pass: false, reason: failures.join('; ') };
}

async function evalBashExitZero(
  pred: Extract<AcceptancePredicate, { kind: 'bash_exit_zero' }>,
  executors: PredicateExecutors,
): Promise<{ pass: boolean; reason?: string }> {
  const cwd = pred.cwd ?? 'worktree';
  const exitCode = await executors.runBash(pred.command, cwd);
  if (exitCode === 0) return { pass: true };
  return {
    pass: false,
    reason: `bash command exited ${exitCode}: ${pred.command}`,
  };
}
