import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../src/server.ts';
import type { ToolContext } from '../src/tools/context.ts';
import {
  WORK_ITEM_TOOL_NAMES,
  WORK_ITEM_TOOLS,
  handleWorkItemTool,
} from '../src/tools/work-items.ts';

const expectedWorkItemToolNames = [
  'pc_create_work_item',
  'pc_create_agent_work_item',
  'pc_approve_work_item',
  'pc_reject_work_item',
  'pc_log_bug',
  'pc_move_work_item',
  'pc_update_work_item',
  'pc_get_work_item',
  'pc_list_work_items',
  'pc_attach_to_work_item',
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

test('work item tool names match the pre-split family', () => {
  assert.deepEqual(WORK_ITEM_TOOL_NAMES, expectedWorkItemToolNames);

  const serverToolMap = new Map(TOOLS.map((tool) => [tool.name, tool]));
  for (const tool of WORK_ITEM_TOOLS) {
    assert.deepEqual(serverToolMap.get(tool.name), tool);
  }
});

test('work item handler returns null for unknown tool names', async () => {
  const result = await handleWorkItemTool('pc_write_claude_md', {}, fakeContext());
  assert.equal(result, null);
});

test('work item handler preserves a success content envelope', async () => {
  let requestedPath = '';
  const result = await handleWorkItemTool(
    'pc_list_work_items',
    { stage: 'todo', limit: 3 },
    fakeContext({
      getServer: async (path) => {
        requestedPath = path;
        return { status: 200, body: '{"ok":true,"workItems":[]}' };
      },
    }),
  );

  assert.equal(requestedPath, '/api/projects/proj-1/work-items?stage=todo&limit=3');
  assert.equal(result?.isError, undefined);
  assert.deepEqual(result?.content, [
    { type: 'text', text: '{"ok":true,"workItems":[]}' },
    { type: 'text', text: 'rich-link-hint' },
  ]);
});

test('work item handler preserves an error content envelope', async () => {
  const result = await handleWorkItemTool(
    'pc_create_work_item',
    { title: 'Example' },
    fakeContext({
      postServer: async () => ({ status: 500, body: 'boom' }),
    }),
  );

  assert.equal(result?.isError, true);
  assert.deepEqual(result?.content, [
    { type: 'text', text: 'pc_create_work_item failed (500): boom' },
  ]);
});
