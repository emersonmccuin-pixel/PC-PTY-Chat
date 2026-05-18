// One-shot scroll target for ProjectSettingsPanel. The /agents ability sets
// `target: 'agents'`; the panel's useEffect scrolls to the matching section
// and clears the target. Decoupled from the panel so the ability dispatcher
// doesn't need a callback chain through Shell/Orchestrator.

import { create } from 'zustand';

export type ProjectSettingsTarget = 'agents';

interface ProjectSettingsFocusState {
  target: ProjectSettingsTarget | null;
  setTarget: (target: ProjectSettingsTarget | null) => void;
}

export const useProjectSettingsFocus = create<ProjectSettingsFocusState>((set) => ({
  target: null,
  setTarget: (target) => set({ target }),
}));
