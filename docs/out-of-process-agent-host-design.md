# Out-of-Process Agent Host Design

Status: draft design.

Owner: Codex.

Related: `docs/out-of-process-agents-todo.md`.

## Goal

Keep dispatched agents alive when the API server restarts or crashes.

The API server should be able to reconnect to a long-lived agent host, rebuild active-run state from DB plus host snapshots, re-tail JSONL from disk, and keep the UI truthful.

## Current Shape

In-process ownership today:

- `packages/runtime/src/low-level-spawn.ts` owns `node-pty`, Claude process IO, ready gate, JSONL tail attach, raw transcript writes, resize, interrupt, send, and kill.
- `packages/runtime/src/agent-run.ts` owns dispatched-agent state, timers, cap admission, `LowLevelSpawn` construction, pause/resume, and terminal decisions.
- `packages/runtime/src/agent-run-registry.ts` owns a process-local concurrency queue.
- `apps/server/src/services/agent-run-factory.ts` validates pods, materializes runtime files, inserts `agent_runs`, constructs `AgentRun`, registers active runs, persists transitions, broadcasts live JSONL, and emits terminal channel events.
- `apps/server/src/services/agent-active-runs.ts` owns the process-local active-run index used by cancel, pause, answer, continuation, and MCP handshake routing.
- `packages/db/src/repos/agent-runs.ts` currently treats any non-terminal row at boot as orphaned and marks it `failed/server-restart`.
- `apps/server/src/services/dag-run-service.ts` uses `spawnSubagent` directly for workflow agent nodes and separately mirrors those nodes into `agent_runs`.
- `apps/server/scripts/dev-supervisor.mjs` supervises only the API server child.
- `apps/desktop/src/main.ts` hosts the packaged server in the Electron process.

The fault line is `LowLevelSpawn`: when `node-pty` lives in the API server process, a server crash tears down the PTY children too.

## Target Boundary

Introduce one long-lived agent host process per app instance.

The host owns:

- `LowLevelSpawn` and all `node-pty` interaction.
- Live child process handles.
- Per-run send, cancel, interrupt, resize, and kill.
- Ready/handshake notification delivery to live spawns.
- Host-local timers that must survive API restarts.
- Host-local registry of live run ids, session ids, JSONL paths, and terminal state.

The API server owns:

- HTTP routes and WebSocket broadcasts.
- DB row creation and durable transition persistence.
- Pod resolution and materialization policy.
- Channel delivery and inbox persistence.
- Verification and work-item side effects on terminal.
- Reattach/reconcile decisions after boot.

The DB remains the source of record for user-visible run state.

The host is the source of truth for whether a PTY is actually alive.

JSONL remains the source of truth for transcript backfill.

## Host Identity

The host should persist a boot id and expose it through every snapshot.

```ts
export interface AgentHostIdentity {
  hostId: string;
  pid: number;
  startedAt: number;
  protocolVersion: 1;
}
```

The API server should not assume a host restart is harmless.

If the host restarts, live PTYs are gone unless the host can prove otherwise.

## Run Snapshot Contract

The API reattaches by asking the host for a complete live-run snapshot.

```ts
export type AgentHostRunState =
  | 'queued'
  | 'spawning'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentHostRunSnapshot {
  runId: string;
  projectId: string;
  dispatcherSessionId: string;
  ccSessionId: string;
  podName: string;
  worktreeDir: string;
  state: AgentHostRunState;
  jsonlPath: string | null;
  transcriptPath: string | null;
  queuedAt: number;
  spawnedAt: number | null;
  readyAt: number | null;
  updatedAt: number;
  terminalAt: number | null;
  terminalResult?: {
    status: 'completed' | 'failed' | 'cancelled';
    result: string | null;
    failureCause: string | null;
    failureReason: string | null;
  };
}
```

Rules:

- `runId`, `projectId`, `dispatcherSessionId`, and `ccSessionId` must match DB rows.
- `state` must not be inferred by the API from stale memory.
- `jsonlPath` should be known before spawn when `ccSessionId` is deterministic.
- `terminalResult` is delivered once and can be replayed on reconnect until the API acknowledges it.

## Command Contract

The first API slice should use request/response IPC plus a host event stream.

```ts
export type AgentHostCommand =
  | { type: 'hello'; apiPid: number; protocolVersion: 1 }
  | { type: 'list-runs' }
  | { type: 'start-run'; request: AgentHostStartRunRequest }
  | { type: 'resume-run'; request: AgentHostResumeRunRequest }
  | { type: 'send'; runId: string; text: string }
  | { type: 'answer-pending'; runId: string; text: string }
  | { type: 'cancel'; runId: string; reason?: string }
  | { type: 'notify-mcp-handshake'; ccSessionId: string }
  | { type: 'shutdown'; mode: 'host-exit' | 'cancel-runs' };
```

`start-run` request:

- `runId`
- `projectId`
- `dispatcherSessionId`
- `ccSessionId`
- `podDefinition`
- `worktreePath`
- `env`
- `initialInput`
- `mcpConfigPath`
- `settingsPath`
- `settingSources`
- `pluginDirs`
- `transcriptPath`
- timeout values

The request intentionally mirrors `AgentRunInput` plus the resolved runtime files.

The API should still materialize pods before `start-run`; the host should not query DB.

## Event Contract

The host emits append-only events with monotonic host sequence numbers.

```ts
export type AgentHostEvent =
  | { seq: number; type: 'host-ready'; identity: AgentHostIdentity }
  | { seq: number; type: 'run-state'; run: AgentHostRunSnapshot }
  | { seq: number; type: 'run-jsonl'; runId: string; event: unknown; cursor?: number }
  | { seq: number; type: 'run-chunk'; runId: string; text: string }
  | { seq: number; type: 'run-terminal'; run: AgentHostRunSnapshot }
  | { seq: number; type: 'run-error'; runId: string; error: string };
```

Rules:

- The host keeps enough recent events to replay from `lastSeq` after API reconnect.
- The API may always fall back to DB plus JSONL if host event replay is truncated.
- `run-terminal` is at-least-once; DB terminal writes must stay idempotent.
- JSONL events may duplicate backfilled events; the web transcript merge already needs stable dedupe keys.

## Reattach On API Boot

Boot sequence after migrations/settings:

1. Connect to or start the host.
2. Send `hello`.
3. Request `list-runs`.
4. Load DB rows where status is `queued | spawning | running | paused`.
5. Match DB rows to host snapshots by `runId`.
6. For matched rows, persist any newer host state and register lightweight API proxies in the active-run registry.
7. For DB rows missing from the host:
   - `queued`: keep queued only if the host has a queued ticket model; otherwise mark `failed/host-lost`.
   - `spawning` or `running`: mark `failed/host-lost`.
   - `paused`: keep paused if there is an open pending ask and JSONL exists; otherwise mark `failed/host-lost`.
8. Start JSONL backfill from each live row's `ccSessionId`.
9. Broadcast `agent-run-changed` snapshots for affected projects.

This replaces the current blanket `reconcileOrphanedRunningRuns()` call.

## Active Registry After Reattach

`ActiveRunRegistry` should stop storing only concrete `AgentRun` instances.

Target shape:

```ts
export interface ActiveRunHandle {
  getState(): AgentHostRunState;
  cancel(): void;
  notifyMcpHandshake(): void;
  resumeWithAnswer?(answer: string): void;
}
```

In-process mode can adapt `AgentRun`.

Host mode can adapt IPC commands.

Pause/resume, cancel, and MCP handshake routes should depend on this handle contract, not on `AgentRun` directly.

## Concurrency

Move admission to the host before the first implementation lands.

Reason:

- API server restarts would reset `AgentRunRegistry`.
- A restarted API must not admit more runs than the still-live host is already running.

Host snapshot should include:

- `maxConcurrent`
- `activeCount`
- `queuedCount`
- queued run order

The API may reject or enqueue based on host response, but it must not maintain a separate authoritative cap.

## Pause And Resume

Current pause semantics:

- `recordExplicitPause` writes `pending_asks`, calls `_markPaused`, persists `paused`, and delivers an inbox event.
- `answerPendingAsk` flips the ask row, persists `spawning`, and calls `_resumeWithAnswer`.

Host mode:

- Pause detection remains API-owned because MCP tools call API routes.
- The API sends `pause` or `mark-paused` to the host only if the live process needs a local state transition.
- Answer sends `answer-pending` to the host.
- The host creates the resume `LowLevelSpawn` with the same `ccSessionId`.
- The API persists `spawning/running/paused/terminal` from host events.

## Workflow Agent Nodes

Workflow DAG nodes currently call `spawnSubagent` directly and mirror rows into `agent_runs`.

Do not solve this in the first host slice.

Order:

1. Move orchestrator-dispatched agent runs to the host.
2. Keep workflow DAG `spawnSubagent` in-process until the host contract is proven.
3. Add a second host command for workflow subagents with the existing `SubagentSpawnRequest` shape.
4. Route workflow MCP handshakes through the same `notify-mcp-handshake` command.

This keeps the workflow runtime from blocking the durable-agent MVP.

## Supervisor And Packaging

Dev:

- `apps/server/scripts/dev-supervisor.mjs` should supervise two children: API server and agent host.
- Sentinel API restart should restart only the API child.
- Host crash should restart the host and then force API reconcile against an empty or new host snapshot.
- SIGINT/SIGTERM should shut down API and host.

Packaged:

- `apps/desktop/src/main.ts` should start the host as a sibling child process before importing `server.mjs`.
- The packaged API server should connect to that host over a local IPC endpoint.
- On app quit, Electron should shut down the host explicitly.

IPC transport:

- Prefer a localhost HTTP/WebSocket listener bound to `127.0.0.1` and a random port written to a lock file under `PC_DATA_DIR/agent-host`.
- Avoid Node `process.send` as the only transport because packaged Electron and dev supervisor have different parent/child topology.
- The lock file must include pid, hostId, port, startedAt, and protocolVersion.

## Failure Semantics

New failure causes should be added before implementation:

- `host-unavailable`: API could not reach host before starting a run.
- `host-lost`: DB row was non-terminal but the reattached host does not own it.
- `host-crashed`: host process died while owning the run.
- `host-protocol-error`: IPC contract violation.

Do not reuse `server-restart` once the host is introduced.

`server-restart` should mean only the legacy in-process mode killed the run.

## Implementation Plan

Phase A - contracts and adapter seams:

- Add host protocol types in a new runtime/server-shared module.
- Replace `ActiveRunRegistry`'s hard dependency on `AgentRun` with `ActiveRunHandle`.
- Add tests proving cancel, MCP handshake, pause, and answer use the handle contract.
- Keep production backed by in-process `AgentRun`.

Phase B - host process MVP:

- Add `apps/agent-host` or `packages/agent-host` executable.
- Move `AgentRunRegistry` singleton into the host.
- Implement `start-run`, `cancel`, `notify-mcp-handshake`, `list-runs`, and event stream.
- Keep terminal verification/channel delivery in API.

Phase C - API reattach:

- Replace blanket `reconcileOrphanedRunningRuns` with host-aware reconcile.
- Register host-backed active handles after boot.
- Backfill live transcript state from JSONL and replay host terminal events idempotently.

Phase D - supervisor integration:

- Start host from dev supervisor.
- Add packaged host boot in Electron.
- Add shutdown semantics for user quit vs API restart.

Phase E - workflow migration:

- Add workflow subagent host command.
- Move `spawnSubagent` users in `dag-run-service` to host-backed handles.
- Reuse existing workflow-subagent handshake tests against host commands.

## Verification Plan

Unit tests:

- Active registry handle contract.
- Host-aware reconcile: matched host rows stay active; missing running rows fail; paused rows with open asks stay paused only when JSONL exists.
- Host event terminal idempotency.
- Host admission survives API reconnect.
- MCP handshake routes to host-backed handles.

Integration tests with fake host:

- API boot reattaches two running rows and one paused row.
- Cancel route sends `cancel` to host.
- Answer route sends `answer-pending` to host.
- Events route backfills JSONL for a reattached run.

Manual smoke later:

- Start a long-running agent.
- Kill only the API server process.
- Confirm the agent keeps running.
- Let the API reconnect.
- Confirm Activity Panel still shows the run and transcript keeps updating.

Do not run the manual smoke until the user explicitly allows a server kill/restart.

## Non-Goals

- Do not move orchestrator `PtySession` in this pass.
- Do not change workflow DAG semantics in the durable-agent MVP.
- Do not replace JSONL as the canonical transcript source.
- Do not make the host query product DB tables.
- Do not restart the current dev server to validate this design.
