// 4e.4 / D51 — drawer-open state for the per-workflow run history drawer.
//
// Single-level navigation: when `runId` is set the drawer body shows that
// run's detail; the workflow header stays pinned above so the user knows
// what they're inside. Closing wipes both so a re-open lands on the Runs
// list (not stale run detail).

import { create } from 'zustand';

interface WorkflowDrawerState {
  workflowId: string | null;
  runId: string | null;
  open: (workflowId: string) => void;
  /** Opens the drawer and lands directly on a specific run's detail view.
   *  Used by 4f.3 manual-fire: on submit success, jump the user to the
   *  brand-new run so they can watch it start. */
  openTo: (workflowId: string, runId: string) => void;
  openRun: (runId: string) => void;
  backToRuns: () => void;
  close: () => void;
}

export const useWorkflowDrawer = create<WorkflowDrawerState>((set) => ({
  workflowId: null,
  runId: null,
  open: (workflowId) => set({ workflowId, runId: null }),
  openTo: (workflowId, runId) => set({ workflowId, runId }),
  openRun: (runId) => set({ runId }),
  backToRuns: () => set({ runId: null }),
  close: () => set({ workflowId: null, runId: null }),
}));
