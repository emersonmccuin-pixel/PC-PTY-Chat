// 5+.2 — currently-previewed file in the per-project Files tab. Keyed by
// project slug so each project remembers its last selection while the app is
// running. Not persisted: file selection is transient by intent (a fresh
// reload should land on the empty viewer state).

import { create } from 'zustand';

interface ViewingFileState {
  bySlug: Record<string, string | null>;
  setViewing: (slug: string, path: string | null) => void;
}

export const useViewingFile = create<ViewingFileState>()((set) => ({
  bySlug: {},
  setViewing: (slug, path) =>
    set((s) => ({ bySlug: { ...s.bySlug, [slug]: path } })),
}));
