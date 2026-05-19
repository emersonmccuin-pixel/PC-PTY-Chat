// Unit tests for the http-step dispatcher (4a.4 / D20). Spins up a real
// node:http server on an ephemeral port and exercises the dispatcher end-to-
// end against it: happy paths, 4xx/5xx (which must NOT auto-fail the step —
// downstream `when:` decides), timeout (which IS a step failure), env-var
// + input-var interpolation, body POST + content-length.
//
// The dispatcher itself is the pure `runHttpStep` function so we don't have
// to instantiate WorkflowRuntime + the DB stack for this coverage.
//
// Run via:  pnpm --filter @pc/server test
// Or:       pnpm test:unit  (from repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { HttpNode, WorkflowRun } from '@pc/domain';

import { runHttpStep } from '../src/services/http-step.ts';
import { substituteOutputs } from '../src/services/output-substitution.ts';
import type { SubstituteTemplate } from '../src/services/typed-substitution.ts';

/** Test-only: adapt the legacy regex substituter to the post-4h.9
 *  SubstituteTemplate signature so we can keep the $X.Y test fixtures
 *  without rebuilding edge maps per case. */
function legacyTmpl(run: WorkflowRun): SubstituteTemplate {
  return (text) => substituteOutputs(text, run);
}

interface Capture {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: string;
}

function startTestServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
  server: Server;
  port: number;
}> {
  return new Promise((resolveStart, rejectStart) => {
    const server = createServer(handler);
    server.on('error', rejectStart);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolveStart({ server, port: addr.port });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((res) => server.close(() => res()));
}

function mkRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-http',
    workflowId: 'wf-http',
    workflowYamlSnapshot: '',
    status: 'in-progress',
    startedAt: new Date().toISOString(),
    worktreePath: null,
    nodeOutputs: {},
    ...overrides,
  };
}

function mkHttp(http: HttpNode['http'], id = 'fetch'): HttpNode {
  return { id, kind: 'http', http };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
  return Buffer.concat(chunks).toString('utf-8');
}

test('runHttpStep: 200 OK with JSON-shaped body returns body + status', async () => {
  const { server, port } = await startTestServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end('{"ok":true,"n":1}');
  });
  try {
    const node = mkHttp({ method: 'GET', url: `http://127.0.0.1:${port}/x` });
    const result = await runHttpStep(node, mkRun(), legacyTmpl(mkRun()));
    assert.equal(result.output.status, 'complete');
    const out = result.output.output as { status: number; body: string };
    assert.equal(out.status, 200);
    assert.equal(out.body, '{"ok":true,"n":1}');
  } finally {
    await stopServer(server);
  }
});

test('runHttpStep: 404 does NOT auto-fail (status:complete, downstream decides)', async () => {
  const { server, port } = await startTestServer((_req, res) => {
    res.statusCode = 404;
    res.end('not found');
  });
  try {
    const node = mkHttp({ method: 'GET', url: `http://127.0.0.1:${port}/missing` });
    const result = await runHttpStep(node, mkRun(), legacyTmpl(mkRun()));
    assert.equal(result.output.status, 'complete', 'step succeeded; response is the artifact');
    const out = result.output.output as { status: number; body: string };
    assert.equal(out.status, 404);
    assert.equal(out.body, 'not found');
  } finally {
    await stopServer(server);
  }
});

test('runHttpStep: 500 does NOT auto-fail', async () => {
  const { server, port } = await startTestServer((_req, res) => {
    res.statusCode = 500;
    res.end('boom');
  });
  try {
    const node = mkHttp({ method: 'GET', url: `http://127.0.0.1:${port}/break` });
    const result = await runHttpStep(node, mkRun(), legacyTmpl(mkRun()));
    assert.equal(result.output.status, 'complete');
    const out = result.output.output as { status: number };
    assert.equal(out.status, 500);
  } finally {
    await stopServer(server);
  }
});

test('runHttpStep: timeout aborts and step fails', async () => {
  let serverSawRequest = false;
  const { server, port } = await startTestServer((_req, res) => {
    serverSawRequest = true;
    // Never respond — let the client time out.
    void res;
  });
  try {
    const node = mkHttp({
      method: 'GET',
      url: `http://127.0.0.1:${port}/slow`,
      timeout: 75,
    });
    const result = await runHttpStep(node, mkRun(), legacyTmpl(mkRun()));
    assert.equal(result.output.status, 'failed');
    assert.match(result.output.error ?? '', /timeout/i);
    assert.equal(serverSawRequest, true, 'request reached the server before we timed out');
  } finally {
    await stopServer(server);
  }
});

test('runHttpStep: connection refused → step fails', async () => {
  // No server on this port (well, very unlikely on 127.0.0.1:1).
  const node = mkHttp({ method: 'GET', url: 'http://127.0.0.1:1/' });
  const result = await runHttpStep(node, mkRun(), legacyTmpl(mkRun()));
  assert.equal(result.output.status, 'failed');
});

test('runHttpStep: $ENV.* interpolation in headers + url', async () => {
  const captured: Capture = {};
  const { server, port } = await startTestServer(async (req, res) => {
    captured.method = req.method;
    captured.url = req.url;
    captured.headers = req.headers;
    res.statusCode = 204;
    res.end();
  });
  const TOKEN_KEY = '__PC_TEST_HTTP_TOKEN';
  const PATH_KEY = '__PC_TEST_HTTP_PATH';
  const priorToken = process.env[TOKEN_KEY];
  const priorPath = process.env[PATH_KEY];
  process.env[TOKEN_KEY] = 'sek-123';
  process.env[PATH_KEY] = 'items';
  try {
    const node = mkHttp({
      method: 'GET',
      url: `http://127.0.0.1:${port}/api/$ENV.${PATH_KEY}`,
      headers: { Authorization: `Bearer $ENV.${TOKEN_KEY}` },
    });
    const result = await runHttpStep(node, mkRun(), legacyTmpl(mkRun()));
    assert.equal(result.output.status, 'complete');
    assert.equal(captured.url, '/api/items');
    assert.equal(captured.headers!.authorization, 'Bearer sek-123');
  } finally {
    if (priorToken === undefined) delete process.env[TOKEN_KEY]; else process.env[TOKEN_KEY] = priorToken;
    if (priorPath === undefined) delete process.env[PATH_KEY]; else process.env[PATH_KEY] = priorPath;
    await stopServer(server);
  }
});

test('runHttpStep: $inputs.* interpolation in url + body', async () => {
  const captured: Capture = {};
  const { server, port } = await startTestServer(async (req, res) => {
    captured.url = req.url;
    captured.body = await readBody(req);
    res.statusCode = 201;
    res.end('{"id":"new"}');
  });
  try {
    const node = mkHttp({
      method: 'POST',
      url: `http://127.0.0.1:${port}/widgets/$inputs.tenant`,
      headers: { 'Content-Type': 'application/json' },
      body: '{"name":"$inputs.name"}',
    });
    const run = mkRun({ inputs: { tenant: 'acme', name: 'gizmo' } });
    const result = await runHttpStep(node, run, legacyTmpl(run));
    assert.equal(result.output.status, 'complete');
    assert.equal(captured.url, '/widgets/acme');
    assert.equal(captured.body, '{"name":"gizmo"}');
  } finally {
    await stopServer(server);
  }
});

test('runHttpStep: POST body sets Content-Length when not supplied', async () => {
  const captured: Capture = {};
  const { server, port } = await startTestServer(async (req, res) => {
    captured.headers = req.headers;
    captured.body = await readBody(req);
    res.statusCode = 200;
    res.end();
  });
  try {
    const node = mkHttp({
      method: 'POST',
      url: `http://127.0.0.1:${port}/`,
      body: 'hello',
    });
    const result = await runHttpStep(node, mkRun(), legacyTmpl(mkRun()));
    assert.equal(result.output.status, 'complete');
    assert.equal(captured.headers!['content-length'], '5');
    assert.equal(captured.body, 'hello');
  } finally {
    await stopServer(server);
  }
});

test('runHttpStep: unsupported protocol fails fast (no network)', async () => {
  const node = mkHttp({ method: 'GET', url: 'file:///etc/passwd' });
  const result = await runHttpStep(node, mkRun(), legacyTmpl(mkRun()));
  assert.equal(result.output.status, 'failed');
  assert.match(result.output.error ?? '', /protocol/i);
});

test('runHttpStep: empty-resolved url fails fast', async () => {
  const node = mkHttp({ method: 'GET', url: '$inputs.endpoint' });
  // No `endpoint` in inputs.
  const result = await runHttpStep(node, mkRun(), legacyTmpl(mkRun()));
  assert.equal(result.output.status, 'failed');
  assert.match(result.output.error ?? '', /url resolved to empty/i);
});
