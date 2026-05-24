// Unit tests for the four routing-step dispatchers (4a.5):
//   - attach-to-work-item
//   - create-work-item
//   - update-work-item
//   - write-to-worktree
//
// Each dispatcher is a pure async function whose dependencies are passed in
// via a deps object. Tests use fakes for AttachmentService / WorkItemService
// + a tmp dir for the worktree path so no DB is required.
//
// Run via:  pnpm --filter @pc/server test
// Or:       pnpm test:unit  (from repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';

import type {
  Attachment,
  AttachToWorkItemNode,
  CreateWorkItemNode,
  Project,
  UpdateWorkItemNode,
  ULID,
  WorkItem,
  WorkflowRun,
  Workflow,
  WriteToWorktreeNode,
} from '@pc/domain';

import { runAttachToWorkItemStep } from '../src/services/attach-to-work-item-step.ts';
import { runCreateWorkItemStep } from '../src/services/create-work-item-step.ts';
import { runUpdateWorkItemStep } from '../src/services/update-work-item-step.ts';
import { runWriteToWorktreeStep } from '../src/services/write-to-worktree-step.ts';
import { substituteOutputs } from '../src/services/output-substitution.ts';
import type { SubstituteTemplate } from '../src/services/typed-substitution.ts';
import type { AttachmentService, CreateAttachmentServiceInput } from '../src/services/attachment.ts';
import type {
  PatchWorkItemServiceInput,
  WorkItemService,
} from '../src/services/work-item.ts';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Section 26 — null/false defaults for the work-item-as-contract fields,
 *  spread into fixture literals so non-agent WorkItem fixtures match the
 *  domain shape. */
const EMPTY_CONTRACT = {
  isAgentTask: false,
  ephemeral: false,
  acceptanceCriteria: null,
  expectedOutput: null,
  verificationTier: null,
  verificationStatus: null,
  verificationNotes: null,
  assignedAgentRunId: null,
  worktreePath: null,
} as const;

/** Test-only: adapt the legacy regex substituter to the post-4h.9
 *  SubstituteTemplate signature. The runtime path uses typed-edge wires
 *  (`{{ name }}` + `wire:`) at dispatch time; tests retain the legacy
 *  $X.Y grammar because it's the cheapest way to assert resolution
 *  correctness without rebuilding edge fixtures per case. */
function legacyTmpl(run: WorkflowRun): SubstituteTemplate {
  return (text) => substituteOutputs(text, run);
}

function mkRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-test',
    workflowId: 'wf-test',
    workflowYamlSnapshot: '',
    status: 'in-progress',
    startedAt: new Date().toISOString(),
    worktreePath: null,
    nodeOutputs: {},
    ...overrides,
  };
}

function mkWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-test',
    nodes: [],
    ...overrides,
  };
}

function mkFakeAttachmentService(): {
  svc: AttachmentService;
  calls: CreateAttachmentServiceInput[];
} {
  const calls: CreateAttachmentServiceInput[] = [];
  const svc = {
    create(input: CreateAttachmentServiceInput): Attachment {
      calls.push(input);
      return {
        id: 'att-1' as ULID,
        workItemId: input.workItemId,
        kind: input.kind,
        name: input.name,
        content: input.content,
        contentType: input.contentType ?? null,
        runId: input.runId ?? null,
        createdBySessionId: input.createdBySessionId ?? null,
        source: input.source ?? 'user',
        agentName: input.agentName ?? null,
        nodeId: input.nodeId ?? null,
        createdAt: Date.now(),
      };
    },
  } as unknown as AttachmentService;
  return { svc, calls };
}

interface CreateCall {
  title: string;
  stageId: string;
  body?: string;
  parentId?: ULID | null;
}

function mkFakeWorkItemService(opts: {
  createSucceeds?: boolean;
  patchSucceeds?: boolean;
  existing?: WorkItem;
} = {}): {
  svc: WorkItemService;
  createCalls: CreateCall[];
  patchCalls: Array<{ id: ULID; input: PatchWorkItemServiceInput }>;
} {
  const createCalls: CreateCall[] = [];
  const patchCalls: Array<{ id: ULID; input: PatchWorkItemServiceInput }> = [];
  const createSucceeds = opts.createSucceeds !== false;
  const patchSucceeds = opts.patchSucceeds !== false;

  const svc = {
    create(input: CreateCall): WorkItem {
      createCalls.push(input);
      if (!createSucceeds) throw new Error('boom: create failed');
      return {
        id: 'wi-new' as ULID,
        projectId: 'p1' as ULID,
        title: input.title,
        body: input.body ?? '',
        stageId: input.stageId,
        parentId: input.parentId ?? null,
        position: 0,
        type: 'task',
        fields: {},
        status: 'pending',
        statusReason: null,
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        deletedAt: null,
        history: [],
        ...EMPTY_CONTRACT,
      } as WorkItem;
    },
    patch(id: ULID, input: PatchWorkItemServiceInput): WorkItem {
      patchCalls.push({ id, input });
      if (!patchSucceeds) throw new Error('boom: patch failed');
      const base = opts.existing ?? {
        id,
        projectId: 'p1' as ULID,
        title: 't',
        body: '',
        stageId: 'todo',
        parentId: null,
        position: 0,
        type: 'task',
        fields: {},
        status: 'pending',
        statusReason: null,
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        deletedAt: null,
        history: [],
        ...EMPTY_CONTRACT,
      } as WorkItem;
      return {
        ...base,
        version: base.version + 1,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.stageId !== undefined ? { stageId: input.stageId } : {}),
        ...(input.fields !== undefined ? { fields: input.fields } : {}),
      } as WorkItem;
    },
    get(id: ULID): WorkItem | null {
      return opts.existing && opts.existing.id === id ? opts.existing : null;
    },
  } as unknown as WorkItemService;

  return { svc, createCalls, patchCalls };
}

function mkProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1' as ULID,
    slug: 'p1',
    name: 'Project 1',
    folderPath: '/tmp/p1',
    stages: [
      { id: 'todo', name: 'Todo', order: 0 },
      { id: 'done', name: 'Done', order: 1 },
    ],
    archived: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as Project;
}

// ── attach-to-work-item ────────────────────────────────────────────────────

test('runAttachToWorkItemStep: happy path passes substituted fields + agent provenance', async () => {
  const { svc, calls } = mkFakeAttachmentService();
  const node: AttachToWorkItemNode = {
    id: 'save',
    kind: 'attach-to-work-item',
    depends_on: ['researcher'],
    'attach-to-work-item': {
      workItemId: '$inputs.wiId',
      name: 'result.md',
      content: '$researcher.output.text',
      kind: 'markdown',
    },
  };
  const wf = mkWorkflow({
    nodes: [
      { id: 'researcher', kind: 'subagent', subagent: 'researcher', prompt: 'go' },
      node,
    ],
  });
  const run = mkRun({
    id: 'run-1',
    inputs: { wiId: '01J0WIA' },
    nodeOutputs: {
      researcher: {
        status: 'complete',
        output: { text: 'hello world' },
      },
    },
  });
  const result = await runAttachToWorkItemStep(node, run, {
    attachmentService: svc,
    workflow: wf,
    substituteTemplate: legacyTmpl(run),
  });
  assert.equal(result.output.status, 'complete');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.workItemId, '01J0WIA');
  assert.equal(calls[0]!.name, 'result.md');
  assert.equal(calls[0]!.content, 'hello world');
  assert.equal(calls[0]!.kind, 'markdown');
  assert.equal(calls[0]!.source, 'agent');
  assert.equal(calls[0]!.agentName, 'researcher');
  assert.equal(calls[0]!.runId, 'run-1');
  assert.equal(calls[0]!.nodeId, 'save');
});

test('runAttachToWorkItemStep: empty workItemId after substitution fails fast', async () => {
  const { svc, calls } = mkFakeAttachmentService();
  const node: AttachToWorkItemNode = {
    id: 'save',
    kind: 'attach-to-work-item',
    'attach-to-work-item': {
      workItemId: '$inputs.wiId',
      name: 'x',
      content: 'y',
    },
  };
  const run = mkRun();
  const result = await runAttachToWorkItemStep(node, run, {
    attachmentService: svc,
    workflow: mkWorkflow({ nodes: [node] }),
    substituteTemplate: legacyTmpl(run),
  });
  assert.equal(result.output.status, 'failed');
  assert.match(result.output.error ?? '', /workItemId resolved to empty/);
  assert.equal(calls.length, 0);
});

test('runAttachToWorkItemStep: no subagent ancestor → agentName null', async () => {
  const { svc, calls } = mkFakeAttachmentService();
  const node: AttachToWorkItemNode = {
    id: 'save',
    kind: 'attach-to-work-item',
    'attach-to-work-item': { workItemId: 'wi-1', name: 'x', content: 'y' },
  };
  const run = mkRun();
  const result = await runAttachToWorkItemStep(node, run, {
    attachmentService: svc,
    workflow: mkWorkflow({ nodes: [node] }),
    substituteTemplate: legacyTmpl(run),
  });
  assert.equal(result.output.status, 'complete');
  assert.equal(calls[0]!.agentName, null);
});

test('runAttachToWorkItemStep: service throw → step fails with reason', async () => {
  const svc = {
    create() {
      throw new Error('attachment service exploded');
    },
  } as unknown as AttachmentService;
  const node: AttachToWorkItemNode = {
    id: 'save',
    kind: 'attach-to-work-item',
    'attach-to-work-item': { workItemId: 'wi-1', name: 'x', content: 'y' },
  };
  const run = mkRun();
  const result = await runAttachToWorkItemStep(node, run, {
    attachmentService: svc,
    workflow: mkWorkflow({ nodes: [node] }),
    substituteTemplate: legacyTmpl(run),
  });
  assert.equal(result.output.status, 'failed');
  assert.match(result.output.error ?? '', /attach failed: attachment service exploded/);
});

// ── create-work-item ────────────────────────────────────────────────────────

test('runCreateWorkItemStep: defaults to project first stage when unset', async () => {
  const { svc, createCalls } = mkFakeWorkItemService();
  const node: CreateWorkItemNode = {
    id: 'spawn',
    kind: 'create-work-item',
    'create-work-item': { title: '$inputs.title' },
  };
  const run = mkRun({ inputs: { title: 'New work' } });
  const result = await runCreateWorkItemStep(node, run, {
    workItemService: svc,
    getProject: () => mkProject(),
    substituteTemplate: legacyTmpl(run),
  });
  assert.equal(result.output.status, 'complete');
  assert.equal(createCalls[0]!.title, 'New work');
  assert.equal(createCalls[0]!.stageId, 'todo');
});

test('runCreateWorkItemStep: explicit stage substitutes from inputs', async () => {
  const { svc, createCalls } = mkFakeWorkItemService();
  const node: CreateWorkItemNode = {
    id: 'spawn',
    kind: 'create-work-item',
    'create-work-item': {
      title: 'x',
      stage: '$inputs.targetStage',
      body: '$inputs.body',
    },
  };
  const run = mkRun({ inputs: { targetStage: 'done', body: 'detail' } });
  await runCreateWorkItemStep(
    node,
    run,
    {
      workItemService: svc,
      getProject: () => mkProject(),
      substituteTemplate: legacyTmpl(run),
    },
  );
  assert.equal(createCalls[0]!.stageId, 'done');
  assert.equal(createCalls[0]!.body, 'detail');
});

test('runCreateWorkItemStep: service throw → step fails', async () => {
  const { svc } = mkFakeWorkItemService({ createSucceeds: false });
  const node: CreateWorkItemNode = {
    id: 'spawn',
    kind: 'create-work-item',
    'create-work-item': { title: 'x' },
  };
  const run = mkRun();
  const result = await runCreateWorkItemStep(node, run, {
    workItemService: svc,
    getProject: () => mkProject(),
    substituteTemplate: legacyTmpl(run),
  });
  assert.equal(result.output.status, 'failed');
  assert.match(result.output.error ?? '', /create failed/);
});

// ── update-work-item ────────────────────────────────────────────────────────

test('runUpdateWorkItemStep: reads version + sends only changed keys', async () => {
  const existing = {
    id: 'wi-1' as ULID,
    projectId: 'p1' as ULID,
    title: 'old',
    body: '',
    stageId: 'todo',
    parentId: null,
    position: 0,
    type: 'task',
    fields: { reviewer: 'alice' },
    status: 'pending',
    statusReason: null,
    version: 7,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deletedAt: null,
    history: [],
    ...EMPTY_CONTRACT,
  } as WorkItem;
  const { svc, patchCalls } = mkFakeWorkItemService({ existing });
  const node: UpdateWorkItemNode = {
    id: 'patch',
    kind: 'update-work-item',
    'update-work-item': {
      workItemId: 'wi-1',
      title: 'new title',
      fields: { reviewer: 'bob' },
    },
  };
  const run = mkRun();
  const result = await runUpdateWorkItemStep(node, run, {
    workItemService: svc,
    substituteTemplate: legacyTmpl(run),
  });
  assert.equal(result.output.status, 'complete');
  assert.equal(patchCalls.length, 1);
  assert.equal(patchCalls[0]!.id, 'wi-1');
  assert.equal(patchCalls[0]!.input.expectedVersion, 7);
  assert.equal(patchCalls[0]!.input.title, 'new title');
  assert.deepEqual(patchCalls[0]!.input.fields, { reviewer: 'bob' });
  // Unsupplied keys should be absent.
  assert.equal(patchCalls[0]!.input.body, undefined);
  assert.equal(patchCalls[0]!.input.stageId, undefined);
});

test('runUpdateWorkItemStep: unknown work item → step fails', async () => {
  const { svc, patchCalls } = mkFakeWorkItemService();
  const node: UpdateWorkItemNode = {
    id: 'patch',
    kind: 'update-work-item',
    'update-work-item': { workItemId: 'wi-missing', title: 'x' },
  };
  const run = mkRun();
  const result = await runUpdateWorkItemStep(node, run, {
    workItemService: svc,
    substituteTemplate: legacyTmpl(run),
  });
  assert.equal(result.output.status, 'failed');
  assert.match(result.output.error ?? '', /unknown work item: wi-missing/);
  assert.equal(patchCalls.length, 0);
});

// ── write-to-worktree ───────────────────────────────────────────────────────

test('runWriteToWorktreeStep: writes file inside worktree', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'wtw-'));
  const node: WriteToWorktreeNode = {
    id: 'write',
    kind: 'write-to-worktree',
    'write-to-worktree': {
      path: 'docs/result.md',
      content: '$inputs.body',
    },
  };
  const run = mkRun({ worktreePath: dir, inputs: { body: '# hello' } });
  const result = await runWriteToWorktreeStep(
    node,
    run,
    { substituteTemplate: legacyTmpl(run) },
  );
  assert.equal(result.output.status, 'complete');
  const written = readFileSync(resolve(dir, 'docs', 'result.md'), 'utf-8');
  assert.equal(written, '# hello');
});

test('runWriteToWorktreeStep: append mode adds to existing file', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'wtw-'));
  const target = resolve(dir, 'log.txt');
  writeFileSync(target, 'line1\n', 'utf-8');
  const node: WriteToWorktreeNode = {
    id: 'append',
    kind: 'write-to-worktree',
    'write-to-worktree': { path: 'log.txt', content: 'line2\n', mode: 'append' },
  };
  const run = mkRun({ worktreePath: dir });
  const result = await runWriteToWorktreeStep(node, run, {
    substituteTemplate: legacyTmpl(run),
  });
  assert.equal(result.output.status, 'complete');
  assert.equal(readFileSync(target, 'utf-8'), 'line1\nline2\n');
});

test('runWriteToWorktreeStep: path escaping fails', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'wtw-'));
  const node: WriteToWorktreeNode = {
    id: 'bad',
    kind: 'write-to-worktree',
    'write-to-worktree': { path: `..${sep}escape.txt`, content: 'no' },
  };
  const run = mkRun({ worktreePath: dir });
  const result = await runWriteToWorktreeStep(node, run, {
    substituteTemplate: legacyTmpl(run),
  });
  assert.equal(result.output.status, 'failed');
  assert.match(result.output.error ?? '', /escapes worktree root/);
});

test('runWriteToWorktreeStep: absolute path fails', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'wtw-'));
  const node: WriteToWorktreeNode = {
    id: 'bad',
    kind: 'write-to-worktree',
    'write-to-worktree': { path: resolve(dir, 'absolute.txt'), content: 'no' },
  };
  const run = mkRun({ worktreePath: dir });
  const result = await runWriteToWorktreeStep(node, run, {
    substituteTemplate: legacyTmpl(run),
  });
  assert.equal(result.output.status, 'failed');
  assert.match(result.output.error ?? '', /must be relative to the worktree/);
});

test('runWriteToWorktreeStep: missing worktreePath fails', async () => {
  const node: WriteToWorktreeNode = {
    id: 'write',
    kind: 'write-to-worktree',
    'write-to-worktree': { path: 'x.txt', content: 'y' },
  };
  const run = mkRun({ worktreePath: null });
  const result = await runWriteToWorktreeStep(node, run, {
    substituteTemplate: legacyTmpl(run),
  });
  assert.equal(result.output.status, 'failed');
  assert.match(result.output.error ?? '', /requires the workflow to declare a worktree/);
});

test('runWriteToWorktreeStep: refuses to overwrite a directory', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'wtw-'));
  mkdirSync(resolve(dir, 'imadir'));
  const node: WriteToWorktreeNode = {
    id: 'write',
    kind: 'write-to-worktree',
    'write-to-worktree': { path: 'imadir', content: 'x' },
  };
  const run = mkRun({ worktreePath: dir });
  const result = await runWriteToWorktreeStep(node, run, {
    substituteTemplate: legacyTmpl(run),
  });
  assert.equal(result.output.status, 'failed');
  assert.match(result.output.error ?? '', /is a directory/);
});
