import { createInterface } from 'node:readline';

import type { AgentHostCommand } from '@pc/runtime';

import { AgentHostService } from './agent-host-service.ts';
import { startHttpAgentHostServer } from './http-server.ts';

type WireId = string | number;

interface WireRequest {
  id?: WireId;
  command: AgentHostCommand;
}

const httpLockFile = optionValue('--http-lock-file') ?? process.env.PC_AGENT_HOST_LOCK_FILE;
if (httpLockFile) {
  const host = await startHttpAgentHostServer({ lockFilePath: httpLockFile });
  process.stderr.write(
    `[agent-host] listening on 127.0.0.1:${host.port} lock=${httpLockFile}\n`,
  );
  const close = async () => {
    await host.close();
    process.exit(0);
  };
  process.once('SIGINT', () => {
    void close();
  });
  process.once('SIGTERM', () => {
    void close();
  });
  await new Promise<void>((resolve) => host.server.once('close', resolve));
  process.exit(0);
}

const service = new AgentHostService();

service.on('event', (event) => {
  write({ type: 'event', event });
});

service.emitReady();

const input = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

for await (const line of input) {
  if (line.trim().length === 0) continue;

  let wire: WireRequest;
  try {
    wire = parseWireRequest(JSON.parse(line));
  } catch (err) {
    write({
      type: 'response',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    continue;
  }

  const response = await service.handleCommand(wire.command);
  write({ type: 'response', id: wire.id, response });

  if (
    response.ok &&
    response.command === 'shutdown' &&
    wire.command.type === 'shutdown' &&
    wire.command.mode === 'host-exit'
  ) {
    process.exitCode = 0;
    input.close();
  }
}

function parseWireRequest(raw: unknown): WireRequest {
  if (!raw || typeof raw !== 'object') {
    throw new Error('expected JSON object command');
  }

  const obj = raw as { id?: unknown; command?: unknown; type?: unknown };
  const id =
    typeof obj.id === 'string' || typeof obj.id === 'number'
      ? obj.id
      : undefined;
  const command = (obj.command ?? raw) as AgentHostCommand;

  if (!command || typeof command !== 'object' || typeof command.type !== 'string') {
    throw new Error('expected host command with type');
  }

  return { id, command };
}

function write(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function optionValue(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return null;
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? value : null;
}
