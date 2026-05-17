// Active-project store. Persisted to localStorage so a reload restores the
// last selection. Q6 wires consumers (WS event filter, scoped API helpers).

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ActiveProjectState {
  activeSlug: string | null;
  setActiveSlug: (slug: string | null) => void;
}

export const useActiveProject = create<ActiveProjectState>()(
  persist(
    (set) => ({
      activeSlug: null,
      setActiveSlug: (activeSlug) => set({ activeSlug }),
    }),
    { name: 'pc.active-project' },
  ),
);
