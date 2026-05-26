// Section 19.20 — Cross-tab navigation primitive for the Workflows page.
//
// Replaces the 19.12 `workflow-v2-run-viewer` modal store. Callers no longer
// pop a modal; they push a directive into this store, the active center tab
// switches to "workflows" (caller responsibility), and `WorkflowsList`
// consumes the directive: select the row by slug, set the detail tab, set
// the selected run id (Runs tab uses this to highlight + render inline).
//
// Generation counter (`nav`) so re-issuing the same directive still triggers
// the consume effect — set-state-equal isn't a no-op when the consumer keys
// on an integer.

import { create } from 'zustand';

export type WorkflowsListNavTab = 'graph' | 'runs' | 'yaml';

interface WorkflowsListNavState {
  /** YAML slug of the workflow to highlight in the rail. The row.id (ULID)
   *  is resolved inside `WorkflowsList` via the project's workflows list. */
  workflowSlug: string | null;
  /** Run id to highlight in the Runs tab + render the inline detail for. */
  runId: string | null;
  /** Which detail-pane tab to land on. Defaults to `runs` when a runId is
   *  passed, `graph` otherwise. */
  tab: WorkflowsListNavTab | null;
  /** Bumped on every `openTo` call so the consumer effect fires even when the
   *  next directive matches the previous one verbatim. */
  nav: number;

  openTo: (input: {
    workflowSlug: string;
    runId?: string;
    tab?: WorkflowsListNavTab;
  }) => void;
  /** Marks the directive consumed. The store's slug/runId/tab stay so the
   *  WorkflowsList can read them on remount within the same nav burst. */
  consume: () => void;
}

export const useWorkflowsListNav = create<WorkflowsListNavState>((set) => ({
  workflowSlug: null,
  runId: null,
  tab: null,
  nav: 0,
  openTo: ({ workflowSlug, runId, tab }) =>
    set((s) => ({
      workflowSlug,
      runId: runId ?? null,
      tab: tab ?? (runId ? 'runs' : 'graph'),
      nav: s.nav + 1,
    })),
  consume: () => set({ workflowSlug: null, runId: null, tab: null }),
}));
