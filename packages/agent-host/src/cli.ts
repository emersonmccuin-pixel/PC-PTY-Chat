import { createInterface } from 'node:readline';

import type { AgentHostCommand } from '@pc/runtime';

import { AgentHostService } from './agent-host-service.ts';

type WireId = string | number;

interface WireRequest {
  id?: WireId;
  command: AgentHostCommand;
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
