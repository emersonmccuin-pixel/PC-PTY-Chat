// Whether the chat is "open" (live chat surface) vs showing the Start-Chat
// launcher, keyed by project slug. Lifted out of the Orchestrator component so
// it survives tab navigation — switching to work-items/agents/etc. unmounts the
// chat, and component-local state would reset to the launcher on return.
//
// Persisted to sessionStorage: stays open across tab switches AND a renderer
// reload within the same app session, but clears when the app (window) closes
// — so a chat stays open until the user closes it, starts a new session, or
// quits the app, and a fresh app launch lands on the launcher (no auto-spawn).

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface ChatOpenState {
  bySlug: Record<string, boolean>;
  setOpen: (projectSlug: string, open: boolean) => void;
}

export const useChatOpen = create<ChatOpenState>()(
  persist(
    (set) => ({
      bySlug: {},
      setOpen: (projectSlug, open) =>
        set((s) => ({ bySlug: { ...s.bySlug, [projectSlug]: open } })),
    }),
    { name: 'caisson.chat.open', storage: createJSONStorage(() => sessionStorage) },
  ),
);
