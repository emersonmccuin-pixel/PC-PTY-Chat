// Section 28.5 — modal-mount state for the agent-run transcript modal.
//
// Mirror of useWorkflowDrawer: one mount lives at Shell level (so any tab
// can open it without being structurally inside ActivityPanel), state lives
// in zustand, every consumer (chat bubble, activity panel) writes to the
// same store.

import { create } from 'zustand';

interface AgentTranscriptState {
  runId: string | null;
  open: (runId: string) => void;
  close: () => void;
}

export const useAgentTranscript = create<AgentTranscriptState>((set) => ({
  runId: null,
  open: (runId) => set({ runId }),
  close: () => set({ runId: null }),
}));
