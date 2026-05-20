// Open/close state for the Abilities tray. Lifted to a store so the `/`
// keystroke handler in the Composer textarea can open the tray that lives
// above it.

import { create } from 'zustand';

interface AbilitiesTrayState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useAbilitiesTray = create<AbilitiesTrayState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
