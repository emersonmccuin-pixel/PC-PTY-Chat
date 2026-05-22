// 17b.11 — Auto-pop store for the AgentDesignerSessionModal.
//
// When the orchestrator dispatches agent-designer (via pc_invoke_agent),
// the server emits `agent-run-changed` with record.agentName ===
// 'agent-designer' + status='running'. A Shell-level effect watches for
// this and sets `runId` here; the modal mounted at Shell level renders
// when runId is non-null.
//
// On terminal status (completed/failed/cancelled), the same effect clears
// the runId — closing the modal automatically.
//
// Pattern mirrors workflow-drawer + chat-scroll-target stores.

import { create } from 'zustand';

interface AgentDesignerSessionState {
  /** Live runId of the agent-designer dispatch the modal is attached to.
   *  Null when no modal is open. */
  runId: string | null;
  /** Open the modal for a specific run. Idempotent if same runId. */
  setRunId: (runId: string) => void;
  /** Close the modal. */
  clear: () => void;
}

export const useAgentDesignerSession = create<AgentDesignerSessionState>(
  (set) => ({
    runId: null,
    setRunId: (runId) => set({ runId }),
    clear: () => set({ runId: null }),
  }),
);
