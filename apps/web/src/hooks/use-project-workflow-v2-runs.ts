// UI Spine step 2 — Activity-panel feeder for v2 workflow runs.
//
// The `workflow-v2-run-changed` envelope now carries a versioned full snapshot
// of the run row (not a partial ping). This hook therefore uses the generic
// `useResourceList<V2RunSummary>` which:
//   - patches one run in place via the id-keyed Map on each snapshot
//   - discards envelopes whose `rev` ≤ stored `rev` (out-of-order WS)
//   - stops doing per-envelope whole-list refetches (list endpoint is only
//     hit on mount, project switch, or reconnect/replay reset)
//
// Replaces the prior bespoke implementation that used a dumb partial-ping
// shape and refetched the whole list on every terminal/unknown arrival.

import type { Project } from '@/features/projects/client';
import { workflowsApi, type V2RunStatus, type V2RunSummary } from '@/features/workflows/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import type { WorkflowV2RunChangedEnvelope } from '@/features/runtime/ws-types';
import { useResourceList } from '@/hooks/use-resource-list';

const TERMINAL = new Set<V2RunStatus>(['completed', 'failed', 'cancelled']);

export function useProjectWorkflowV2Runs(
  project: Project | null,
  events: WsEnvelope[],
): { runs: V2RunSummary[]; refetch: () => void } {
  const { records, refetch } = useResourceList<V2RunSummary>(project, events, {
    envelopeKind: 'workflow-v2-run-changed',
    extractSnapshot: (env, projectId) => {
      const e = env as WorkflowV2RunChangedEnvelope;
      if (e.type !== 'workflow-v2-run-changed') return null;
      if (!e.run || e.run.projectId !== projectId) return null;
      // Cast the full snapshot to V2RunSummary — the server row is a superset.
      return e.run as unknown as V2RunSummary;
    },
    getId: (r) => r.id,
    isTerminal: (r) => TERMINAL.has(r.status),
    // Workflow runs remain in the list at terminal (the "Failed recently" and
    // "Waiting on you" regions both consume terminal runs). The list endpoint
    // returns all runs (not just active ones), so we keep them in the Map.
    dropOnTerminal: false,
    getVersion: (r) => r.rev,
    list: (projectId) =>
      workflowsApi.listV2WorkflowRuns(projectId).then((r) => r.runs),
  });

  return { runs: records, refetch };
}
