// Boot-time reattach + targeted reconcile (out-of-process host, phase 2).
//
// Replaces the blanket "fail every non-terminal row" sweep when the agent host
// is enabled. The host outlives a server restart, so on boot we ask it which
// PTYs are still live and, per row:
//   - host still has it (running/paused) → REATTACH: rebuild a live AgentRun
//     bound to the host PTY via an attach-mode RemoteSpawn, tailing the JSONL
//     from its current cursor so prior turn-ends don't replay.
//   - host doesn't have it (queued-never-spawned, or PTY died in the gap) →
//     FAIL with server-restart, exactly as the legacy sweep did — but now only
//     for genuinely-dead runs.
//
// See docs/out-of-process-agent-host-design.md.

import { existsSync, readFileSync } from 'node:fs';

import {
  getProjectById,
  listNonTerminalAgentRuns,
  markAgentRunTerminal,
} from '@pc/db';
import type { AgentRunRow, ULID } from '@pc/domain';
import { AgentRun, type HostClient, type RosterEntry } from '@pc/runtime';

import {
  getRunRegistry,
  wireAndStartRun,
  type DispatchAgentDeps,
} from '../services/agent-run-factory.ts';

/** Like DispatchAgentDeps but with the raw projectId-aware broadcaster — each
 *  reattached run spans its own project, so the per-run `broadcast` closure is
 *  bound to that row's projectId (mirroring the dispatch routes). */
export type ReconcileDeps = Omit<DispatchAgentDeps, 'broadcast'> & {
  broadcastTo?: (projectId: ULID, env: unknown) => void;
};

/** AgentRun's default wall-clock ceiling (2h). Reattach re-arms the remaining
 *  budget from the row's spawnedAt. */
const DEFAULT_WALL_CLOCK_MS = 7_200_000;
/** Never re-arm a wall-clock shorter than this, even for an old run. */
const MIN_REATTACH_WALL_CLOCK_MS = 60_000;

export interface ReconcilePlan {
  reattach: AgentRunRow[];
  fail: AgentRunRow[];
}

/** Pure split: a row is reattachable iff it's running/paused AND the host still
 *  has a live PTY for its cc-session. Everything else (queued, spawning, or a
 *  vanished PTY) fails. */
export function planReconcile(
  rows: AgentRunRow[],
  rosterKeys: Set<string>,
): ReconcilePlan {
  const reattach: AgentRunRow[] = [];
  const fail: AgentRunRow[] = [];
  for (const row of rows) {
    const reattachable =
      (row.status === 'running' || row.status === 'paused') &&
      rosterKeys.has(row.ccSessionId);
    (reattachable ? reattach : fail).push(row);
  }
  return { reattach, fail };
}

export interface ReconcileResult {
  reattached: number;
  failed: number;
}

/** Boot reconcile against the live host roster. */
export async function reconcileWithHost(
  client: HostClient,
  deps: ReconcileDeps,
  now: () => number = Date.now,
): Promise<ReconcileResult> {
  const roster = await client.roster();
  const rosterKeys = new Set(roster.map((r) => r.key));
  const rosterByKey = new Map(roster.map((r) => [r.key, r]));

  const rows = listNonTerminalAgentRuns();
  const plan = planReconcile(rows, rosterKeys);

  for (const row of plan.fail) {
    failRow(row, now());
  }

  let reattached = 0;
  for (const row of plan.reattach) {
    try {
      reattachRun(row, rosterByKey.get(row.ccSessionId)!, client, deps, now);
      reattached++;
    } catch (err) {
      console.error(
        `[agent-host] reattach failed for run ${row.id}; failing it: ${err instanceof Error ? err.message : String(err)}`,
      );
      failRow(row, now());
    }
  }

  return { reattached, failed: plan.fail.length };
}

function failRow(row: AgentRunRow, at: number): void {
  markAgentRunTerminal({
    id: row.id,
    status: 'failed',
    result: null,
    failureCause: 'server-restart',
    failureReason: 'server restarted before this run completed',
    completedAt: at,
  });
}

/** Rebuild a live AgentRun bound to the host's already-running PTY. */
function reattachRun(
  row: AgentRunRow,
  rosterEntry: RosterEntry,
  client: HostClient,
  deps: ReconcileDeps,
  now: () => number,
): void {
  const project = getProjectById(row.projectId);
  if (!project) throw new Error(`project ${row.projectId} not found`);

  const worktreeDir = project.folderPath;
  const jsonlPath = rosterEntry.jsonlPath ?? undefined;

  // Skip existing JSONL lines so a prior turn-end doesn't replay as a fresh
  // event and prematurely complete the reattached run.
  let jsonlStartLine = 0;
  if (jsonlPath && existsSync(jsonlPath)) {
    try {
      jsonlStartLine = readFileSync(jsonlPath, 'utf-8').split('\n').filter(Boolean).length;
    } catch {
      jsonlStartLine = 0;
    }
  }

  const reattachState: 'running' | 'paused' = row.status === 'paused' ? 'paused' : 'running';

  // Re-arm the remaining wall-clock from the original spawn time.
  const elapsed = row.spawnedAt ? Math.max(0, now() - row.spawnedAt) : 0;
  const wallClockMs = Math.max(MIN_REATTACH_WALL_CLOCK_MS, DEFAULT_WALL_CLOCK_MS - elapsed);

  const registry = deps.runRegistry ?? getRunRegistry();
  const run = new AgentRun(
    {
      agentRunId: row.id,
      ccProviderSessionId: row.ccSessionId,
      podDefinition: { name: row.podName },
      // Attach mode ignores worktree for the PTY (host owns it); it's only used
      // by the terminal verification predicates downstream.
      worktreePath: worktreeDir,
      env: {},
      reattach: { state: reattachState },
      jsonlPath,
      jsonlStartLine,
      wallClockMs,
    },
    {
      registry,
      // Attach to the existing host PTY instead of spawning a fresh one.
      spawnFactory: (input) => client.attachSpawn(input),
    },
  );

  // Per-run deps: bind the panel broadcast to this row's project (the dispatch
  // routes do the same with their route-scoped projectId).
  const runDeps: DispatchAgentDeps = {
    channelServer: deps.channelServer,
    broadcast: deps.broadcastTo
      ? (env) => deps.broadcastTo!(row.projectId, env)
      : undefined,
    verifyOnTerminal: deps.verifyOnTerminal,
    verificationDeps: deps.verificationDeps,
    runRegistry: deps.runRegistry,
    activeRunRegistry: deps.activeRunRegistry,
    scratchDirFor: deps.scratchDirFor,
    agentRunFactory: deps.agentRunFactory,
    now: deps.now,
  };

  wireAndStartRun({
    run,
    projectId: row.projectId,
    agentRunId: row.id,
    ccSessionId: row.ccSessionId,
    podName: row.podName,
    dispatcherSessionId: row.dispatcherSessionId,
    slug: project.slug,
    worktreeDir,
    parentWorkItemId: row.parentWorkItemId ?? null,
    // The contract WI link the original dispatch stored on the row.
    workItemId: row.parentWorkItemId ?? null,
    podRevisionAtDispatch: row.podRevisionAtDispatch ?? null,
    cleanup: () => {},
    // The running/paused state set during reattachLifecycle fires the panel
    // envelope; no explicit initial broadcast needed.
    initialBroadcast: null,
    wireQueuedStarted: false,
    deps: runDeps,
  });
}
