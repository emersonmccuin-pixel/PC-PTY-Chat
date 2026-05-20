// Left-rail mode: Projects list vs. Sessions list. Persisted so reloads
// restore the last view. (5+P.C: Files exited the rail tab strip — the rail
// content overrides to FilesRail whenever the center tab is Files, regardless
// of `mode`. Legacy persisted `'files'` values coerce to `'projects'`.)

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type RailMode = 'projects' | 'sessions';

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
    {
      name: 'pc.rail-mode',
      version: 1,
      migrate: (persisted) => {
        const s = persisted as { mode?: string } | null;
        const mode: RailMode =
          s?.mode === 'sessions' ? 'sessions' : 'projects';
        return { mode } as RailModeState;
      },
    },
  ),
);
