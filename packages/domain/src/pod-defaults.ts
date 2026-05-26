// Section 26 — per-pod default `expected_output` shapes.
//
// `pc_create_agent_work_item` auto-fills `expected_output` from this map when
// the caller specifies `pod` but no `expected_output`. The AC derivation rules
// then translate the spec into the predicate list. Authors of custom pods can
// override per dispatch.
//
// Stock-only for v1. User-customised pods that want defaults must pass
// `expected_output` explicitly until a default column lands on the agents row.
// Design rationale + the friction-gradient defaults live in
// docs/design/agent-outputs.md § "Pod-level defaults".

import type { ExpectedOutput } from './work-item-contract.ts';

const POD_DEFAULTS: Record<string, ExpectedOutput> = {
  // Returns findings as a text report; the orchestrator reads the summary
  // section to decide next steps.
  researcher: { kind: 'text', sections: ['summary'] },

  // Drafted prose; section-set is task-specific so the default is bare text.
  // The orchestrator overrides with `sections` per writer-variant brief.
  writer: { kind: 'text' },

  // Patched files live in the worktree; the summary + per-file paths
  // travel as the work-item report. File-path checks are task-specific (the
  // evaluator's `files_exist` predicate takes exact paths, not globs), so
  // we leave them off the default — orchestrator passes explicit paths when
  // it knows them.
  'code-writer': { kind: 'mixed', text: { sections: ['summary'] } },

  // Reviewer's job is a structured verdict — verdict pass/fail/revise, issues,
  // recommendations. Object types keep the shape open-ended without forcing
  // schema-by-schema field declarations.
  reviewer: {
    kind: 'structured',
    fields: { verdict: 'string', issues: 'object', recommendations: 'object' },
  },

  // Planner returns ordered concrete steps + a summary preamble.
  planner: { kind: 'text', sections: ['summary'] },

  // Extractor's job IS structured by definition; the orchestrator declares
  // the schema per dispatch. Default to a generic `extracted` object holding
  // whatever the per-dispatch schema produces.
  extractor: { kind: 'structured', fields: { extracted: 'object' } },

  // agent-designer holds a design conversation and uses pc_create_agent to
  // produce a pod. The "report" is the chat trail itself; no structured
  // contract is enforced for v1.
  'agent-designer': { kind: 'text' },

  // workflow-builder (Section 19.9) holds a design conversation and calls
  // pc_publish_workflow to produce a v2 workflow YAML. Same shape as
  // agent-designer — the "report" is the chat trail; the published workflow
  // is the deliverable.
  'workflow-builder': { kind: 'text' },

  // caisson (Section 36) is the in-app PC specialist — answers "how does X
  // work?" questions about Caisson and mutates config via curl.
  // Free-form Q&A or "done, here's what I changed" — no structured contract.
  caisson: { kind: 'text' },
};

/** Lookup a pod's default `expected_output`. Returns `undefined` for unknown
 *  pod names (including orchestrator — it's not dispatchable). */
export function getPodDefaultExpectedOutput(podName: string): ExpectedOutput | undefined {
  return POD_DEFAULTS[podName];
}

/** Test-friendly read-only view of the underlying map. */
export const POD_DEFAULT_EXPECTED_OUTPUT: Readonly<Record<string, ExpectedOutput>> = POD_DEFAULTS;
