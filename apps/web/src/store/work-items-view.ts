// Work-items view preferences. Section 26.7: "See Agent Contracts" toggle
// that hides `isAgentTask` rows from the kanban (and the future table view).
// Flipped to OFF in Section 1.5.10 — agent work items now surface in chat
// as rich-link pills (hover preview + click to modal), so kanban no longer
// needs to render them by default. User can re-enable via the toolbar
// toggle if they want to see the full picture.
//
// Global for v1. Section 14's per-project filter store absorbs this when it
// lands; persist key stays so migration can read the old value.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface WorkItemsViewState {
  showAgentContracts: boolean;
  setShowAgentContracts: (value: boolean) => void;
}

export const useWorkItemsView = create<WorkItemsViewState>()(
  persist(
    (set) => ({
      showAgentContracts: false,
      setShowAgentContracts: (showAgentContracts) => set({ showAgentContracts }),
    }),
    { name: 'pc.work-items-view' },
  ),
);
