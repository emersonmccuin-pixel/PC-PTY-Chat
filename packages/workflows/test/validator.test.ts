// Unit tests for the hand-rolled workflow validator. 4a.2 introduces:
//   - `agent:` alias for the existing `subagent:` field (mutually exclusive)
//   - `$inputs.<key>` accepted as a valid agent name string (resolved at dispatch)
//   - `$<...>` rejected on nested-workflow `workflow:` (D16 — dynamic id
//     limited to agent steps)
// These tests pin those rules so the parser/validator contract is stable for
// 4a.3 (generic-agent-runner goes functional) and the rest of the queue.
//
// Run via:  pnpm --filter @pc/workflows test
// Or:       pnpm test:unit  (from repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateWorkflow } from '../src/validator.ts';

function baseRoot(nodes: unknown[]): Record<string, unknown> {
  return { id: 'wf-test', nodes };
}

const opts = { expectedId: 'wf-test' };

// ── `agent:` alias ──────────────────────────────────────────────────────────

test('validator: agent: alias is accepted and normalized to subagent:', () => {
  const result = validateWorkflow(
    baseRoot([{ id: 'n1', agent: 'researcher', prompt: 'go' }]),
    opts,
  );
  assert.equal(result.ok, true);
  const node = result.workflow!.nodes[0]!;
  assert.equal(node.kind, 'subagent');
  // SubagentNode shape: stored as `subagent` field regardless of input alias.
  assert.equal((node as { subagent: string }).subagent, 'researcher');
});

test('validator: static subagent: still works (no churn for existing workflows)', () => {
  const result = validateWorkflow(
    baseRoot([{ id: 'n1', subagent: 'researcher', prompt: 'go' }]),
    opts,
  );
  assert.equal(result.ok, true);
  const node = result.workflow!.nodes[0]!;
  assert.equal((node as { subagent: string }).subagent, 'researcher');
});

test('validator: both agent: and subagent: present → error', () => {
  const result = validateWorkflow(
    baseRoot([{ id: 'n1', agent: 'a', subagent: 'b', prompt: 'go' }]),
    opts,
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => /both/.test(e.message)),
    `expected an error about declaring both agent and subagent; got ${JSON.stringify(result.errors)}`,
  );
});

// ── `$inputs.<key>` on the agent name ───────────────────────────────────────

test('validator: $inputs.<key> accepted as agent name (resolved at dispatch)', () => {
  const result = validateWorkflow(
    baseRoot([{ id: 'n1', agent: '$inputs.agent', prompt: '$inputs.prompt' }]),
    opts,
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const node = result.workflow!.nodes[0]!;
  assert.equal((node as { subagent: string }).subagent, '$inputs.agent');
  assert.equal((node as { prompt: string }).prompt, '$inputs.prompt');
});

test('validator: $inputs.<key> accepted on legacy subagent: alias too', () => {
  const result = validateWorkflow(
    baseRoot([{ id: 'n1', subagent: '$inputs.agent', prompt: 'go' }]),
    opts,
  );
  assert.equal(result.ok, true);
});

// ── D16: $inputs.* rejected on nested-workflow `workflow:` ──────────────────

test('validator: nested-workflow workflow: rejects $inputs.* dynamic id', () => {
  const result = validateWorkflow(
    baseRoot([{ id: 'n1', workflow: '$inputs.target' }]),
    opts,
  );
  assert.equal(result.ok, false);
  const err = result.errors.find((e) => e.path === 'nodes[0].workflow');
  assert.ok(err, `expected an error on nodes[0].workflow; got ${JSON.stringify(result.errors)}`);
  assert.ok(/D16|static workflow id|not allowed/.test(err!.message));
});

test('validator: nested-workflow workflow: rejects $<stepId>.output.* dynamic id', () => {
  const result = validateWorkflow(
    baseRoot([{ id: 'n1', workflow: '$picker.output.name' }]),
    opts,
  );
  assert.equal(result.ok, false);
});

test('validator: nested-workflow workflow: static id still accepted', () => {
  const result = validateWorkflow(
    baseRoot([{ id: 'n1', workflow: 'generic-agent-runner' }]),
    opts,
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

// ── http: step kind ─────────────────────────────────────────────────────────

test('validator: http step happy path', () => {
  const result = validateWorkflow(
    baseRoot([
      {
        id: 'fetch',
        http: {
          method: 'GET',
          url: 'https://api.example.com/v1/items',
          headers: { Authorization: 'Bearer $ENV.JIRA_TOKEN' },
          timeout: 5000,
        },
      },
    ]),
    opts,
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const node = result.workflow!.nodes[0]!;
  assert.equal(node.kind, 'http');
  assert.equal((node as { http: { url: string } }).http.url, 'https://api.example.com/v1/items');
  assert.equal((node as { http: { timeout: number } }).http.timeout, 5000);
});

test('validator: http step rejects unknown method', () => {
  const result = validateWorkflow(
    baseRoot([
      {
        id: 'fetch',
        http: { method: 'OPTIONS', url: 'https://x' },
      },
    ]),
    opts,
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'nodes[0].http.method'));
});

test('validator: http step rejects empty url', () => {
  const result = validateWorkflow(
    baseRoot([
      { id: 'fetch', http: { method: 'GET', url: '' } },
    ]),
    opts,
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'nodes[0].http.url'));
});

test('validator: http step rejects non-string body', () => {
  const result = validateWorkflow(
    baseRoot([
      { id: 'fetch', http: { method: 'POST', url: 'https://x', body: { a: 1 } } },
    ]),
    opts,
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'nodes[0].http.body'));
});

test('validator: http step rejects non-positive timeout', () => {
  const result = validateWorkflow(
    baseRoot([
      { id: 'fetch', http: { method: 'GET', url: 'https://x', timeout: 0 } },
    ]),
    opts,
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'nodes[0].http.timeout'));
});

test('validator: http and bash on the same node → both-discriminators error', () => {
  const result = validateWorkflow(
    baseRoot([
      {
        id: 'fetch',
        http: { method: 'GET', url: 'https://x' },
        bash: 'echo hi',
      },
    ]),
    opts,
  );
  assert.equal(result.ok, false);
});

// ── 4a.5 — attach-to-work-item step kind ────────────────────────────────────

test('validator: attach-to-work-item happy path', () => {
  const result = validateWorkflow(
    baseRoot([
      {
        id: 'save',
        'attach-to-work-item': {
          workItemId: '$inputs.wiId',
          name: 'research.md',
          content: '$researcher.output.markdown',
          kind: 'markdown',
        },
      },
    ]),
    opts,
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const node = result.workflow!.nodes[0]!;
  assert.equal(node.kind, 'attach-to-work-item');
});

test('validator: attach-to-work-item rejects missing workItemId', () => {
  const result = validateWorkflow(
    baseRoot([
      {
        id: 'save',
        'attach-to-work-item': { name: 'x.md', content: 'hi' },
      },
    ]),
    opts,
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /workItemId/.test(e.path)));
});

test('validator: attach-to-work-item rejects missing content', () => {
  const result = validateWorkflow(
    baseRoot([
      {
        id: 'save',
        'attach-to-work-item': { workItemId: '$inputs.wi', name: 'x.md' },
      },
    ]),
    opts,
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /content/.test(e.path)));
});

// ── 4a.5 — create-work-item step kind ───────────────────────────────────────

test('validator: create-work-item happy path (title only)', () => {
  const result = validateWorkflow(
    baseRoot([{ id: 'spawn', 'create-work-item': { title: 'New task' } }]),
    opts,
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.workflow!.nodes[0]!.kind, 'create-work-item');
});

test('validator: create-work-item rejects missing title', () => {
  const result = validateWorkflow(
    baseRoot([
      { id: 'spawn', 'create-work-item': { body: 'no title' } },
    ]),
    opts,
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /title/.test(e.path)));
});

// ── 4a.5 — update-work-item step kind ───────────────────────────────────────

test('validator: update-work-item happy path with fields patch', () => {
  const result = validateWorkflow(
    baseRoot([
      {
        id: 'patch',
        'update-work-item': {
          workItemId: '$inputs.wiId',
          fields: { reviewer: 'alice' },
        },
      },
    ]),
    opts,
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.workflow!.nodes[0]!.kind, 'update-work-item');
});

test('validator: update-work-item rejects no-change body', () => {
  const result = validateWorkflow(
    baseRoot([
      { id: 'patch', 'update-work-item': { workItemId: '$inputs.wiId' } },
    ]),
    opts,
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) =>
      /at least one of: title, body, stage, fields/.test(e.message),
    ),
  );
});

test('validator: update-work-item rejects non-object fields', () => {
  const result = validateWorkflow(
    baseRoot([
      {
        id: 'patch',
        'update-work-item': { workItemId: '$inputs.wi', fields: 'oops' },
      },
    ]),
    opts,
  );
  assert.equal(result.ok, false);
});

// ── 4a.5 — write-to-worktree step kind ──────────────────────────────────────

test('validator: write-to-worktree happy path', () => {
  const result = validateWorkflow(
    baseRoot([
      {
        id: 'write',
        'write-to-worktree': {
          path: 'docs/output.md',
          content: '$writer.output.markdown',
        },
      },
    ]),
    opts,
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.workflow!.nodes[0]!.kind, 'write-to-worktree');
});

test('validator: write-to-worktree accepts append mode', () => {
  const result = validateWorkflow(
    baseRoot([
      {
        id: 'append',
        'write-to-worktree': { path: 'log.txt', content: 'line', mode: 'append' },
      },
    ]),
    opts,
  );
  assert.equal(result.ok, true);
});

test('validator: write-to-worktree rejects unknown mode', () => {
  const result = validateWorkflow(
    baseRoot([
      {
        id: 'bad',
        'write-to-worktree': { path: 'x', content: 'y', mode: 'delete' },
      },
    ]),
    opts,
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /mode/.test(e.path)));
});

test('validator: write-to-worktree rejects missing path', () => {
  const result = validateWorkflow(
    baseRoot([{ id: 'bad', 'write-to-worktree': { content: 'y' } }]),
    opts,
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /path/.test(e.path)));
});

// ── 4a.5 — two-discriminator error covers new step kinds ────────────────────

test('validator: attach-to-work-item + bash on same node fails', () => {
  const result = validateWorkflow(
    baseRoot([
      {
        id: 'bad',
        'attach-to-work-item': { workItemId: 'x', name: 'y', content: 'z' },
        bash: 'echo no',
      },
    ]),
    opts,
  );
  assert.equal(result.ok, false);
});

// ── 4a.6 — human-review alias for approval ──────────────────────────────────

test('validator: human-review: alias is accepted and normalized to approval:', () => {
  const result = validateWorkflow(
    baseRoot([
      {
        id: 'gate',
        'human-review': { message: 'OK to proceed?' },
      },
    ]),
    opts,
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const node = result.workflow!.nodes[0]!;
  assert.equal(node.kind, 'approval');
  assert.equal(
    (node as { approval: { message: string } }).approval.message,
    'OK to proceed?',
  );
});

test('validator: legacy approval: still works (no churn for existing workflows)', () => {
  const result = validateWorkflow(
    baseRoot([{ id: 'gate', approval: { message: 'go?' } }]),
    opts,
  );
  assert.equal(result.ok, true);
});

test('validator: both human-review: and approval: present → error', () => {
  const result = validateWorkflow(
    baseRoot([
      {
        id: 'gate',
        'human-review': { message: 'a' },
        approval: { message: 'b' },
      },
    ]),
    opts,
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => /both/.test(e.message)),
    `expected an error about declaring both; got ${JSON.stringify(result.errors)}`,
  );
});

// ── 4a.6 — orchestrator-review step kind ────────────────────────────────────

test('validator: orchestrator-review happy path (prompt only)', () => {
  const result = validateWorkflow(
    baseRoot([
      {
        id: 'orch',
        'orchestrator-review': { prompt: 'Please check $researcher.output.summary' },
      },
    ]),
    opts,
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.workflow!.nodes[0]!.kind, 'orchestrator-review');
});

test('validator: orchestrator-review accepts artifact + on_revise', () => {
  const result = validateWorkflow(
    baseRoot([
      {
        id: 'orch',
        'orchestrator-review': {
          prompt: 'Review this',
          artifact: 'wi-$inputs.wiId',
          on_revise: { prompt: 'Suggest changes here' },
        },
      },
    ]),
    opts,
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('validator: orchestrator-review rejects missing prompt', () => {
  const result = validateWorkflow(
    baseRoot([{ id: 'orch', 'orchestrator-review': { artifact: 'x' } }]),
    opts,
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /prompt/.test(e.path)));
});

test('validator: orchestrator-review rejects empty on_revise.prompt', () => {
  const result = validateWorkflow(
    baseRoot([
      {
        id: 'orch',
        'orchestrator-review': { prompt: 'x', on_revise: { prompt: '' } },
      },
    ]),
    opts,
  );
  assert.equal(result.ok, false);
});

// ── 4a.7 — retry policy on base node ────────────────────────────────────────

test('validator: retry happy path (max_attempts only)', () => {
  const result = validateWorkflow(
    baseRoot([
      { id: 'b', bash: 'echo hi', retry: { max_attempts: 3 } },
    ]),
    opts,
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const node = result.workflow!.nodes[0]!;
  assert.equal(node.retry?.max_attempts, 3);
});

test('validator: retry accepts on + delay_ms', () => {
  const result = validateWorkflow(
    baseRoot([
      {
        id: 'b',
        bash: 'echo hi',
        retry: { max_attempts: 2, on: ['failed', 'timeout'], delay_ms: 500 },
      },
    ]),
    opts,
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const node = result.workflow!.nodes[0]!;
  assert.deepEqual(node.retry?.on, ['failed', 'timeout']);
  assert.equal(node.retry?.delay_ms, 500);
});

test('validator: retry rejects max_attempts: 0', () => {
  const result = validateWorkflow(
    baseRoot([{ id: 'b', bash: 'x', retry: { max_attempts: 0 } }]),
    opts,
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /max_attempts/.test(e.path)));
});

test('validator: retry rejects unknown cause', () => {
  const result = validateWorkflow(
    baseRoot([
      { id: 'b', bash: 'x', retry: { max_attempts: 2, on: ['exploded'] } },
    ]),
    opts,
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /on/.test(e.path) && /exploded/.test(e.message)));
});

test('validator: retry rejects negative delay_ms', () => {
  const result = validateWorkflow(
    baseRoot([
      { id: 'b', bash: 'x', retry: { max_attempts: 2, delay_ms: -1 } },
    ]),
    opts,
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /delay_ms/.test(e.path)));
});

test('validator: no retry block → field absent (no auto-retry default)', () => {
  const result = validateWorkflow(
    baseRoot([{ id: 'b', bash: 'echo hi' }]),
    opts,
  );
  assert.equal(result.ok, true);
  assert.equal(result.workflow!.nodes[0]!.retry, undefined);
});
