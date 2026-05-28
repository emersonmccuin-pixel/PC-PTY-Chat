import { request as httpRequest } from 'node:http';

export interface ServerResponse {
  status: number;
  body: string;
}

export interface ToolContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  [key: string]: unknown;
  content: ToolContent[];
  isError?: true;
}

export interface ToolContext {
  projectId: string;
  agentSessionId: string;
  sessionId: string;
  dispatcherSessionId: string;
  agentRunId?: string;
  agentParentWorkItemId?: string;
  agentInvokeDepth?: number;
  projectPath: (suffix: string) => string;
  postServer: (path: string, body: unknown) => Promise<ServerResponse>;
  putServer: (path: string, body: unknown) => Promise<ServerResponse>;
  getServer: (path: string) => Promise<ServerResponse>;
  patchServer: (path: string, body: unknown) => Promise<ServerResponse>;
  deleteServer: (path: string) => Promise<ServerResponse>;
  resolveWorkItemIdViaServer: (idOrCallsign: string) => Promise<string | null>;
  withRichLinkHint: (text: string) => ToolResult;
}

interface ToolContextOptions {
  projectId: string;
  agentSessionId: string;
  sessionId: string;
  dispatcherSessionId: string;
  agentRunId: string;
  agentParentWorkItemId: string;
  agentInvokeDepth: number;
  serverPort: number;
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

const RICH_LINK_HINT =
  '[system formatting reminder] When you mention any of these in your reply, ' +
  'wrap as markdown links: `[<callsign>](pc://work-item/<callsign>)` for work ' +
  'items (use the callsign string, not the ULID), `[<path>](pc://file/<path>)` ' +
  'for files, `[<name>](pc://attachment/<id>)` for attachments. The user can ' +
  'hover + click these pills. Bare text and backticks are unclickable — never ' +
  'use them for these refs. Applies in lists too: every reference in every row.';

function httpWithBody(
  serverPort: number,
  method: 'POST' | 'PUT' | 'PATCH',
  path: string,
  body: unknown,
): Promise<ServerResponse> {
  const payload = JSON.stringify(body);
  return new Promise((res, rej) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: serverPort,
        method,
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

function httpWithoutBody(
  serverPort: number,
  method: 'GET' | 'DELETE',
  path: string,
): Promise<ServerResponse> {
  return new Promise((res, rej) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: serverPort, method, path },
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

export function createToolContext(options: ToolContextOptions): ToolContext {
  const projectPath = (suffix: string): string => {
    if (!options.projectId) throw new Error('PC_PROJECT_ID is required for project-scoped calls');
    return `/api/projects/${options.projectId}/${suffix.replace(/^\//, '')}`;
  };

  const getServer = (path: string) => httpWithoutBody(options.serverPort, 'GET', path);

  const resolveWorkItemIdViaServer = async (idOrCallsign: string): Promise<string | null> => {
    const ref = idOrCallsign.trim();
    if (!ref) return null;
    if (ULID_RE.test(ref)) return ref;
    try {
      const res = await getServer(projectPath(`work-items/${encodeURIComponent(ref)}`));
      if (res.status < 200 || res.status >= 300) return null;
      const parsed = JSON.parse(res.body) as { ok?: boolean; workItem?: { id?: string } };
      return parsed.ok && typeof parsed.workItem?.id === 'string' ? parsed.workItem.id : null;
    } catch {
      return null;
    }
  };

  return {
    projectId: options.projectId,
    agentSessionId: options.agentSessionId,
    sessionId: options.sessionId,
    dispatcherSessionId: options.dispatcherSessionId,
    agentRunId: options.agentRunId,
    agentParentWorkItemId: options.agentParentWorkItemId,
    agentInvokeDepth: options.agentInvokeDepth,
    projectPath,
    postServer: (path, body) => httpWithBody(options.serverPort, 'POST', path, body),
    putServer: (path, body) => httpWithBody(options.serverPort, 'PUT', path, body),
    getServer,
    patchServer: (path, body) => httpWithBody(options.serverPort, 'PATCH', path, body),
    deleteServer: (path) => httpWithoutBody(options.serverPort, 'DELETE', path),
    resolveWorkItemIdViaServer,
    withRichLinkHint: (text) => ({
      content: [{ type: 'text', text }, { type: 'text', text: RICH_LINK_HINT }],
    }),
  };
}
