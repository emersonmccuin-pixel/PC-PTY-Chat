// Activity-panel feeder for workflow runs (regions 2 + 5).
//
// Section 18.10: now a thin wrapper around the generic `useResourceList<T>`.
// Server emits the full `WorkflowRun` snapshot in the `workflow-run-changed`
// envelope (Topic 5 lock); we read from `snapshot` and treat the local map
// as a cache keyed by run id. Terminal transitions trigger a refetch so
// `completedAt` (omitted by the envelope's legacy fields) stays accurate.

import type { Project, WorkflowRun } from '@/api/client';
import { api } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';
import { useResourceList } from '@/hooks/use-resource-list';

interface RunChangedEnvelope extends WsEnvelope {
  type: 'workflow-run-changed';
  projectId: string;
  snapshot?: WorkflowRun;
}

const TERMINAL = new Set<WorkflowRun['status']>([
  'complete',
  'failed',
  'cancelled',
]);

export function useProjectWorkflowRuns(
  project: Project | null,
  events: WsEnvelope[],
): { runs: WorkflowRun[]; refetch: () => void } {
  const { records, refetch } = useResourceList<WorkflowRun>(project, events, {
    envelopeKind: 'workflow-run-changed',
    extractSnapshot: (env, projectId) => {
      const e = env as RunChangedEnvelope;
      if (e.projectId !== projectId) return null;
      return e.snapshot ?? null;
    },
    getId: (r) => r.id,
    isTerminal: (r) => TERMINAL.has(r.status),
    dropOnTerminal: false,
    list: (projectId) => api.listWorkflowRuns(projectId),
  });
  return { runs: records, refetch };
}
