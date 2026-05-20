// App Settings modal open/close. Lifted from App.tsx local state so the
// `/app-settings` ability can open the modal without passing callbacks
// through the Shell→Orchestrator prop chain.

import { create } from 'zustand';

interface AppSettingsModalState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useAppSettingsModal = create<AppSettingsModalState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
