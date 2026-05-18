// 4a.3 — lock the on-disk generic-agent-runner.yaml template against
// regressions. Pin: (a) the file parses + validates under the canonical
// workflow id, (b) the dispatch node uses the new `agent: $inputs.<key>`
// surface, (c) prompt body uses `$inputs.prompt`. These three shape
// guarantees together prove the template can dispatch through the 4a.1 +
// 4a.2 plumbing — anything else is workflow-runtime / channel territory and
// is covered by the dispatcher's own unit + smoke tests.
//
// Run via:  pnpm --filter @pc/workflows test
// Or:       pnpm test:unit  (from repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseWorkflowText } from '../src/validator.ts';

const here = fileURLToPath(import.meta.url);
const templatePath = resolve(
  here,
  '..',
  '..',
  '..',
  '..',
  'templates',
  '.project-companion',
  'workflows',
  'generic-agent-runner.yaml',
);

test('generic-agent-runner.yaml: parses + validates', () => {
  const text = readFileSync(templatePath, 'utf-8');
  const result = parseWorkflowText(text, { expectedId: 'generic-agent-runner' });
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.equal(result.workflow!.id, 'generic-agent-runner');
});

test('generic-agent-runner.yaml: callable trigger', () => {
  const text = readFileSync(templatePath, 'utf-8');
  const result = parseWorkflowText(text, { expectedId: 'generic-agent-runner' });
  assert.equal(result.workflow!.triggers?.callable, true);
});

test('generic-agent-runner.yaml: dispatch node uses $inputs.agent + $inputs.prompt', () => {
  const text = readFileSync(templatePath, 'utf-8');
  const result = parseWorkflowText(text, { expectedId: 'generic-agent-runner' });
  const node = result.workflow!.nodes[0]!;
  assert.equal(node.kind, 'subagent');
  assert.equal((node as { subagent: string }).subagent, '$inputs.agent');
  assert.match((node as { prompt: string }).prompt, /\$inputs\.prompt/);
});

test('generic-agent-runner.yaml: header no longer claims "NOT YET FUNCTIONAL"', () => {
  const text = readFileSync(templatePath, 'utf-8');
  assert.doesNotMatch(text, /NOT YET FUNCTIONAL/);
});
