// 17b.11c — Shell-level effect that drives the AgentDesignerSessionModal
// OPEN behavior. Watches the WS event stream for `agent-run-changed`
// envelopes where record.agentName === 'agent-designer':
//
//   - When a non-terminal status arrives for a NEW runId, set the store.
//     (Open the modal.)
//   - On terminal status (completed/failed/cancelled): the hook does NOT
//     auto-close. The user reads the final state and closes manually via
//     the Close button. Auto-close caused confusion when an agent-designer
//     dispatch terminated without ever pausing (e.g. agent forgot to call
//     pc_ask_user) — the modal popped + immediately vanished, leaving no
//     trace. Letting the user dismiss explicitly is the safer default.
//
// Resilient to multiple agent-designer runs across one session — only the
// latest live one is shown. If two are running concurrently (rare),
// preferring the latest means the user always sees the freshest dispatch.

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
        // Do NOT auto-close — user closes manually after reading the final
        // state. See header comment for rationale.
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
