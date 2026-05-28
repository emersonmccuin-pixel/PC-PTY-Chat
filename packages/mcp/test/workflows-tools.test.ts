import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../src/server.ts';
import type { ToolContext } from '../src/tools/context.ts';
import {
  WORKFLOW_TOOL_NAMES,
  WORKFLOW_TOOLS,
  handleWorkflowTool,
} from '../src/tools/workflows.ts';

const expectedWorkflowToolNames = [
  'pc_save_workflow_draft',
  'pc_read_workflow_draft',
  'pc_publish_workflow',
  'pc_list_workflows',
  'pc_fire_workflow',
  'pc_complete_node',
  'pc_node_failed',
  'pc_create_workflow',
  'pc_update_workflow',
  'pc_delete_workflow',
  'pc_get_workflow',
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

test('workflow tool names match the pre-split family', () => {
  assert.deepEqual(WORKFLOW_TOOL_NAMES, expectedWorkflowToolNames);

  const serverToolMap = new Map(TOOLS.map((tool) => [tool.name, tool]));
  for (const tool of WORKFLOW_TOOLS) {
    assert.deepEqual(serverToolMap.get(tool.name), tool);
  }
});

test('workflow handler returns null for unknown tool names', async () => {
  const result = await handleWorkflowTool('pc_log_bug', {}, fakeContext());
  assert.equal(result, null);
});

test('workflow handler preserves a success content envelope', async () => {
  let requestedPath = '';
  const result = await handleWorkflowTool(
    'pc_list_workflows',
    {},
    fakeContext({
      getServer: async (path) => {
        requestedPath = path;
        return { status: 200, body: '{"ok":true,"workflows":[]}' };
      },
    }),
  );

  assert.equal(requestedPath, '/api/workflows?projectId=proj-1');
  assert.equal(result?.isError, undefined);
  assert.deepEqual(result?.content, [
    { type: 'text', text: '{"ok":true,"workflows":[]}' },
  ]);
});

test('workflow handler preserves an error content envelope', async () => {
  const result = await handleWorkflowTool(
    'pc_create_workflow',
    { yaml: 'id: example' },
    fakeContext({
      postServer: async () => ({ status: 500, body: 'boom' }),
    }),
  );

  assert.equal(result?.isError, true);
  assert.deepEqual(result?.content, [
    { type: 'text', text: 'pc_create_workflow failed (500): boom' },
  ]);
});
