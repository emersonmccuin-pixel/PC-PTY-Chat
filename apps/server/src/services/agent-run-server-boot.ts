import {
  reattachAgentRunsOnBoot,
  type AgentHostReattachClient,
  type AgentHostReattachDeps,
  type AgentHostReattachResult,
} from './agent-host-reattach.ts';
import { resolveAgentHostClientForBoot } from './agent-host-client.ts';
import {
  reconcileAgentRunsOnBoot,
  type AgentRunBootReconcileResult,
} from './agent-run-boot-reconcile.ts';

export type AgentRunServerBootResult =
  | {
      mode: 'legacy';
      reconcile: AgentRunBootReconcileResult;
      reattach: null;
    }
  | {
      mode: 'host';
      hostClient: AgentHostReattachClient;
      reconcile: AgentRunBootReconcileResult;
      reattach: AgentHostReattachResult;
    };

export interface AgentRunServerBootDeps
  extends Omit<AgentHostReattachDeps, 'hostClient'> {
  getHostClient?: () =>
    | AgentHostReattachClient
    | Promise<AgentHostReattachClient | null>
    | null;
  legacyReconcile?: (now: number) => number;
}

export async function reattachAgentRunsDuringServerBoot(
  deps: AgentRunServerBootDeps = {},
): Promise<AgentRunServerBootResult> {
  const {
    getHostClient = resolveAgentHostClientForBoot,
    legacyReconcile,
    ...reattachDeps
  } = deps;
  const hostClient = await getHostClient();

  if (hostClient) {
    const reattach = reattachAgentRunsOnBoot({
      ...reattachDeps,
      hostClient,
    });
    return {
      mode: 'host',
      hostClient,
      reconcile: reattach.reconcile,
      reattach,
    };
  }

  const reconcile = reconcileAgentRunsOnBoot({
    now: reattachDeps.now,
    legacyReconcile,
    listNonTerminalRuns: reattachDeps.listNonTerminalRuns,
    hasOpenPendingAskForRun: reattachDeps.hasOpenPendingAskForRun,
    markTerminal: reattachDeps.markTerminal,
    updateStatus: reattachDeps.updateStatus,
    resolveJsonlPath: reattachDeps.resolveJsonlPath,
    jsonlExists: reattachDeps.jsonlExists,
    broadcast: reattachDeps.broadcast,
  });

  return {
    mode: 'legacy',
    reconcile,
    reattach: null,
  };
}
