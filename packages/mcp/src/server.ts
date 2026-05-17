// Per-project MCP server. Spawned by each project's claude.exe via its
// .mcp.json. Tools are scoped to PC_PROJECT_ID — set by the per-project config
// at substitution time. All work-item / workflow / worktree calls shim through
// to apps/server's project-scoped HTTP API so dispatch logic stays in one place.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// packages/mcp/src/server.ts → trunk root is three levels up. Used as the
// fallback data dir; PC_DATA_DIR override wins.
const ROOT = resolve(__dirname, '..', '..', '..');
const DATA = process.env.PC_DATA_DIR ? resolve(process.env.PC_DATA_DIR) : resolve(ROOT, 'data');
const PROJECT_ID = process.env.PC_PROJECT_ID ?? '';
const SERVER_PORT = Number(process.env.PC_SERVER_PORT ?? 4040);

// Per-project log + heartbeat — keep each project's MCP signals isolated.
const PROJECT_DATA = PROJECT_ID ? resolve(DATA, 'projects', PROJECT_ID) : DATA;
const LOG = resolve(PROJECT_DATA, 'mcp-log.jsonl');
const STATUS = resolve(PROJECT_DATA, 'mcp-status.json');

const TOOLS = [
  {
    name: 'pc_log',
    description:
      'Append a line to data/mcp-log.jsonl. Use when the user asks you to log via MCP.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'message body to append' },
      },
      required: ['message'],
    },
  },
  {
    name: 'pc_create_worktree',
    description:
      'Create a git worktree as a sibling of the workspace dir. Branch name = worktree name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'worktree + branch name (alnum, dash, dot, underscore only)',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'pc_list_worktrees',
    description: 'List all git worktrees attached to the workspace repo.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pc_destroy_worktree',
    description:
      'Remove a worktree. Pass either an absolute path or the bare name (resolved under ../worktrees/).',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'worktree name or absolute path' },
        force: { type: 'boolean', description: 'pass --force to git worktree remove' },
      },
      required: ['target'],
    },
  },
  {
    name: 'pc_create_work_item',
    description:
      'Create a new work item in the given stage. Returns the new WorkItem with its generated ULID id. Use this when the user asks for a fresh card / task / item; do not seed one via pc_update_work_item.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'short title for the work item' },
        stageId: {
          type: 'string',
          description: 'destination stage id (slug, e.g. "draft" / "review" / "done")',
        },
        body: { type: 'string', description: 'optional free-form body / spec' },
      },
      required: ['title', 'stageId'],
    },
  },
  {
    name: 'pc_move_work_item',
    description:
      'Move a work item to a different stage. If a workflow has `triggers.on_enter: { stage_id: <toStage> }`, that workflow fires automatically against the bound wi-<id> worktree.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'work item id (ULID)' },
        toStage: { type: 'string', description: 'destination stage id' },
      },
      required: ['id', 'toStage'],
    },
  },
  {
    name: 'pc_update_work_item',
    description:
      'Admin only — manually merge fields into a work item.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'work item id' },
        fields: {
          type: 'object',
          description: 'fields to merge into workItem.fields (shallow merge)',
          additionalProperties: true,
        },
      },
      required: ['id', 'fields'],
    },
  },
  {
    name: 'pc_complete_node',
    description:
      'Close a single workflow node as successful. The orchestrator delegated you via Task with a prompt carrying [workflowRunId: <id>] and [nodeId: <id>] tokens — pass both verbatim. `output` is whatever payload your node should publish; later nodes reference it as `$<this-node-id>.output[.field]`. The runtime re-ticks the workflow on success so downstream nodes fire. Returns { ok: true } on success or { ok: false, error } if the run or node id is unknown / already closed.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowRunId: {
          type: 'string',
          description: 'opaque id from the channel prompt (look for "[workflowRunId: <id>]")',
        },
        nodeId: {
          type: 'string',
          description: 'opaque id from the channel prompt (look for "[nodeId: <id>]")',
        },
        output: {
          type: 'object',
          description: 'Output payload to publish under this node id.',
          additionalProperties: true,
        },
      },
      required: ['workflowRunId', 'nodeId', 'output'],
    },
  },
  {
    name: 'pc_node_failed',
    description:
      'Close a single workflow node as failed. Pass workflowRunId + nodeId from the channel prompt tokens, plus a short reason string. The runtime re-ticks; downstream nodes with trigger_rule "all_success" become unreachable and get skipped. Use this when you cannot produce the contracted output — e.g. the input was malformed, the worktree is missing required files, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowRunId: {
          type: 'string',
          description: 'opaque id from the channel prompt (look for "[workflowRunId: <id>]")',
        },
        nodeId: {
          type: 'string',
          description: 'opaque id from the channel prompt (look for "[nodeId: <id>]")',
        },
        reason: {
          type: 'string',
          description: 'one-line failure reason — shown in the UI on the failed run.',
        },
      },
      required: ['workflowRunId', 'nodeId', 'reason'],
    },
  },
  {
    name: 'pc_run_workflow',
    description:
      'Start a fresh run of a callable workflow. `name` is the workflow id (matches the workflow file basename + the workflow YAML\'s `id:` field). `input` is an optional object passed through to the run as `run.inputs`. The workflow must declare `triggers.callable: true`. The run executes in its own `run-<short>` worktree (siblings of the workspace). Returns the new WorkflowRun or { ok: false, error } when the workflow is unknown, ambiguous, invalid, or not callable.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'workflow id (matches the file basename)' },
        input: {
          type: 'object',
          description: 'optional inputs object — referenceable in the workflow as $inputs.<key> once that substitution lands; passes through to run.inputs today.',
          additionalProperties: true,
        },
      },
      required: ['name'],
    },
  },
] as const;

function projectPath(suffix: string): string {
  if (!PROJECT_ID) throw new Error('PC_PROJECT_ID is required for project-scoped calls');
  return `/api/projects/${PROJECT_ID}/${suffix.replace(/^\//, '')}`;
}

async function postServer(
  path: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((res, rej) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: SERVER_PORT,
        method: 'POST',
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c as Buffer));
        r.on('end', () =>
          res({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }),
        );
      },
    );
    req.on('error', rej);
    req.write(payload);
    req.end();
  });
}

async function getServer(path: string): Promise<{ status: number; body: string }> {
  return new Promise((res, rej) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: SERVER_PORT, method: 'GET', path },
      (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c as Buffer));
        r.on('end', () =>
          res({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }),
        );
      },
    );
    req.on('error', rej);
    req.end();
  });
}

function writeStatus() {
  try {
    mkdirSync(DATA, { recursive: true });
    writeFileSync(
      STATUS,
      JSON.stringify(
        {
          pid: process.pid,
          startedAt: new Date().toISOString(),
          aliveAt: new Date().toISOString(),
          tools: TOOLS.map((t) => t.name),
          toolCount: TOOLS.length,
        },
        null,
        2,
      ),
    );
  } catch {
    /* status file is best-effort */
  }
}

function heartbeat() {
  try {
    mkdirSync(DATA, { recursive: true });
    writeFileSync(
      STATUS,
      JSON.stringify(
        {
          pid: process.pid,
          aliveAt: new Date().toISOString(),
          tools: TOOLS.map((t) => t.name),
          toolCount: TOOLS.length,
        },
        null,
        2,
      ),
    );
  } catch {
    /* best-effort */
  }
}

const server = new Server(
  { name: 'pc-rig', version: '0.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS as unknown as typeof TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  switch (req.params.name) {
    case 'pc_log': {
      const message = typeof args.message === 'string' ? args.message : String(args.message ?? '');
      try {
        mkdirSync(dirname(LOG), { recursive: true });
        appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), message }) + '\n');
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_log failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: `logged: ${message}` }] };
    }

    case 'pc_create_worktree': {
      const name = typeof args.name === 'string' ? args.name : '';
      if (!name) {
        return { content: [{ type: 'text', text: 'pc_create_worktree: name required' }], isError: true };
      }
      try {
        const res = await postServer(projectPath('worktrees/create'), { name });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_create_worktree failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_create_worktree failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_list_worktrees': {
      try {
        const res = await getServer(projectPath('worktrees'));
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_list_worktrees failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_list_worktrees failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_create_work_item': {
      const title = typeof args.title === 'string' ? args.title : '';
      const stageId = typeof args.stageId === 'string' ? args.stageId : '';
      const bodyText = typeof args.body === 'string' ? args.body : undefined;
      if (!title || !stageId) {
        return {
          content: [{ type: 'text', text: 'pc_create_work_item: title and stageId required' }],
          isError: true,
        };
      }
      try {
        const res = await postServer(projectPath('work-items/create'), {
          title,
          stageId,
          ...(bodyText ? { body: bodyText } : {}),
        });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_create_work_item failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_create_work_item failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_move_work_item': {
      const id = typeof args.id === 'string' ? args.id : '';
      const toStage = typeof args.toStage === 'string' ? args.toStage : '';
      if (!id || !toStage) {
        return { content: [{ type: 'text', text: 'pc_move_work_item: id and toStage required' }], isError: true };
      }
      try {
        const res = await postServer(projectPath('work-items/move'), { id, toStage });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return { content: [{ type: 'text', text: `pc_move_work_item failed (${res.status}): ${res.body}` }], isError: true };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_move_work_item failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_update_work_item': {
      const id = typeof args.id === 'string' ? args.id : '';
      const fields = args.fields && typeof args.fields === 'object' ? args.fields : null;
      if (!id || !fields) {
        return { content: [{ type: 'text', text: 'pc_update_work_item: id and fields required' }], isError: true };
      }
      try {
        const res = await postServer(projectPath('work-items/update'), { id, fields });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return { content: [{ type: 'text', text: `pc_update_work_item failed (${res.status}): ${res.body}` }], isError: true };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_update_work_item failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_complete_node': {
      const workflowRunId = typeof args.workflowRunId === 'string' ? args.workflowRunId : '';
      const nodeId = typeof args.nodeId === 'string' ? args.nodeId : '';
      const output = args.output && typeof args.output === 'object' ? args.output : null;
      if (!workflowRunId || !nodeId || !output) {
        return {
          content: [
            { type: 'text', text: 'pc_complete_node: workflowRunId, nodeId, and output required' },
          ],
          isError: true,
        };
      }
      try {
        const res = await postServer(projectPath('workflow/node-complete'), {
          workflowRunId,
          nodeId,
          output,
        });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_complete_node failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_complete_node failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_node_failed': {
      const workflowRunId = typeof args.workflowRunId === 'string' ? args.workflowRunId : '';
      const nodeId = typeof args.nodeId === 'string' ? args.nodeId : '';
      const reason = typeof args.reason === 'string' ? args.reason : '';
      if (!workflowRunId || !nodeId || !reason) {
        return {
          content: [
            { type: 'text', text: 'pc_node_failed: workflowRunId, nodeId, and reason required' },
          ],
          isError: true,
        };
      }
      try {
        const res = await postServer(projectPath('workflow/node-failed'), {
          workflowRunId,
          nodeId,
          reason,
        });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_node_failed failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_node_failed failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_run_workflow': {
      const name = typeof args.name === 'string' ? args.name : '';
      const input = args.input && typeof args.input === 'object' ? args.input : undefined;
      if (!name) {
        return { content: [{ type: 'text', text: 'pc_run_workflow: name required' }], isError: true };
      }
      try {
        const res = await postServer(projectPath('workflow/run'), { name, input });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_run_workflow failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_run_workflow failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_destroy_worktree': {
      const target = typeof args.target === 'string' ? args.target : '';
      const force = args.force === true;
      if (!target) {
        return { content: [{ type: 'text', text: 'pc_destroy_worktree: target required' }], isError: true };
      }
      try {
        const res = await postServer(projectPath('worktrees/destroy'), { target, force });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: `destroyed worktree ${target}` }] };
        }
        return {
          content: [{ type: 'text', text: `pc_destroy_worktree failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_destroy_worktree failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`unknown tool: ${req.params.name}`);
  }
});

writeStatus();
const heartbeatTimer = setInterval(heartbeat, 2000);
heartbeatTimer.unref?.();

await server.connect(new StdioServerTransport());
