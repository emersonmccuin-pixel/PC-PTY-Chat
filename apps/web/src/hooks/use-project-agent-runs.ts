// Activity-panel feeder for the "Running agents" region.
//
// Section 18.10: now a thin wrapper around the generic `useResourceList<T>`.
// The server's `agent-run-changed` envelope already carries the full
// `AgentRunRecord` snapshot (Topic 5 lock — was the canonical reference
// shape pre-rewrite). The local map drops terminal rows on the per-envelope
// branch and then refetches, since the server's list endpoint filters
// terminal rows out (running-agents view only).

import type { Project } from '@/features/projects/client';
import { agentRunsApi, type AgentRunRecord } from '@/features/agent-runs/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { useResourceList } from '@/hooks/use-resource-list';

interface AgentRunChangedEnvelope extends WsEnvelope {
  type: 'agent-run-changed';
  record: AgentRunRecord;
}

const TERMINAL = new Set<AgentRunRecord['status']>([
  'completed',
  'failed',
  'cancelled',
]);

export function useProjectAgentRuns(
  project: Project | null,
  events: WsEnvelope[],
): { runs: AgentRunRecord[] } {
  const { records } = useResourceList<AgentRunRecord>(project, events, {
    envelopeKind: 'agent-run-changed',
    extractSnapshot: (env, projectId) => {
      const e = env as AgentRunChangedEnvelope;
      if (!e.record || e.record.projectId !== projectId) return null;
      return e.record;
    },
    getId: (r) => r.runId,
    isTerminal: (r) => TERMINAL.has(r.status),
    dropOnTerminal: true,
    getVersion: (r) => r.rev ?? 0,
    list: (projectId) => agentRunsApi.listAgentRuns(projectId),
  });
  return { runs: records };
}
