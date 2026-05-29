import type { AgentRunRow, ULID } from '@pc/domain';
import type { AgentHostRunSnapshot } from '@pc/runtime';
import {
  hasOpenPendingAskForRun as defaultHasOpenPendingAskForRun,
  listNonTerminalAgentRuns as defaultListNonTerminalAgentRuns,
  markAgentRunTerminal as defaultMarkAgentRunTerminal,
  reconcileOrphanedRunningRuns as defaultLegacyReconcile,
  updateAgentRunStatus as defaultUpdateAgentRunStatus,
} from '@pc/db';

export interface AgentRunHostSnapshotClient {
  listRuns(): readonly AgentHostRunSnapshot[];
}

export interface AgentRunBootReconcileDeps {
  now?: () => number;
  hostClient?: AgentRunHostSnapshotClient | null;
  legacyReconcile?: (now: number) => number;
  listNonTerminalRuns?: () => AgentRunRow[];
  hasOpenPendingAskForRun?: (runId: ULID) => boolean;
  markTerminal?: typeof defaultMarkAgentRunTerminal;
  updateStatus?: typeof defaultUpdateAgentRunStatus;
}

export interface AgentRunBootReconcileResult {
  mode: 'legacy' | 'host';
  hostRuns: number;
  checked: number;
  kept: number;
  failed: number;
  updated: number;
  reconciled: number;
}

const SERVER_RESTART_REASON = 'server restarted before this run completed';

/**
 * Boot-time agent-run reconciliation.
 *
 * Current production has no out-of-process host, so the default path preserves
 * the legacy blanket sweep. When a host client is supplied, this reconciles DB
 * rows against host-owned live PTYs instead of assuming every non-terminal row
 * is dead.
 */
export function reconcileAgentRunsOnBoot(
  deps: AgentRunBootReconcileDeps = {},
): AgentRunBootReconcileResult {
  const now = (deps.now ?? Date.now)();
  const hostClient = deps.hostClient ?? null;

  if (!hostClient) {
    const reconciled = (deps.legacyReconcile ?? defaultLegacyReconcile)(now);
    return {
      mode: 'legacy',
      hostRuns: 0,
      checked: 0,
      kept: 0,
      failed: reconciled,
      updated: 0,
      reconciled,
    };
  }

  const hostRuns = hostClient.listRuns();
  const hostByRunId = new Map(hostRuns.map((run) => [run.runId, run]));
  const rows = (deps.listNonTerminalRuns ?? defaultListNonTerminalAgentRuns)();
  const hasOpenAsk = deps.hasOpenPendingAskForRun ?? defaultHasOpenPendingAskForRun;
  const markTerminal = deps.markTerminal ?? defaultMarkAgentRunTerminal;
  const updateStatus = deps.updateStatus ?? defaultUpdateAgentRunStatus;

  let kept = 0;
  let failed = 0;
  let updated = 0;

  for (const row of rows) {
    const hostRun = hostByRunId.get(row.id);
    if (hostRun) {
      kept += 1;
      if (hostRun.state !== row.status) {
        updateStatus({
          id: row.id,
          status: hostRun.state,
          ...(hostRun.spawnedAt !== null ? { spawnedAt: hostRun.spawnedAt } : {}),
          ...(hostRun.readyAt !== null ? { readyAt: hostRun.readyAt } : {}),
        });
        updated += 1;
      }
      continue;
    }

    // Paused runs are allowed to have no live PTY: Claude exits cleanly while
    // waiting on a pending ask, then resumes from JSONL when answered.
    if (row.status === 'paused' && hasOpenAsk(row.id)) {
      kept += 1;
      continue;
    }

    markTerminal({
      id: row.id,
      status: 'failed',
      result: null,
      failureCause: 'server-restart',
      failureReason: SERVER_RESTART_REASON,
      completedAt: now,
    });
    failed += 1;
  }

  return {
    mode: 'host',
    hostRuns: hostRuns.length,
    checked: rows.length,
    kept,
    failed,
    updated,
    reconciled: failed + updated,
  };
}
