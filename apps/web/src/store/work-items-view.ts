// Work-items view preferences. Section 26.7: "See Agent Contracts" toggle
// that hides `isAgentTask` rows from the kanban (and the future table view).
// Defaults to ON during Section 26 dogfood; flip default to OFF when Section
// 1.5 ships the chat rich-link / hover-preview surface.
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
      showAgentContracts: true,
      setShowAgentContracts: (showAgentContracts) => set({ showAgentContracts }),
    }),
    { name: 'pc.work-items-view' },
  ),
);
