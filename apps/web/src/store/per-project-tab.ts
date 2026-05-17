// Per-project active-tab persistence. Map<slug, Tab> in localStorage so each
// project remembers which tab the user was last on when they switch away.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { Tab } from '@/components/Tabs';

interface PerProjectTabState {
  tabBySlug: Record<string, Tab>;
  setTab: (slug: string, tab: Tab) => void;
}

export const usePerProjectTab = create<PerProjectTabState>()(
  persist(
    (set) => ({
      tabBySlug: {},
      setTab: (slug, tab) =>
        set((s) => ({ tabBySlug: { ...s.tabBySlug, [slug]: tab } })),
    }),
    { name: 'pc.tabs' },
  ),
);
