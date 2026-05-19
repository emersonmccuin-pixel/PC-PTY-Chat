// Left-rail mode: Projects list vs. Sessions list vs. Files tree (for the
// active project). Persisted so reloads restore the last view.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type RailMode = 'projects' | 'sessions' | 'files';

interface RailModeState {
  mode: RailMode;
  setMode: (mode: RailMode) => void;
}

export const useRailMode = create<RailModeState>()(
  persist(
    (set) => ({
      mode: 'projects',
      setMode: (mode) => set({ mode }),
    }),
    { name: 'pc.rail-mode' },
  ),
);
