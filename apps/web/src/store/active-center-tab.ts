// App-global active center tab. Switching projects keeps you on whichever
// tab you were last on (5+P.A). Replaces the prior per-project tab map.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { Tab } from '@/components/Tabs';

interface ActiveCenterTabState {
  tab: Tab;
  setTab: (tab: Tab) => void;
}

export const useActiveCenterTab = create<ActiveCenterTabState>()(
  persist(
    (set) => ({
      tab: 'work-items',
      setTab: (tab) => set({ tab }),
    }),
    { name: 'pc.center-tab' },
  ),
);
