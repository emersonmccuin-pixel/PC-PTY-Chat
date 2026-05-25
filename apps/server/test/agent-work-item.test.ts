// Section 26.3 — unit tests for the agent-work-item service helper.
//
// Uses a fake WorkItemService that captures the input passed to .create() so
// we can assert on derived AC, default fills, and contract-field passthrough
// without touching the DB. Mirrors routing-steps.test.ts.
//
// Run via:  pnpm --filter @pc/server test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  ExpectedOutput,
  Project,
  ULID,
  WorkItem,
} from '@pc/domain';

import {
  AgentWorkItemInputError,
  createAgentWorkItem,
} from '../src/services/agent-work-item.ts';
import type { CreateWorkItemServiceInput, WorkItemService } from '../src/services/work-item.ts';

// ── Helpers ────────────────────────────────────────────────────────────────

interface CapturedCall {
  input: CreateWorkItemServiceInput;
}

function mkFakeService(): { svc: WorkItemService; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const svc = {
    create(input: CreateWorkItemServiceInput): WorkItem {
      calls.push({ input });
      return {
        id: 'wi-fake' as ULID,
        projectId: 'p-fake' as ULID,
        parentId: input.parentId ?? null,
        position: 0,
        title: input.title,
        body: input.body ?? '',
        stageId: input.stageId,
        status: 'pending',
        statusReason: null,
        type: input.type ?? 'task',
        fields: input.fields ?? {},
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        deletedAt: null,
        history: [],
        isAgentTask: input.isAgentTask ?? false,
        ephemeral: input.ephemeral ?? false,
        acceptanceCriteria: input.acceptanceCriteria ?? null,
        expectedOutput: input.expectedOutput ?? null,
        verificationTier: input.verificationTier ?? null,
        verificationStatus: input.verificationStatus ?? null,
        verificationNotes: input.verificationNotes ?? null,
        assignedAgentRunId: input.assignedAgentRunId ?? null,
        worktreePath: input.worktreePath ?? null,
        taggedProjectId: input.taggedProjectId ?? null,
      } satisfies WorkItem;
    },
  } as unknown as WorkItemService;
  return { svc, calls };
}

function mkProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p-fake' as ULID,
    name: 'fake',
    slug: 'fake',
    folderPath: 'C:/fake',
    position: 0,
    archived: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stages: [
      { id: 'backlog', name: 'Backlog', order: 0 },
      { id: 'doing', name: 'Doing', order: 1 },
    ],
    settings: {},
    ...overrides,
  } as Project;
}

// ── Happy paths ────────────────────────────────────────────────────────────

test('createAgentWorkItem — fills pod default expected_output for researcher', () => {
  const { svc, calls } = mkFakeService();
  const project = mkProject();
  createAgentWorkItem(
    {
      title: 'investigate',
      task: 'find usages of X',
      pod: 'researcher',
    },
    { workItemService: svc, getProject: () => project },
  );
  assert.equal(calls.length, 1);
  const input = calls[0]!.input;
  // Pod default for researcher = { kind: 'text', sections: ['summary'] }.
  // Derivation produces a single body_contains predicate for the 'summary' section.
  assert.deepEqual(input.expectedOutput, { kind: 'text', sections: ['summary'] });
  assert.deepEqual(input.acceptanceCriteria, [
    { kind: 'body_contains', pattern: 'summary' },
  ]);
  assert.equal(input.isAgentTask, true);
  assert.equal(input.ephemeral, false);
  assert.equal(input.verificationTier, 'auto');
  assert.equal(input.body, 'find usages of X');
  assert.equal(input.title, 'investigate');
  assert.equal(input.stageId, 'backlog');
});

test('createAgentWorkItem — caller-supplied expected_output overrides pod default', () => {
  const { svc, calls } = mkFakeService();
  const project = mkProject();
  const customOutput: ExpectedOutput = {
    kind: 'structured',
    fields: { verdict: 'string', notes: 'string' },
  };
  createAgentWorkItem(
    {
      title: 'classify',
      task: 'classify the item',
      pod: 'researcher',
      expectedOutput: customOutput,
    },
    { workItemService: svc, getProject: () => project },
  );
  const input = calls[0]!.input;
  assert.deepEqual(input.expectedOutput, customOutput);
  // Derived from structured kind → single fields_populated predicate.
  assert.deepEqual(input.acceptanceCriteria, [
    { kind: 'fields_populated', keys: ['verdict', 'notes'] },
  ]);
});

test('createAgentWorkItem — raw_acceptance_criteria overrides derived AC', () => {
  const { svc, calls } = mkFakeService();
  const project = mkProject();
  createAgentWorkItem(
    {
      title: 't',
      task: 'task',
      pod: 'researcher',
      rawAcceptanceCriteria: [
        { kind: 'bash_exit_zero', command: 'true' },
        { kind: 'body_contains', pattern: 'OK' },
      ],
    },
    { workItemService: svc, getProject: () => project },
  );
  const input = calls[0]!.input;
  // expectedOutput still falls back to the pod default…
  assert.deepEqual(input.expectedOutput, { kind: 'text', sections: ['summary'] });
  // …but AC reflects the raw override, NOT the derivation.
  assert.deepEqual(input.acceptanceCriteria, [
    { kind: 'bash_exit_zero', command: 'true' },
    { kind: 'body_contains', pattern: 'OK' },
  ]);
});

test('createAgentWorkItem — stageId from caller wins; defaults to first stage otherwise', () => {
  const { svc, calls } = mkFakeService();
  const project = mkProject();
  createAgentWorkItem(
    { title: 't', task: 'task', pod: 'researcher', stageId: 'doing' },
    { workItemService: svc, getProject: () => project },
  );
  assert.equal(calls[0]!.input.stageId, 'doing');
});

test('createAgentWorkItem — passes ephemeral + worktree + parent through', () => {
  const { svc, calls } = mkFakeService();
  const project = mkProject();
  createAgentWorkItem(
    {
      title: 't',
      task: 'task',
      pod: 'researcher',
      ephemeral: true,
      worktree: 'E:/tmp/wt-1',
      parentWorkItemId: 'wi-parent' as ULID,
    },
    { workItemService: svc, getProject: () => project },
  );
  const input = calls[0]!.input;
  assert.equal(input.ephemeral, true);
  assert.equal(input.worktreePath, 'E:/tmp/wt-1');
  assert.equal(input.parentId, 'wi-parent');
});

test('createAgentWorkItem — verificationTier honoured (orchestrator-review)', () => {
  const { svc, calls } = mkFakeService();
  const project = mkProject();
  createAgentWorkItem(
    { title: 't', task: 'task', pod: 'researcher', verificationTier: 'orchestrator-review' },
    { workItemService: svc, getProject: () => project },
  );
  assert.equal(calls[0]!.input.verificationTier, 'orchestrator-review');
});

// ── Failure modes ──────────────────────────────────────────────────────────

test('createAgentWorkItem — throws when title is empty', () => {
  const { svc } = mkFakeService();
  assert.throws(
    () =>
      createAgentWorkItem(
        { title: '   ', task: 't', pod: 'researcher' },
        { workItemService: svc, getProject: () => mkProject() },
      ),
    (err: unknown) =>
      err instanceof AgentWorkItemInputError && /title required/.test((err as Error).message),
  );
});

test('createAgentWorkItem — throws when task is empty', () => {
  const { svc } = mkFakeService();
  assert.throws(
    () =>
      createAgentWorkItem(
        { title: 't', task: '', pod: 'researcher' },
        { workItemService: svc, getProject: () => mkProject() },
      ),
    (err: unknown) =>
      err instanceof AgentWorkItemInputError && /task required/.test((err as Error).message),
  );
});

test('createAgentWorkItem — throws when pod is empty', () => {
  const { svc } = mkFakeService();
  assert.throws(
    () =>
      createAgentWorkItem(
        { title: 't', task: 't', pod: '' },
        { workItemService: svc, getProject: () => mkProject() },
      ),
    (err: unknown) =>
      err instanceof AgentWorkItemInputError && /pod required/.test((err as Error).message),
  );
});

test('createAgentWorkItem — throws when unknown pod has no default + no expected_output', () => {
  const { svc } = mkFakeService();
  assert.throws(
    () =>
      createAgentWorkItem(
        { title: 't', task: 't', pod: 'custom-pod-with-no-default' },
        { workItemService: svc, getProject: () => mkProject() },
      ),
    (err: unknown) =>
      err instanceof AgentWorkItemInputError &&
      /no default expected_output/.test((err as Error).message),
  );
});

test('createAgentWorkItem — accepts custom pod when expected_output explicit', () => {
  const { svc, calls } = mkFakeService();
  const project = mkProject();
  createAgentWorkItem(
    {
      title: 't',
      task: 't',
      pod: 'snowflake-modifier',
      expectedOutput: {
        kind: 'side-effect',
        describe: 'ran the migration',
        verify_via_bash: 'snowflake-cli verify',
      },
    },
    { workItemService: svc, getProject: () => project },
  );
  assert.deepEqual(calls[0]!.input.acceptanceCriteria, [
    { kind: 'bash_exit_zero', command: 'snowflake-cli verify', cwd: 'worktree' },
  ]);
});

test('createAgentWorkItem — rejects malformed expected_output shape', () => {
  const { svc } = mkFakeService();
  assert.throws(
    () =>
      createAgentWorkItem(
        {
          title: 't',
          task: 't',
          pod: 'researcher',
          // @ts-expect-error — exercising runtime validation
          expectedOutput: { kind: 'nope' },
        },
        { workItemService: svc, getProject: () => mkProject() },
      ),
    (err: unknown) =>
      err instanceof AgentWorkItemInputError &&
      /expected_output\.kind/.test((err as Error).message),
  );
});

test('createAgentWorkItem — rejects malformed raw_acceptance_criteria entries', () => {
  const { svc } = mkFakeService();
  assert.throws(
    () =>
      createAgentWorkItem(
        {
          title: 't',
          task: 't',
          pod: 'researcher',
          // @ts-expect-error — exercising runtime validation
          rawAcceptanceCriteria: [{ kind: 'bogus_kind' }],
        },
        { workItemService: svc, getProject: () => mkProject() },
      ),
    (err: unknown) =>
      err instanceof AgentWorkItemInputError &&
      /raw_acceptance_criteria/.test((err as Error).message),
  );
});

// Section 26 carry-over #1 — `expected_output` validator rejects unknown
// nested fields. Pre-fix the orchestrator could smuggle task content via
// non-schema fields like `description` / `shape`; derivation library saw no
// `sections` / `min_chars` and returned empty AC → tier-1 verification passed
// vacuously. These tests prove the smuggling channel is now closed.
test('createAgentWorkItem — rejects unknown field on text expected_output', () => {
  const { svc } = mkFakeService();
  assert.throws(
    () =>
      createAgentWorkItem(
        {
          title: 't',
          task: 't',
          pod: 'researcher',
          // @ts-expect-error — exercising the unknown-field reject
          expectedOutput: { kind: 'text', description: '3-4 bullets on X' },
        },
        { workItemService: svc, getProject: () => mkProject() },
      ),
    (err: unknown) =>
      err instanceof AgentWorkItemInputError &&
      /unknown field "description"/.test((err as Error).message),
  );
});

test('createAgentWorkItem — rejects unknown field on files expected_output', () => {
  const { svc } = mkFakeService();
  assert.throws(
    () =>
      createAgentWorkItem(
        {
          title: 't',
          task: 't',
          pod: 'researcher',
          // @ts-expect-error — exercising the unknown-field reject
          expectedOutput: { kind: 'files', paths: ['a.md'], shape: 'should be a doc' },
        },
        { workItemService: svc, getProject: () => mkProject() },
      ),
    (err: unknown) =>
      err instanceof AgentWorkItemInputError &&
      /unknown field "shape"/.test((err as Error).message),
  );
});

test('createAgentWorkItem — rejects unknown nested field on mixed.text', () => {
  const { svc } = mkFakeService();
  assert.throws(
    () =>
      createAgentWorkItem(
        {
          title: 't',
          task: 't',
          pod: 'researcher',
          expectedOutput: {
            kind: 'mixed',
            // @ts-expect-error — exercising the nested unknown-field reject
            text: { description: 'smuggled task content' },
          },
        },
        { workItemService: svc, getProject: () => mkProject() },
      ),
    (err: unknown) =>
      err instanceof AgentWorkItemInputError &&
      /mixed\.text.*unknown field "description"/.test((err as Error).message),
  );
});

test('createAgentWorkItem — accepts canonical text expected_output without smuggled fields', () => {
  const { svc, calls } = mkFakeService();
  createAgentWorkItem(
    {
      title: 't',
      task: 't',
      pod: 'researcher',
      expectedOutput: { kind: 'text', sections: ['summary'], min_chars: 100 },
    },
    { workItemService: svc, getProject: () => mkProject() },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.input.expectedOutput, {
    kind: 'text',
    sections: ['summary'],
    min_chars: 100,
  });
});

test('createAgentWorkItem — rejects unknown verification_tier', () => {
  const { svc } = mkFakeService();
  assert.throws(
    () =>
      createAgentWorkItem(
        {
          title: 't',
          task: 't',
          pod: 'researcher',
          // @ts-expect-error — exercising runtime validation
          verificationTier: 'astrology',
        },
        { workItemService: svc, getProject: () => mkProject() },
      ),
    (err: unknown) =>
      err instanceof AgentWorkItemInputError &&
      /verification_tier/.test((err as Error).message),
  );
});

test('createAgentWorkItem — throws when project has no stages', () => {
  const { svc } = mkFakeService();
  assert.throws(
    () =>
      createAgentWorkItem(
        { title: 't', task: 't', pod: 'researcher' },
        { workItemService: svc, getProject: () => mkProject({ stages: [] }) },
      ),
    (err: unknown) =>
      err instanceof AgentWorkItemInputError && /no stages/.test((err as Error).message),
  );
});
