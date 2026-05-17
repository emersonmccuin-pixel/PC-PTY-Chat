// "Viewing past session" map, keyed by project id. When set, the Orchestrator
// renders that session's events.jsonl in read-only mode instead of the WS
// live stream. Per-project so switching projects doesn't bleed state.
//
// Not persisted — viewing-past-session is a transient navigation state.
// Refresh = back to live.

import { create } from 'zustand';

interface ViewingSessionState {
  bySlug: Record<string, string | null>;
  setViewing: (projectSlug: string, sessionId: string | null) => void;
}

export const useViewingSession = create<ViewingSessionState>((set) => ({
  bySlug: {},
  setViewing: (projectSlug, sessionId) =>
    set((s) => ({
      bySlug: { ...s.bySlug, [projectSlug]: sessionId },
    })),
}));
