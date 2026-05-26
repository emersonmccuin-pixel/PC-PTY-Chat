// 19.12 — Open-state for the v2 run viewer modal. Tactical bridge that lets
// Activity Panel keep its "click a running workflow to watch it" affordance
// after the v1 drawer is culled. Replaced by the 19.18 detail-pane.

import { create } from 'zustand';

interface WorkflowV2RunViewerState {
  workflowId: string | null;
  runId: string | null;
  open: (workflowId: string, runId: string) => void;
  close: () => void;
}

export const useWorkflowV2RunViewer = create<WorkflowV2RunViewerState>((set) => ({
  workflowId: null,
  runId: null,
  open: (workflowId, runId) => set({ workflowId, runId }),
  close: () => set({ workflowId: null, runId: null }),
}));
