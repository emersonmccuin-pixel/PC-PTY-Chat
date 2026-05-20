// Section 6.5 — cross-tab "jump to chat bubble" plumbing. The activity
// panel's region 4 (workflow human-review) and region 3 (orchestrator
// status) both want to land the user on a specific bubble in the
// orchestrator tab. They flip the center tab to `orchestrator`, then
// request a scroll target here; the chat panel's scroll container listens
// and scrolls + highlights the matching `data-bubble-id` element.
//
// `requestedAt` is bumped on every call so that requesting the same id
// twice in a row still triggers a fresh scroll (the chat panel watches
// requestedAt, not the id).

import { create } from 'zustand';

interface ChatScrollTargetState {
  targetId: string | null;
  requestedAt: number;
  requestScrollTo: (id: string) => void;
  clear: () => void;
}

export const useChatScrollTarget = create<ChatScrollTargetState>((set) => ({
  targetId: null,
  requestedAt: 0,
  requestScrollTo: (id) => set({ targetId: id, requestedAt: Date.now() }),
  clear: () => set({ targetId: null }),
}));
