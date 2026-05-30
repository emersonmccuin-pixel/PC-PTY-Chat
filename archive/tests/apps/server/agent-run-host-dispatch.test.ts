import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentRunRow, Stage, ULID } from '@pc/domain';
import type {
  AgentHostCommand,
  AgentHostCommandResponse,
  AgentHostEvent,
  AgentHostRunSnapshot,
  AgentHostStartRunRequest,
} from '@pc/runtime';
import type { AgentHostReattachClient } from '../src/services/agent-host-reattach.ts';
import type { RunVerificationInput } from '../src/services/agent-verification.ts';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-server-host-dispatch-'));
process.env.PC_DATA_DIR = tmpDir;
process.env.CLAUDE_CONFIG_DIR = join(tmpDir, 'claude-config');

const {
  closeDb,
  createAgent,
  createProject,
  createWorkItem,
  getAgentRunRow,
  insertAgentRunRow,
  listPendingForSession,
  markAgentRunTerminal,
  newId,
  runMigrations,
} = await import('@pc/db');
const { projectDirFor } = await import('@pc/runtime');
const { ChannelServer } = await import('../src/services/channel-server.ts');
const { ActiveRunRegistry } = await import('../src/services/agent-active-runs.ts');
const {
  dispatchContinueAgent,
  dispatchFreshAgent,
} = await import('../src/services/agent-run-factory.ts');

class FakeHostClient extends EventEmitter implements AgentHostReattachClient {
  commands: AgentHostCommand[] = [];
  private readonly runs = new Map<string, AgentHostRunSnapshot>();

  listRuns(): readonly AgentHostRunSnapshot[] {
    return Array.from(this.runs.values());
  }

  sendCommand(command: AgentHostCommand): AgentHostCommandResponse | void {
    this.commands.push(command);
    if (command.type === 'start-run' || command.type === 'resume-run') {
      const run = snapshotFromRequest(command.request);
      this.runs.set(run.runId, run);
      return {
        ok: true,
        command: command.type,
        run,
        lastSeq: this.commands.length,
      } as AgentHostCommandResponse;
    }
    if ('runId' in command) {
      const run = this.runs.get(command.runId);
      if (!run || command.type === 'send') return;
      return {
        ok: true,
        command: command.type,
        run,
        lastSeq: this.commands.length,
      } as AgentHostCommandResponse;
    }
  }

  onEvent(listener: (event: AgentHostEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }

  emitHostEvent(event: AgentHostEvent): void {
    this.emit('event', event);
  }
}

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];
let server: InstanceType<typeof ChannelServer>;
let project: ReturnType<typeof createProject>;

before(() => {
  runMigrations();
  const folderPath = join(tmpDir, 'host-dispatch-project');
  mkdirSync(folderPath, { recursive: true });
  project = createProject({
    slug: 'host-dispatch',
    name: 'Host Dispatch',
    stages,
    folderPath,
  });
  createAgent(
    {
      id: newId(),
      scope: 'global',
      name: 'researcher',
      prompt: 'You are a researcher.',
      tools: [],
      description: 'Researcher pod',
    },
    { actor: 'orchestrator', reason: 'host dispatch test' },
  );
  server = new ChannelServer({
    port: 0,
    allowedSenders: new Set(),
    onEvent: () => {},
  });
});

after(() => {
  server.shutdown();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('dispatchFreshAgent sends start-run to a supplied host client and registers a host handle', async () => {
  const host = new FakeHostClient();
  const activeRunRegistry = new ActiveRunRegistry();
  const broadcasts: unknown[] = [];

  const result = await dispatchFreshAgent(
    {
      projectId: project.id as ULID,
      worktreeDir: project.folderPath,
      agentName: 'researcher',
      input: 'research host dispatch',
      dispatcherSessionId: 'dispatcher-1',
      invokeDepth: 1,
      slug: project.slug,
    },
    {
      channelServer: server,
      hostClient: host,
      activeRunRegistry,
      scratchDirFor: (_projectId, runId) => join(tmpDir, 'scratch', runId),
      broadcast: (env) => broadcasts.push(env),
      now: () => 1_700_000_000_000,
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.initialState, 'spawning');
  assert.equal(host.commands.length, 1);

  const command = host.commands[0]!;
  assert.equal(command.type, 'start-run');
  if (command.type !== 'start-run') return;
  assert.equal(command.request.runId, result.agentRunId);
  assert.equal(command.request.ccSessionId, result.ccSessionId);
  assert.equal(command.request.projectId, project.id);
  assert.equal(command.request.dispatcherSessionId, 'dispatcher-1');
  assert.equal(command.request.podDefinition.logicalName, 'researcher');
  assert.equal(command.request.worktreePath, project.folderPath);
  assert.equal(command.request.env.PC_AGENT_RUN_ID, result.agentRunId);
  assert.equal(command.request.env.PC_DISPATCHER_SESSION_ID, 'dispatcher-1');
  assert.equal(command.request.pluginDirs?.length, 1);
  assert.match(command.request.transcriptPath ?? '', /transcript\.log$/);

  const row = getAgentRunRow(result.agentRunId) as AgentRunRow;
  assert.equal(row.status, 'running');
  assert.equal(activeRunRegistry.get(result.agentRunId)?.ccSessionId, result.ccSessionId);
  activeRunRegistry.get(result.agentRunId)?.run.cancel();
  assert.equal(host.commands[1]?.type, 'cancel');
  assert.equal((host.commands[1] as { runId?: string }).runId, result.agentRunId);
  assert.equal((broadcasts[0] as { type?: string }).type, 'agent-run-changed');
});

test('dispatchContinueAgent sends resume-run with the parent run id and reused CC session', async () => {
  const parent = seedTerminalParent();
  const host = new FakeHostClient();
  const activeRunRegistry = new ActiveRunRegistry();

  const result = await dispatchContinueAgent(
    {
      projectId: project.id as ULID,
      worktreeDir: project.folderPath,
      parentAgentRunId: parent.id,
      input: 'follow up through host',
      dispatcherSessionId: parent.dispatcherSessionId,
      slug: project.slug,
    },
    {
      channelServer: server,
      hostClient: host,
      activeRunRegistry,
      scratchDirFor: (_projectId, runId) => join(tmpDir, 'scratch', runId),
      now: () => 1_700_000_001_000,
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ccSessionId, parent.ccSessionId);
  assert.equal(host.commands.length, 1);

  const command = host.commands[0]!;
  assert.equal(command.type, 'resume-run');
  if (command.type !== 'resume-run') return;
  assert.equal(command.request.mode, 'resume');
  assert.equal(command.request.continues, parent.id);
  assert.equal(command.request.runId, result.agentRunId);
  assert.equal(command.request.ccSessionId, parent.ccSessionId);
  assert.equal(command.request.initialInput, 'follow up through host');

  const continuation = getAgentRunRow(result.agentRunId) as AgentRunRow;
  assert.equal(continuation.continues, parent.id);
  assert.equal(continuation.status, 'running');
  assert.equal(activeRunRegistry.get(result.agentRunId)?.ccSessionId, parent.ccSessionId);
});

test('host terminal events reuse verification, inbox delivery, broadcast, and cleanup effects', async () => {
  const contract = createWorkItem({
    projectId: project.id as ULID,
    stageId: 'backlog',
    title: 'host terminal contract',
    body: 'write the report',
    isAgentTask: true,
    expectedOutput: { kind: 'text', sections: ['summary'] },
    acceptanceCriteria: [],
    verificationTier: 'auto',
  });
  const host = new FakeHostClient();
  const activeRunRegistry = new ActiveRunRegistry();
  const broadcasts: unknown[] = [];
  const verified: unknown[] = [];

  const result = await dispatchFreshAgent(
    {
      projectId: project.id as ULID,
      worktreeDir: project.folderPath,
      agentName: 'researcher',
      input: 'finish the contract',
      dispatcherSessionId: 'dispatcher-terminal',
      workItemId: contract.id,
      invokeDepth: 1,
      slug: project.slug,
    },
    {
      channelServer: server,
      hostClient: host,
      activeRunRegistry,
      scratchDirFor: (_projectId, runId) => join(tmpDir, 'scratch', runId),
      verifyOnTerminal: (async (input: RunVerificationInput) => {
        verified.push(input);
        return {
          workItemId: input.workItemId as ULID,
          workItemStatus: 'complete',
          verificationStatus: 'passed',
          verificationTier: 'auto',
          notes: 'verified by fake host test',
          predicatesEvaluated: 0,
        };
      }) as never,
      broadcast: (env) => broadcasts.push(env),
      now: () => 1_700_000_002_000,
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const command = host.commands[0]!;
  assert.equal(command.type, 'start-run');
  if (command.type !== 'start-run') return;
  assert.equal(existsSync(command.request.mcpConfigPath ?? ''), true);

  host.emitHostEvent({
    seq: 1,
    type: 'run-terminal',
    run: {
      ...snapshotFromRequest(command.request),
      state: 'completed',
      terminalAt: 1_700_000_002_500,
      terminalResult: {
        status: 'completed',
        result: 'host produced a report',
        failureCause: null,
        failureReason: null,
      },
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const row = getAgentRunRow(result.agentRunId) as AgentRunRow;
  assert.equal(row.status, 'completed');
  assert.equal(row.result, 'host produced a report');
  assert.equal(activeRunRegistry.get(result.agentRunId), null);
  assert.equal(existsSync(command.request.mcpConfigPath ?? ''), false);
  assert.equal((verified[0] as { workItemId?: string }).workItemId, contract.id);

  const pending = listPendingForSession('dispatcher-terminal');
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.kind, 'agent-completed');
  assert.match(pending[0]?.body ?? '', /host produced a report/);
  assert.match(pending[0]?.body ?? '', /verification: passed/);

  const terminalBroadcast = broadcasts.at(-1) as {
    type?: string;
    record?: { status?: string; result?: string };
  };
  assert.equal(terminalBroadcast.type, 'agent-run-changed');
  assert.equal(terminalBroadcast.record?.status, 'completed');
  assert.equal(terminalBroadcast.record?.result, 'host produced a report');

  host.emitHostEvent({
    seq: 2,
    type: 'run-terminal',
    run: {
      ...snapshotFromRequest(command.request),
      state: 'completed',
      terminalAt: 1_700_000_002_500,
      terminalResult: {
        status: 'completed',
        result: 'host produced a report',
        failureCause: null,
        failureReason: null,
      },
    },
  });
  assert.equal(listPendingForSession('dispatcher-terminal').length, 1);
});

function snapshotFromRequest(request: AgentHostStartRunRequest): AgentHostRunSnapshot {
  return {
    runId: request.runId,
    projectId: request.projectId,
    dispatcherSessionId: request.dispatcherSessionId,
    ccSessionId: request.ccSessionId,
    podName: request.podDefinition.logicalName ?? request.podDefinition.name,
    worktreeDir: request.worktreePath,
    state: 'running',
    jsonlPath: null,
    transcriptPath: request.transcriptPath ?? null,
    queuedAt: 1_700_000_000_000,
    spawnedAt: 1_700_000_000_100,
    readyAt: 1_700_000_000_200,
    updatedAt: 1_700_000_000_300,
    terminalAt: null,
  };
}

function seedTerminalParent(): AgentRunRow {
  const id = newId() as ULID;
  const ccSessionId = `cc-${id}`;
  const row = insertAgentRunRow({
    id,
    projectId: project.id as ULID,
    podName: 'researcher',
    dispatcherSessionId: 'dispatcher-continue',
    ccSessionId,
    status: 'running',
    input: 'parent input',
    queuedAt: 1_700_000_000_000,
  });
  markAgentRunTerminal({
    id,
    status: 'completed',
    result: 'done',
    failureCause: null,
    failureReason: null,
    completedAt: 1_700_000_000_500,
  });
  const jsonlDir = projectDirFor(project.folderPath);
  mkdirSync(jsonlDir, { recursive: true });
  writeFileSync(join(jsonlDir, `${ccSessionId}.jsonl`), '{"type":"user","message":"hi"}\n');
  return row;
}
