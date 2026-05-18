// HTTP step dispatcher (4a.4 / D20). Pure async function: takes the node, the
// run, and the substituter; returns a DispatchResult. Extracted from
// WorkflowRuntime so it can be unit-tested against a local server without
// instantiating the full runtime + DB stack.
//
// Substitution is applied at call time to url, headers, and body. `$ENV.*`
// reads process.env directly (per D20 — env-only, no in-app secrets vault).
// `$inputs.*` and `$<stepId>.output.*` also flow through. 4xx/5xx do NOT
// auto-fail the step — the response shape is returned as output and the
// workflow author branches via `when:` or `trigger_rule:`. Network errors,
// DNS failures, and timeouts ARE step failures (no usable response).

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

import type { HttpNode, NodeOutput, WorkflowRun } from '@pc/domain';

export type SubstituteOutputs = (text: string, run: WorkflowRun) => string;

export interface HttpStepResult {
  kind: 'sync';
  output: NodeOutput;
}

export interface HttpResponseOutput {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function runHttpStep(
  node: HttpNode,
  run: WorkflowRun,
  substituteOutputs: SubstituteOutputs,
): Promise<HttpStepResult> {
  const completedAt = () => new Date().toISOString();
  const url = substituteOutputs(node.http.url, run).trim();
  if (!url) {
    return {
      kind: 'sync',
      output: {
        status: 'failed',
        error: `url resolved to empty (raw: "${node.http.url}")`,
        completedAt: completedAt(),
      },
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    return {
      kind: 'sync',
      output: {
        status: 'failed',
        error: `invalid URL after substitution: ${url} (${(err as Error).message})`,
        completedAt: completedAt(),
      },
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      kind: 'sync',
      output: {
        status: 'failed',
        error: `unsupported protocol "${parsed.protocol}" — only http: and https: are allowed`,
        completedAt: completedAt(),
      },
    };
  }

  const headers: Record<string, string> = {};
  if (node.http.headers) {
    for (const [name, raw] of Object.entries(node.http.headers)) {
      headers[name] = substituteOutputs(raw, run);
    }
  }

  const bodyText =
    node.http.body !== undefined ? substituteOutputs(node.http.body, run) : undefined;
  if (bodyText !== undefined && !('content-length' in headersLower(headers))) {
    headers['Content-Length'] = String(Buffer.byteLength(bodyText));
  }

  const timeoutMs = node.http.timeout ?? node.timeout ?? DEFAULT_TIMEOUT_MS;
  const requestFn = parsed.protocol === 'https:' ? httpsRequest : httpRequest;

  return await new Promise<HttpStepResult>((resolve) => {
    let settled = false;
    const settle = (result: HttpStepResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = requestFn(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        method: node.http.method,
        path: `${parsed.pathname}${parsed.search}`,
        headers,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          const output: HttpResponseOutput = {
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
          };
          settle({
            kind: 'sync',
            output: {
              status: 'complete',
              output,
              completedAt: completedAt(),
            },
          });
        });
        res.on('error', (err: Error) => {
          settle({
            kind: 'sync',
            output: {
              status: 'failed',
              error: `response stream error: ${err.message}`,
              completedAt: completedAt(),
            },
          });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout (${timeoutMs}ms exceeded)`));
    });

    req.on('error', (err: Error) => {
      settle({
        kind: 'sync',
        output: {
          status: 'failed',
          error: err.message,
          completedAt: completedAt(),
        },
      });
    });

    if (bodyText !== undefined) req.write(bodyText);
    req.end();
  });
}

function headersLower(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}
