// Section 19.6 — save-time / fire-time workflow graph validator. Pure, I/O-free.
// Composes findForwardCycle (topo.ts) + evaluateCondition's grammar check
// (when.ts). PC improvement over Archon: cycle detection at LOAD, `when:`
// validated at save (not discovered at runtime). Collects ALL errors (not
// first-only) so the builder / orchestrator can surface every problem at once.
//
// Input may be untyped JSON straight off the wire (the /fire route casts), so
// every field read is defensive — never assume the discriminated union holds.

import type { WorkflowV2 } from '@pc/domain';
import { findForwardCycle } from './topo.ts';
import { evaluateCondition } from './when.ts';
import type { RefResolver } from './refs.ts';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const NODE_KINDS = new Set(['agent', 'bash', 'script', 'human-review', 'orchestrator-review', 'move-work-item']);
const TRIGGER_KINDS = new Set(['manual', 'stage-on-entry', 'schedule', 'event']);
const SCRIPT_RUNTIMES = new Set(['node', 'python']);
const REVIEW_KINDS = new Set(['human-review', 'orchestrator-review']);

/** Grammar-only probe for `when:`. A resolver returning '0' lets every
 *  well-formed atom parse (string-eq AND numeric), so `parsed: false` means the
 *  expression is genuinely malformed — not merely that a value was absent. */
const GRAMMAR_PROBE: RefResolver = () => '0';

/**
 * Validate a v2 workflow graph. Checks (in order): shell shape · unique node
 * ids · known kinds + per-kind required fields · ref integrity (next /
 * reject.back_to / bundle_from point to real nodes) · forward-edge acyclicity ·
 * `when:` grammar · trigger shape. Returns every error found.
 */
export function validateWorkflowV2(workflow: WorkflowV2.Workflow): ValidationResult {
  const errors: string[] = [];
  const wf = workflow as unknown as {
    name?: unknown;
    nodes?: unknown;
    triggers?: unknown;
  };

  if (typeof wf.name !== 'string' || wf.name.trim() === '') errors.push('workflow.name is required');

  const nodes = (Array.isArray(wf.nodes) ? wf.nodes : []) as Record<string, unknown>[];
  if (nodes.length === 0) errors.push('workflow must have at least one node');

  // ── node ids + kinds + per-kind required fields ──
  const ids = new Set<string>();
  for (const n of nodes) {
    const id = typeof n.id === 'string' ? n.id : '';
    if (!id) {
      errors.push('every node needs a non-empty string id');
      continue;
    }
    if (ids.has(id)) errors.push(`duplicate node id "${id}"`);
    if (id === 'root') errors.push(`node id "root" is reserved`);
    ids.add(id);

    const kind = n.kind as string;
    if (!NODE_KINDS.has(kind)) {
      errors.push(`node "${id}": unknown kind "${String(kind)}"`);
      continue;
    }
    if (kind === 'agent' && (typeof n.agent !== 'string' || n.agent === ''))
      errors.push(`agent node "${id}": missing "agent" (pod name)`);
    if (kind === 'agent' && (typeof n.task !== 'string' || n.task === ''))
      errors.push(`agent node "${id}": missing "task"`);
    if (kind === 'bash' && (typeof n.bash !== 'string' || n.bash === ''))
      errors.push(`bash node "${id}": missing "bash" command`);
    if (kind === 'script') {
      if (typeof n.script !== 'string' || n.script === '') errors.push(`script node "${id}": missing "script" body`);
      if (!SCRIPT_RUNTIMES.has(n.runtime as string))
        errors.push(`script node "${id}": runtime must be "node" or "python"`);
    }
    if (kind === 'move-work-item' && (typeof n.to_stage !== 'string' || n.to_stage === ''))
      errors.push(`move-work-item node "${id}": missing "to_stage"`);
  }

  // ── ref integrity ──
  const known = (id: unknown): boolean => typeof id === 'string' && ids.has(id);
  for (const n of nodes) {
    const id = (n.id as string) || '?';
    for (const nx of Array.isArray(n.next) ? n.next : []) {
      if (!known(nx)) errors.push(`node "${id}": next → unknown node "${String(nx)}"`);
    }
    if (REVIEW_KINDS.has(n.kind as string)) {
      const reject = n.reject as { back_to?: unknown } | undefined;
      if (reject && !known(reject.back_to))
        errors.push(`review node "${id}": reject.back_to → unknown node "${String(reject.back_to)}"`);
      for (const b of Array.isArray(n.bundle_from) ? n.bundle_from : []) {
        if (!known(b)) errors.push(`review node "${id}": bundle_from → unknown node "${String(b)}"`);
      }
    }
  }

  // ── forward-edge acyclicity (reject back-edges are excluded by forwardEdges) ──
  const cycle = findForwardCycle(nodes as unknown as WorkflowV2.WorkflowNode[]);
  if (cycle) errors.push(`cycle in forward edges: ${cycle.join(' → ')}`);

  // ── when: grammar ──
  for (const n of nodes) {
    if (typeof n.when === 'string' && n.when.trim() !== '') {
      const { parsed } = evaluateCondition(n.when, GRAMMAR_PROBE);
      if (!parsed) errors.push(`node "${(n.id as string) || '?'}": when "${n.when}" failed to parse`);
    }
  }

  // ── triggers ──
  const triggers = (Array.isArray(wf.triggers) ? wf.triggers : []) as Record<string, unknown>[];
  if (triggers.length === 0) errors.push('workflow needs at least one trigger');
  for (const t of triggers) {
    const kind = t.kind as string;
    if (!TRIGGER_KINDS.has(kind)) {
      errors.push(`unknown trigger kind "${String(kind)}"`);
      continue;
    }
    if (kind === 'stage-on-entry' && (typeof t.stage !== 'string' || t.stage === ''))
      errors.push('stage-on-entry trigger: missing "stage"');
    if (kind === 'schedule' && (typeof t.cron !== 'string' || t.cron === ''))
      errors.push('schedule trigger: missing "cron"');
    if (kind === 'event' && (typeof t.source !== 'string' || t.source === ''))
      errors.push('event trigger: missing "source"');
  }

  return { ok: errors.length === 0, errors };
}
