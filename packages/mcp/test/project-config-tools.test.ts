import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../src/server.ts';
import type { ToolContext } from '../src/tools/context.ts';
import {
  PROJECT_CONFIG_TOOL_NAMES,
  PROJECT_CONFIG_TOOLS,
  handleProjectConfigTool,
} from '../src/tools/project-config.ts';

const expectedProjectConfigToolNames = [
  'pc_get_stages',
  'pc_write_claude_md',
  'pc_list_stages',
  'pc_list_field_schemas',
  'pc_replace_stages',
  'pc_replace_field_schemas',
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

test('project config tool names match the pre-split family', () => {
  assert.deepEqual(PROJECT_CONFIG_TOOL_NAMES, expectedProjectConfigToolNames);

  const serverToolMap = new Map(TOOLS.map((tool) => [tool.name, tool]));
  for (const tool of PROJECT_CONFIG_TOOLS) {
    assert.deepEqual(serverToolMap.get(tool.name), tool);
  }
});

test('project config handler returns null for unknown tool names', async () => {
  const result = await handleProjectConfigTool('pc_log_bug', {}, fakeContext());
  assert.equal(result, null);
});

test('project config handler preserves a success content envelope', async () => {
  let requestedPath = '';
  const result = await handleProjectConfigTool(
    'pc_list_stages',
    {},
    fakeContext({
      getServer: async (path) => {
        requestedPath = path;
        return {
          status: 200,
          body: '{"stages":[{"id":"todo","name":"Todo","order":1,"isNew":true}]}',
        };
      },
    }),
  );

  assert.equal(requestedPath, '/api/projects/proj-1');
  assert.equal(result?.isError, undefined);
  assert.deepEqual(result?.content, [
    {
      type: 'text',
      text: '{"ok":true,"stages":[{"id":"todo","name":"Todo","order":1,"isNew":true}]}',
    },
  ]);
});

test('project config handler preserves an error content envelope', async () => {
  const result = await handleProjectConfigTool(
    'pc_replace_stages',
    { stages: [{ id: 'todo', name: 'Todo' }] },
    fakeContext({
      patchServer: async () => ({ status: 409, body: 'STAGE_HAS_ITEMS' }),
    }),
  );

  assert.equal(result?.isError, true);
  assert.deepEqual(result?.content, [
    { type: 'text', text: 'pc_replace_stages failed (409): STAGE_HAS_ITEMS' },
  ]);
});
