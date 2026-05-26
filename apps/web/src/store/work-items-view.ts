// Work-items view preferences. Section 26.7: "See Agent Contracts" toggle
// that hides `isAgentTask` rows from the kanban (and the table view).
// Flipped to OFF in Section 1.5.10 — agent work items now surface in chat
// as rich-link pills (hover preview + click to modal), so kanban no longer
// needs to render them by default. User can re-enable via the toolbar
// toggle if they want to see the full picture.
//
// Section 37: extended with `activeSubTab` for the Dashboard / Kanban / Table
// sub-tab strip above the Work Items page. Default = 'dashboard'.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type WorkItemsSubTab = 'dashboard' | 'kanban' | 'table';

interface WorkItemsViewState {
  showAgentContracts: boolean;
  setShowAgentContracts: (value: boolean) => void;
  activeSubTab: WorkItemsSubTab;
  setActiveSubTab: (tab: WorkItemsSubTab) => void;
}

export const useWorkItemsView = create<WorkItemsViewState>()(
  persist(
    (set) => ({
      showAgentContracts: false,
      setShowAgentContracts: (showAgentContracts) => set({ showAgentContracts }),
      activeSubTab: 'dashboard',
      setActiveSubTab: (activeSubTab) => set({ activeSubTab }),
    }),
    { name: 'pc.work-items-view' },
  ),
);
