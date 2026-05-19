// Unit tests for the orchestrator-review step dispatcher (4a.6 / D23).
// Pure function — fakes the postChannel + broadcast deps so no real channel
// server or DB is required.
//
// Run via:  pnpm --filter @pc/server test
// Or:       pnpm test:unit  (from repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { OrchestratorReviewNode, Workflow, WorkflowRun } from '@pc/domain';

import {
  runOrchestratorReviewStep,
  buildOrchestratorReviewChannelBody,
} from '../src/services/orchestrator-review-step.ts';
import { substituteOutputs } from '../src/services/output-substitution.ts';

function mkRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-orch',
    workflowId: 'wf-orch',
    workflowYamlSnapshot: '',
    status: 'in-progress',
    startedAt: new Date().toISOString(),
    worktreePath: null,
    nodeOutputs: {},
    ...overrides,
  };
}

function mkWorkflow(): Workflow {
  return { id: 'wf-orch', nodes: [] };
}

test('runOrchestratorReviewStep: happy path POSTs to channel + emits review-pending + returns async', async () => {
  const posted: string[] = [];
  const events: unknown[] = [];
  const node: OrchestratorReviewNode = {
    id: 'review',
    kind: 'orchestrator-review',
    'orchestrator-review': {
      prompt: 'Please review the draft from $writer.output.summary',
      artifact: 'wi-$inputs.wiId',
    },
  };
  const run = mkRun({
    id: 'run-1',
    inputs: { wiId: '01J0WIA' },
    nodeOutputs: {
      writer: { status: 'complete', output: { summary: 'A grand draft.' } },
    },
  });
  const result = await runOrchestratorReviewStep(node, run, {
    workflow: mkWorkflow(),
    substituteOutputs,
    postChannel: async (body) => {
      posted.push(body);
    },
    broadcast: (e) => events.push(e),
  });
  assert.equal(result.kind, 'async');
  assert.equal(posted.length, 1);
  assert.match(posted[0]!, /Workflow review request/);
  assert.match(posted[0]!, /A grand draft\./);
  assert.match(posted[0]!, /Artifact: wi-01J0WIA/);
  assert.match(posted[0]!, /\[workflowRunId: run-1\]/);
  assert.match(posted[0]!, /pc_complete_node/);

  assert.equal(events.length, 1);
  const env = events[0] as { event: Record<string, unknown> };
  assert.equal((env.event as { kind: string }).kind, 'review-pending');
  assert.equal((env.event as { flavor: string }).flavor, 'orchestrator');
  assert.equal((env.event as { workflowRunId: string }).workflowRunId, 'run-1');
  assert.equal((env.event as { nodeId: string }).nodeId, 'review');
  assert.equal(
    (env.event as { prompt: string }).prompt,
    'Please review the draft from A grand draft.',
  );
});

test('runOrchestratorReviewStep: includes on_revise.prompt when set', async () => {
  const posted: string[] = [];
  const events: Array<{ event: { on_revise_prompt: string | null } }> = [];
  const node: OrchestratorReviewNode = {
    id: 'review',
    kind: 'orchestrator-review',
    'orchestrator-review': {
      prompt: 'Review',
      on_revise: { prompt: 'For revisions, edit src/foo.ts' },
    },
  };
  await runOrchestratorReviewStep(node, mkRun(), {
    workflow: mkWorkflow(),
    substituteOutputs,
    postChannel: async (b) => {
      posted.push(b);
    },
    broadcast: (e) =>
      events.push(e as { event: { on_revise_prompt: string | null } }),
  });
  assert.match(posted[0]!, /For revisions, edit src\/foo\.ts/);
  assert.equal(events[0]!.event.on_revise_prompt, 'For revisions, edit src/foo.ts');
});

test('runOrchestratorReviewStep: postChannel throw → step fails sync (no broadcast)', async () => {
  const events: unknown[] = [];
  const node: OrchestratorReviewNode = {
    id: 'review',
    kind: 'orchestrator-review',
    'orchestrator-review': { prompt: 'x' },
  };
  const result = await runOrchestratorReviewStep(node, mkRun(), {
    workflow: mkWorkflow(),
    substituteOutputs,
    postChannel: async () => {
      throw new Error('channel down');
    },
    broadcast: (e) => events.push(e),
  });
  assert.equal(result.kind, 'sync');
  assert.equal(result.output?.status, 'failed');
  assert.match(result.output?.error ?? '', /channel POST failed: channel down/);
  assert.equal(events.length, 0, 'must not broadcast when POST failed');
});

test('runOrchestratorReviewStep: artifact omitted → no Artifact line in body', async () => {
  const posted: string[] = [];
  const node: OrchestratorReviewNode = {
    id: 'review',
    kind: 'orchestrator-review',
    'orchestrator-review': { prompt: 'just a prompt' },
  };
  await runOrchestratorReviewStep(node, mkRun(), {
    workflow: mkWorkflow(),
    substituteOutputs,
    postChannel: async (b) => {
      posted.push(b);
    },
    broadcast: () => {},
  });
  assert.doesNotMatch(posted[0]!, /Artifact:/);
});

test('buildOrchestratorReviewChannelBody: emits decision-shape instruction', () => {
  const body = buildOrchestratorReviewChannelBody({
    runId: 'r1',
    nodeId: 'n1',
    workflowId: 'wf',
    prompt: 'p',
    artifact: null,
    onRevisePrompt: null,
  });
  // Instruction must name the three valid decisions and the call shape.
  assert.match(body, /"approve"/);
  assert.match(body, /"reject"/);
  assert.match(body, /"revise"/);
  assert.match(body, /pc_complete_node\(\{ workflowRunId, nodeId, output:/);
});

test('buildOrchestratorReviewChannelBody: prepends the [pc:workflow-event] header (4c / D38)', () => {
  const body = buildOrchestratorReviewChannelBody({
    runId: 'r1',
    nodeId: 'n1',
    workflowId: 'wf',
    prompt: 'p',
    artifact: null,
    onRevisePrompt: null,
  });
  const firstLine = body.split('\n', 1)[0];
  assert.equal(firstLine, '[pc:workflow-event kind=orchestrator-review version=1]');
});
