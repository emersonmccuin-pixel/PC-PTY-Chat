import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../src/server.ts';
import type { ToolContext } from '../src/tools/context.ts';
import {
  AGENT_RUN_TOOL_NAMES,
  AGENT_RUN_TOOLS,
  handleAgentRunTool,
} from '../src/tools/agent-runs.ts';

const expectedAgentRunToolNames = [
  'pc_invoke_agent',
  'pc_continue_agent',
  'pc_list_my_runs',
  'pc_ask_orchestrator',
  'pc_ask_user',
  'pc_request_approval',
  'pc_answer_pending',
];

function fakeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    projectId: 'proj-1',
    agentSessionId: 'agent-session-1',
    sessionId: 'session-1',
    dispatcherSessionId: 'dispatcher-session-1',
    agentRunId: 'run-1',
    agentParentWorkItemId: 'parent-wi-1',
    agentInvokeDepth: 2,
    projectPath: (suffix) => `/api/projects/proj-1/${suffix.replace(/^\//, '')}`,
    postServer: async () => ({ status: 200, body: '{"ok":true}' }),
    putServer: async () => ({ status: 200, body: '{"ok":true}' }),
    getServer: async () => ({ status: 200, body: '{"ok":true}' }),
    patchServer: async () => ({ status: 200, body: '{"ok":true}' }),
    deleteServer: async () => ({ status: 200, body: '{"ok":true}' }),
    resolveWorkItemIdViaServer: async (ref) => ref,
    withRichLinkHint: (text) => ({
      content: [{ type: 'text', text }, { type: 'text', text: 'rich-link-hint' }],
    }),
    ...overrides,
  };
}

test('agent run tool names match the pre-split family', () => {
  assert.deepEqual(AGENT_RUN_TOOL_NAMES, expectedAgentRunToolNames);

  const serverToolMap = new Map(TOOLS.map((tool) => [tool.name, tool]));
  for (const tool of AGENT_RUN_TOOLS) {
    assert.deepEqual(serverToolMap.get(tool.name), tool);
  }
});

test('agent run handler returns null for unknown tool names', async () => {
  const result = await handleAgentRunTool('pc_log_bug', {}, fakeContext());
  assert.equal(result, null);
});

test('agent run handler preserves a success content envelope', async () => {
  let requestedPath = '';
  let requestedBody: unknown = null;
  const result = await handleAgentRunTool(
    'pc_invoke_agent',
    { name: 'researcher', input: 'Begin.', workItemId: 'wi-1' },
    fakeContext({
      postServer: async (path, body) => {
        requestedPath = path;
        requestedBody = body;
        return { status: 200, body: '{"ok":true,"runId":"run-1"}' };
      },
    }),
  );

  assert.equal(requestedPath, '/api/projects/proj-1/agents/researcher/invoke');
  assert.deepEqual(requestedBody, {
    input: 'Begin.',
    parentInvokeDepth: 2,
    dispatcherSessionId: 'dispatcher-session-1',
    parentWorkItemId: 'parent-wi-1',
    workItemId: 'wi-1',
  });
  assert.equal(result?.isError, undefined);
  assert.deepEqual(result?.content, [
    { type: 'text', text: '{"ok":true,"runId":"run-1"}' },
  ]);
});

test('agent run handler preserves an error content envelope', async () => {
  const result = await handleAgentRunTool(
    'pc_continue_agent',
    { runId: 'run-1', input: 'Try again.' },
    fakeContext({
      postServer: async () => ({ status: 500, body: 'boom' }),
    }),
  );

  assert.equal(result?.isError, true);
  assert.deepEqual(result?.content, [
    { type: 'text', text: 'pc_continue_agent failed (500): boom' },
  ]);
});
