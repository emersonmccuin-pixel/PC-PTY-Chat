// MCP detail panel open/close. Lifted from StatusBar local state so the
// `/mcp` ability can open the same panel without duplicating the UI.

import { create } from 'zustand';

interface McpPanelState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useMcpPanel = create<McpPanelState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
