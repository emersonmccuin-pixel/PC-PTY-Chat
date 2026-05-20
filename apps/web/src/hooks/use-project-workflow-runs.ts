// Shared hook for the activity panel's region 2 (running workflows) and
// region 5 (failed recently). Fetches the project's full run list once on
// mount and updates the in-memory map from `workflow-run-changed` WS
// envelopes. Per-region filtering happens at the call site.
//
// Read model: a Map keyed by run id so live deltas patch in place. The
// envelope's `status` + `nodeOutputs` are the minimum fields needed to
// drive both regions' rendering; the drawer re-fetches the full record on
// demand if the user clicks through.

import { useEffect, useMemo, useState } from 'react';

import type { Project, WorkflowRun } from '@/api/client';
import { api } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';

interface RunChangedEnvelope extends WsEnvelope {
  type: 'workflow-run-changed';
  runId: string;
  workflowId: string;
  status: string;
  nodeOutputs: Record<string, unknown>;
}

function isRunChangedEnvelope(env: WsEnvelope): env is RunChangedEnvelope {
  return env.type === 'workflow-run-changed';
}

export function useProjectWorkflowRuns(
  project: Project | null,
  events: WsEnvelope[],
): { runs: WorkflowRun[]; refetch: () => void } {
  const [runMap, setRunMap] = useState<Map<string, WorkflowRun>>(() => new Map());

  // Initial fetch + project switch.
  useEffect(() => {
    if (!project) {
      setRunMap(new Map());
      return;
    }
    let cancelled = false;
    void api.listWorkflowRuns(project.id).then((list) => {
      if (cancelled) return;
      setRunMap(new Map(list.map((r) => [r.id, r])));
    });
    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  // Live tick: patch in place when `workflow-run-changed` arrives. New runs
  // (not in the map) need a full fetch — the envelope only carries the
  // minimum subset.
  useEffect(() => {
    if (!project || events.length === 0) return;
    const last = events[events.length - 1];
    if (!last || !isRunChangedEnvelope(last)) return;
    setRunMap((prev) => {
      const existing = prev.get(last.runId);
      if (!existing) {
        // New run — schedule a refetch; don't block this render path.
        void api.listWorkflowRuns(project.id).then((list) => {
          setRunMap(new Map(list.map((r) => [r.id, r])));
        });
        return prev;
      }
      const next = new Map(prev);
      next.set(last.runId, {
        ...existing,
        status: last.status as WorkflowRun['status'],
        nodeOutputs: last.nodeOutputs as WorkflowRun['nodeOutputs'],
      });
      return next;
    });
  }, [events, project?.id]);

  const runs = useMemo(() => Array.from(runMap.values()), [runMap]);

  return {
    runs,
    refetch: () => {
      if (!project) return;
      void api.listWorkflowRuns(project.id).then((list) => {
        setRunMap(new Map(list.map((r) => [r.id, r])));
      });
    },
  };
}
