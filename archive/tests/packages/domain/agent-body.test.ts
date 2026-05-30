// Truth table for renderAgentBody (Section 3 / 3f).
//
// Run via:  pnpm --filter @pc/domain test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentBodyTemplateError,
  AGENT_BODY_VARIABLES,
  EXAMPLE_AGENT_BODY_CONTEXT,
  renderAgentBody,
  type AgentBodyContext,
} from '../src/index.ts';

function fullCtx(): AgentBodyContext {
  return {
    input: 'INPUT',
    worktree: '/tmp/wt',
    workflow: { id: 'wr_1' },
    node: { id: 'do-it' },
    project: { name: 'Proj', path: '/p/path' },
    wi: { id: 'wi_1', title: 'TITLE', body: 'WI BODY' },
  };
}

// --- happy path ------------------------------------------------------------

test('no placeholders → body returned verbatim', () => {
  const body = 'Just a plain prompt.\nNo braces here.';
  assert.equal(renderAgentBody(body, fullCtx()), body);
});

test('empty body → empty string', () => {
  assert.equal(renderAgentBody('', fullCtx()), '');
});

test('substitutes {{input}}', () => {
  assert.equal(renderAgentBody('You got: {{input}}', fullCtx()), 'You got: INPUT');
});

test('substitutes {{worktree}}', () => {
  assert.equal(renderAgentBody('Cd to {{worktree}}.', fullCtx()), 'Cd to /tmp/wt.');
});

test('substitutes nested workflow.id and node.id', () => {
  const r = renderAgentBody('run={{workflow.id}} node={{node.id}}', fullCtx());
  assert.equal(r, 'run=wr_1 node=do-it');
});

test('substitutes project.name and project.path', () => {
  const r = renderAgentBody('{{project.name}} at {{project.path}}', fullCtx());
  assert.equal(r, 'Proj at /p/path');
});

test('substitutes wi.id / wi.title / wi.body', () => {
  const r = renderAgentBody('[{{wi.id}}] {{wi.title}}\n{{wi.body}}', fullCtx());
  assert.equal(r, '[wi_1] TITLE\nWI BODY');
});

test('same placeholder used multiple times', () => {
  const r = renderAgentBody('{{input}} → {{input}} → {{input}}', fullCtx());
  assert.equal(r, 'INPUT → INPUT → INPUT');
});

test('whitespace inside braces is tolerated', () => {
  const r = renderAgentBody('{{ input }} and {{  wi.title  }}', fullCtx());
  assert.equal(r, 'INPUT and TITLE');
});

test('adjacent placeholders render correctly', () => {
  const r = renderAgentBody('{{input}}{{worktree}}', fullCtx());
  assert.equal(r, 'INPUT/tmp/wt');
});

test('substitutes empty-string values without complaint', () => {
  const ctx = fullCtx();
  ctx.input = '';
  assert.equal(renderAgentBody('[{{input}}]', ctx), '[]');
});

test('EXAMPLE_AGENT_BODY_CONTEXT renders every recognized variable', () => {
  const body = AGENT_BODY_VARIABLES.map((v) => `{{${v}}}`).join('\n');
  // Must not throw; every variable must resolve to a non-empty string.
  const out = renderAgentBody(body, EXAMPLE_AGENT_BODY_CONTEXT);
  assert.ok(!out.includes('{{'), 'no unresolved placeholders remain');
  assert.ok(!out.includes('}}'), 'no unresolved placeholders remain');
});

// --- error paths -----------------------------------------------------------

test('unknown variable → throws AgentBodyTemplateError with unknown reason', () => {
  let caught: unknown;
  try {
    renderAgentBody('Hi {{bogus}}', fullCtx());
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof AgentBodyTemplateError);
  const err = caught as AgentBodyTemplateError;
  assert.equal(err.issues.length, 1);
  assert.equal(err.issues[0].variable, 'bogus');
  assert.equal(err.issues[0].reason, 'unknown');
  assert.match(err.message, /unknown variable \{\{bogus\}\}/);
});

test('missing wi context → {{wi.title}} throws missing', () => {
  const ctx: AgentBodyContext = { input: 'x' };
  let caught: unknown;
  try {
    renderAgentBody('Title: {{wi.title}}', ctx);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof AgentBodyTemplateError);
  const err = caught as AgentBodyTemplateError;
  assert.equal(err.issues.length, 1);
  assert.equal(err.issues[0].variable, 'wi.title');
  assert.equal(err.issues[0].reason, 'missing');
});

test('missing worktree → throws missing', () => {
  const ctx: AgentBodyContext = { input: 'x' };
  assert.throws(() => renderAgentBody('Cd {{worktree}}', ctx), AgentBodyTemplateError);
});

test('multiple unresolved placeholders → all reported', () => {
  let caught: unknown;
  try {
    renderAgentBody('{{bogus}} and {{wi.title}} and {{also.bogus}}', { input: 'x' });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof AgentBodyTemplateError);
  const err = caught as AgentBodyTemplateError;
  assert.equal(err.issues.length, 3);
  const variables = err.issues.map((i) => i.variable).sort();
  assert.deepEqual(variables, ['also.bogus', 'bogus', 'wi.title']);
});

test('issue carries the source-position of the {{', () => {
  let caught: unknown;
  try {
    renderAgentBody('xxx {{wi.title}}', { input: 'x' });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof AgentBodyTemplateError);
  const err = caught as AgentBodyTemplateError;
  assert.equal(err.issues[0].position, 4);
});

test('single-brace text is not treated as a placeholder', () => {
  const body = '{ just one brace } and { another }';
  assert.equal(renderAgentBody(body, fullCtx()), body);
});

test('escaped-looking content w/o matching braces is left alone', () => {
  // A solitary `{{` with no closing `}}` should not match.
  const body = 'partial {{ not closed here';
  assert.equal(renderAgentBody(body, fullCtx()), body);
});
