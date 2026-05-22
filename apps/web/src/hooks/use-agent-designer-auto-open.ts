// 17b.11c — Shell-level effect that drives the AgentDesignerSessionModal
// open/close. Watches the WS event stream for `agent-run-changed` envelopes
// where record.agentName === 'agent-designer':
//
//   - When a non-terminal status arrives for a NEW runId, set the store.
//     (Open the modal.)
//   - When a terminal status (completed/failed/cancelled) arrives for the
//     currently-open runId, clear the store. (Close the modal — and surface
//     a one-line summary in chat is the orchestrator's job, not the
//     modal's.)
//
// Resilient to multiple agent-designer runs across one session — only the
// latest live one is shown. If two are running concurrently (rare),
// preferring the latest means the user always sees the freshest dispatch.
// Manual close (clear) is also fine — the run keeps going, the modal just
// stays closed until the next dispatch.

import { useEffect, useRef } from 'react';

import type { AgentRunRecord } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';
import { useAgentDesignerSession } from '@/store/agent-designer-session';

const TERMINAL = new Set<AgentRunRecord['status']>([
  'completed',
  'failed',
  'cancelled',
]);

interface AgentRunChangedEnvelope extends WsEnvelope {
  type: 'agent-run-changed';
  record: AgentRunRecord;
}

function isAgentRunChanged(env: WsEnvelope): env is AgentRunChangedEnvelope {
  return env.type === 'agent-run-changed';
}

export function useAgentDesignerAutoOpen(events: WsEnvelope[]): void {
  const lastProcessedRef = useRef(0);
  const runId = useAgentDesignerSession((s) => s.runId);
  const setRunId = useAgentDesignerSession((s) => s.setRunId);
  const clear = useAgentDesignerSession((s) => s.clear);

  useEffect(() => {
    const start = events.length >= lastProcessedRef.current ? lastProcessedRef.current : 0;
    const end = events.length;
    lastProcessedRef.current = end;
    for (let i = start; i < end; i++) {
      const env = events[i];
      if (!env || !isAgentRunChanged(env)) continue;
      const rec = env.record;
      if (!rec || rec.agentName !== 'agent-designer') continue;

      if (TERMINAL.has(rec.status)) {
        // Close the modal only if it's attached to THIS run. Don't clobber a
        // newer dispatch's modal because an older terminal envelope arrives
        // out of order (rare but theoretically possible).
        if (runId === rec.runId) clear();
        continue;
      }

      // Non-terminal status. Open the modal for this run if it's not
      // already the one attached.
      if (runId !== rec.runId) {
        setRunId(rec.runId);
      }
    }
    // We deliberately do NOT depend on `runId` here — that would re-run the
    // effect every time the store changes, re-scanning events from scratch.
    // The ref-based cursor + the per-iteration `runId` read are sufficient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);
}
