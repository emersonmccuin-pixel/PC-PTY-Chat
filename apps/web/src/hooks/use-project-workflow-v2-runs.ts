// 19.12 — Activity-panel feeder for v2 workflow runs (replaces the v1 hook).
//
// Wire shape differs from v1: the `workflow-v2-run-changed` envelope carries
// `{ runId, projectId, workItemId, status, dagState }` only — NOT a full
// V2RunSummary snapshot. So this hook can't reuse the generic
// `useResourceList<T>` (which assumes snapshot-on-the-wire). Instead it merges
// the partial update into the local list and refetches on terminal-status
// transitions or unknown-run-id arrivals.

import { useEffect, useRef, useState } from 'react';

import type { Project } from '@/features/projects/client';
import { workflowsApi, type V2RunStatus, type V2RunSummary } from '@/features/workflows/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';

const TERMINAL = new Set<V2RunStatus>(['completed', 'failed', 'cancelled']);

interface V2RunChangedEnvelope extends WsEnvelope {
  type: 'workflow-v2-run-changed';
  projectId: string;
  runId: string;
  status: V2RunStatus;
}

export function useProjectWorkflowV2Runs(
  project: Project | null,
  events: WsEnvelope[],
): { runs: V2RunSummary[]; refetch: () => void } {
  const [runs, setRuns] = useState<V2RunSummary[]>([]);
  const lastProcessedIdx = useRef(0);

  useEffect(() => {
    if (!project) {
      setRuns([]);
      lastProcessedIdx.current = 0;
      return;
    }
    let cancelled = false;
    void workflowsApi.listV2WorkflowRuns(project.id).then((r) => {
      if (!cancelled) setRuns(r.runs);
    });
    lastProcessedIdx.current = events.length;
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  useEffect(() => {
    if (!project || events.length === 0) {
      lastProcessedIdx.current = events.length;
      return;
    }
    if (events.length < lastProcessedIdx.current) lastProcessedIdx.current = 0;
    const start = lastProcessedIdx.current;
    if (start >= events.length) return;

    let needsRefetch = false;
    setRuns((prev) => {
      let next = prev;
      for (let i = start; i < events.length; i++) {
        const env = events[i];
        if (!env || env.type !== 'workflow-v2-run-changed') continue;
        const e = env as V2RunChangedEnvelope;
        if (e.projectId !== project.id || !e.runId) continue;
        const idx = next.findIndex((r) => r.id === e.runId);
        if (idx === -1) {
          needsRefetch = true;
          continue;
        }
        if (e.status && next[idx]!.status !== e.status) {
          next = next.map((r, j) => (j === idx ? { ...r, status: e.status } : r));
          if (TERMINAL.has(e.status)) needsRefetch = true;
        }
      }
      return next;
    });
    lastProcessedIdx.current = events.length;

    if (needsRefetch) {
      void workflowsApi.listV2WorkflowRuns(project.id).then((r) => setRuns(r.runs));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, project?.id]);

  return {
    runs,
    refetch: () => {
      if (!project) return;
      void workflowsApi.listV2WorkflowRuns(project.id).then((r) => setRuns(r.runs));
    },
  };
}
