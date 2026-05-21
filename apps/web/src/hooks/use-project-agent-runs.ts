// Section 16b.8.2 — Activity Panel "Running agents" region read model.
//
// Mirrors useProjectWorkflowRuns: initial fetch on mount, then patch the
// in-memory map from `agent-run-changed` WS envelopes. The server's
// `agent-run-changed` envelope carries the FULL public `AgentRunRecord` (not
// a delta) — so for non-terminal transitions we patch in place.
//
// Terminal transitions also trigger a wholesale refetch (the server route
// filters out terminal rows). B5 (2026-05-21) — without the refetch,
// terminal cards stuck around: this hook only inspects
// `events[events.length - 1]`, and React 18 batches WS messages, so a
// non-agent-run envelope landing in the same batch as the terminal one
// would hide the delete from the per-envelope branch. The refetch
// guarantees the post-terminal state matches the server's filtered list,
// closing the race without rewriting the every-envelope scan logic.

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
    const isTerminal = TERMINAL.has(last.record.status);
    setRunMap((prev) => {
      const next = new Map(prev);
      if (isTerminal) {
        next.delete(last.record.runId);
      } else {
        next.set(last.record.runId, last.record);
      }
      return next;
    });
    if (isTerminal) {
      // Wholesale refetch — the server route filters out terminal rows, so
      // this both removes the just-terminated card AND cleans up any other
      // terminal rows the per-envelope branch missed due to WS batching.
      void api.listAgentRuns(project.id).then((list) => {
        setRunMap(new Map(list.map((r) => [r.runId, r])));
      });
    }
  }, [events, project?.id]);

  const runs = useMemo(() => Array.from(runMap.values()), [runMap]);
  return { runs };
}
