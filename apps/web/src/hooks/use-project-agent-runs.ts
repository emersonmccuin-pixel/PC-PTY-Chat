// Section 16b.8.2 — Activity Panel "Running agents" region read model.
//
// Mirrors useProjectWorkflowRuns: initial fetch on mount, then patch the
// in-memory map from `agent-run-changed` WS envelopes. The server's
// `agent-run-changed` envelope carries the FULL public `AgentRunRecord` (not
// a delta) — so unlike the workflow-run pattern we never need to refetch on
// new ids or on terminal transitions. Terminal-status runs are dropped from
// the map at delta time so the Running agents region only ever shows
// in-flight rows.

import { useEffect, useMemo, useState } from 'react';

import type { AgentRunRecord, Project } from '@/api/client';
import { api } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';

interface AgentRunChangedEnvelope extends WsEnvelope {
  type: 'agent-run-changed';
  record: AgentRunRecord;
}

function isAgentRunChangedEnvelope(env: WsEnvelope): env is AgentRunChangedEnvelope {
  return env.type === 'agent-run-changed';
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
  const [runMap, setRunMap] = useState<Map<string, AgentRunRecord>>(
    () => new Map(),
  );

  useEffect(() => {
    if (!project) {
      setRunMap(new Map());
      return;
    }
    let cancelled = false;
    void api.listAgentRuns(project.id).then((list) => {
      if (cancelled) return;
      setRunMap(new Map(list.map((r) => [r.runId, r])));
    });
    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  useEffect(() => {
    if (!project || events.length === 0) return;
    const last = events[events.length - 1];
    if (!last || !isAgentRunChangedEnvelope(last)) return;
    if (last.record.projectId !== project.id) return;
    setRunMap((prev) => {
      const next = new Map(prev);
      if (TERMINAL.has(last.record.status)) {
        next.delete(last.record.runId);
      } else {
        next.set(last.record.runId, last.record);
      }
      return next;
    });
  }, [events, project?.id]);

  const runs = useMemo(() => Array.from(runMap.values()), [runMap]);
  return { runs };
}
