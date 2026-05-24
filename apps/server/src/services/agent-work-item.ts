// Section 26.3 — Service helper for `pc_create_agent_work_item`.
//
// Resolves the pod's default `expected_output` if the caller didn't override,
// derives the tier-1 AC predicate list from `expected_output`, applies the
// raw-AC escape hatch if supplied, and persists via `WorkItemService.create`.
// Stage defaults to the project's first stage when the caller omits one — the
// kanban hides agent work items by default anyway (Section 26.7), so stage
// choice is mostly bookkeeping at v1.
//
// Validation is loud: malformed `expected_output` / `raw_acceptance_criteria`
// throw `AgentWorkItemInputError` so the route can map to HTTP 400 with a clean
// message. The pod-name lookup is a hard requirement — passing a name the
// project can't dispatch returns 400 (orchestrator chose wrong), NOT silently
// no-default falling through.

import type {
  AcceptancePredicate,
  ExpectedOutput,
  Project,
  ULID,
  VerificationTier,
  WorkItem,
} from '@pc/domain';
import {
  ACCEPTANCE_PREDICATE_KINDS,
  EXPECTED_OUTPUT_KINDS,
  VERIFICATION_TIERS,
  deriveAcceptanceCriteria,
  getPodDefaultExpectedOutput,
} from '@pc/domain';
import type { WorkItemService } from './work-item.ts';

export interface CreateAgentWorkItemInput {
  title: string;
  task: string;
  pod: string;
  expectedOutput?: ExpectedOutput;
  verificationTier?: VerificationTier;
  parentWorkItemId?: ULID | null;
  stageId?: string;
  worktree?: string | null;
  ephemeral?: boolean;
  /** Override the derived AC entirely. Audit-logged inside the work-item
   *  history at create time so downstream tooling can spot raw-AC patterns. */
  rawAcceptanceCriteria?: AcceptancePredicate[];
}

export interface CreateAgentWorkItemDeps {
  workItemService: WorkItemService;
  getProject: () => Project;
}

export class AgentWorkItemInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentWorkItemInputError';
  }
}

/** Apply the work-item-as-contract creation rules and persist. Returns the
 *  newly-created `WorkItem` with all contract fields populated. */
export function createAgentWorkItem(
  input: CreateAgentWorkItemInput,
  deps: CreateAgentWorkItemDeps,
): WorkItem {
  const title = input.title?.trim() ?? '';
  if (!title) throw new AgentWorkItemInputError('title required');
  const task = input.task?.trim() ?? '';
  if (!task) throw new AgentWorkItemInputError('task required');
  const pod = input.pod?.trim() ?? '';
  if (!pod) throw new AgentWorkItemInputError('pod required');

  // Verification tier validation — default 'auto'.
  const tier: VerificationTier = input.verificationTier ?? 'auto';
  if (!VERIFICATION_TIERS.includes(tier)) {
    throw new AgentWorkItemInputError(
      `verification_tier must be one of: ${VERIFICATION_TIERS.join(', ')}`,
    );
  }

  // Resolve expected_output: caller-supplied wins; otherwise pod default;
  // otherwise hard-fail (the orchestrator must specify SOMETHING).
  let expectedOutput: ExpectedOutput | null;
  if (input.expectedOutput !== undefined) {
    assertExpectedOutputShape(input.expectedOutput);
    expectedOutput = input.expectedOutput;
  } else {
    const def = getPodDefaultExpectedOutput(pod);
    expectedOutput = def ?? null;
  }
  if (expectedOutput === null) {
    throw new AgentWorkItemInputError(
      `pod "${pod}" has no default expected_output — pass expected_output explicitly`,
    );
  }

  // Derive AC, then apply raw override if supplied.
  let acceptanceCriteria = deriveAcceptanceCriteria(expectedOutput);
  if (input.rawAcceptanceCriteria !== undefined) {
    assertAcceptanceCriteriaShape(input.rawAcceptanceCriteria);
    acceptanceCriteria = input.rawAcceptanceCriteria;
  }

  // Stage: caller-supplied or fall back to the project's first stage. Throws
  // a generic `unknown stage` from the service layer if invalid.
  const project = deps.getProject();
  const stages = (project.stages ?? []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const stageId = input.stageId?.trim() || stages[0]?.id;
  if (!stageId) {
    throw new AgentWorkItemInputError(
      `project has no stages — agent work item needs a stage to land in`,
    );
  }

  const ephemeral = input.ephemeral === true;

  return deps.workItemService.create({
    title,
    stageId,
    body: task,
    ...(input.parentWorkItemId !== undefined ? { parentId: input.parentWorkItemId } : {}),
    isAgentTask: true,
    ephemeral,
    expectedOutput,
    acceptanceCriteria,
    verificationTier: tier,
    verificationStatus: null,
    verificationNotes: null,
    assignedAgentRunId: null,
    worktreePath: input.worktree?.trim() || null,
  });
}

/** Throws AgentWorkItemInputError if the shape doesn't look like an
 *  ExpectedOutput. Cheap structural check; doesn't validate every nested field
 *  type exhaustively. */
function assertExpectedOutputShape(value: unknown): asserts value is ExpectedOutput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentWorkItemInputError('expected_output must be an object');
  }
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !(EXPECTED_OUTPUT_KINDS as readonly string[]).includes(kind)) {
    throw new AgentWorkItemInputError(
      `expected_output.kind must be one of: ${EXPECTED_OUTPUT_KINDS.join(', ')}`,
    );
  }
  const v = value as Record<string, unknown>;
  switch (kind) {
    case 'files':
      if (!Array.isArray(v.paths)) {
        throw new AgentWorkItemInputError('expected_output (files): paths must be an array');
      }
      break;
    case 'structured':
      if (!v.fields || typeof v.fields !== 'object' || Array.isArray(v.fields)) {
        throw new AgentWorkItemInputError(
          'expected_output (structured): fields must be a non-empty object',
        );
      }
      break;
    case 'side-effect':
      if (typeof v.describe !== 'string' || v.describe.trim() === '') {
        throw new AgentWorkItemInputError(
          'expected_output (side-effect): describe must be a non-empty string',
        );
      }
      break;
    case 'mixed':
      // At least one constituent must be present.
      if (!v.text && !v.files && !v.structured && !v.side_effect) {
        throw new AgentWorkItemInputError(
          'expected_output (mixed): must include at least one of text/files/structured/side_effect',
        );
      }
      break;
    case 'text':
      // No required nested fields; sections + min_chars are optional.
      break;
  }
}

/** Validate that every entry in a raw AC list has a known `kind`. Pass-through
 *  for everything else (the evaluator handles structural mismatches on use). */
function assertAcceptanceCriteriaShape(
  value: unknown,
): asserts value is AcceptancePredicate[] {
  if (!Array.isArray(value)) {
    throw new AgentWorkItemInputError('raw_acceptance_criteria must be an array');
  }
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AgentWorkItemInputError(
        `raw_acceptance_criteria[${i}]: predicate must be an object`,
      );
    }
    const k = (entry as { kind?: unknown }).kind;
    if (
      typeof k !== 'string' ||
      !(ACCEPTANCE_PREDICATE_KINDS as readonly string[]).includes(k)
    ) {
      throw new AgentWorkItemInputError(
        `raw_acceptance_criteria[${i}].kind must be one of: ${ACCEPTANCE_PREDICATE_KINDS.join(', ')}`,
      );
    }
  }
}
