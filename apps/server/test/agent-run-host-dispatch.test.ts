import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-server-host-dispatch-'));
process.env.PC_DATA_DIR = tmpDir;
process.env.CLAUDE_CONFIG_DIR = join(tmpDir, 'claude-config');

const {
  closeDb,
  createAgent,
  createProject,
  getAgentRunRow,
  insertAgentRunRow,
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
