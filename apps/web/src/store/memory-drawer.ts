// /memory drawer open/close. Drawer mounts inside the Orchestrator chat panel
// and overlays the right half so the chat history stays visible on the left.

import { create } from 'zustand';

interface MemoryDrawerState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useMemoryDrawer = create<MemoryDrawerState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
