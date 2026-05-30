import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../src/server.ts';
import type { ToolContext } from '../src/tools/context.ts';
import { AGENT_TOOL_NAMES, AGENT_TOOLS, handleAgentTool } from '../src/tools/agents.ts';

const expectedAgentToolNames = [
  'pc_create_agent',
  'pc_get_agent',
  'pc_update_agent_prompt',
  'pc_update_agent_settings',
  'pc_delete_agent',
  'pc_create_knowledge',
  'pc_update_knowledge',
  'pc_delete_knowledge',
  'pc_knowledge_read',
  'pc_create_agent_secret',
  'pc_delete_agent_secret',
  'pc_add_agent_mcp_server',
  'pc_delete_agent_mcp_server',
  'pc_list_agent_audit',
  'pc_list_agents',
];

function fakeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    projectId: 'proj-1',
    agentSessionId: 'agent-session-1',
    sessionId: 'session-1',
    dispatcherSessionId: 'dispatcher-session-1',
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

test('agent tool names match the pre-split family', () => {
  assert.deepEqual(AGENT_TOOL_NAMES, expectedAgentToolNames);

  const serverToolMap = new Map(TOOLS.map((tool) => [tool.name, tool]));
  for (const tool of AGENT_TOOLS) {
    assert.deepEqual(serverToolMap.get(tool.name), tool);
  }
});

test('agent handler returns null for unknown tool names', async () => {
  const result = await handleAgentTool('pc_log_bug', {}, fakeContext());
  assert.equal(result, null);
});

test('agent handler preserves a success content envelope', async () => {
  let requestedPath = '';
  const result = await handleAgentTool(
    'pc_get_agent',
    { id: 'pod-1' },
    fakeContext({
      getServer: async (path) => {
        requestedPath = path;
        return { status: 200, body: '{"ok":true,"pod":{"id":"pod-1"}}' };
      },
    }),
  );

  assert.equal(requestedPath, '/api/agents/pods/pod-1');
  assert.equal(result?.isError, undefined);
  assert.deepEqual(result?.content, [
    { type: 'text', text: '{"ok":true,"pod":{"id":"pod-1"}}' },
  ]);
});

test('agent handler preserves an error content envelope', async () => {
  const result = await handleAgentTool(
    'pc_create_agent',
    { name: 'research-helper' },
    fakeContext({
      postServer: async () => ({ status: 500, body: 'boom' }),
    }),
  );

  assert.equal(result?.isError, true);
  assert.deepEqual(result?.content, [
    { type: 'text', text: 'pc_create_agent failed (500): boom' },
  ]);
});
