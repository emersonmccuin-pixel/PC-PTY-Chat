// UI Spine step 3 — version-aware id-keyed store slice for work items.
//
// Mirrors useProjectWorkflowV2Runs: wraps useResourceList<WorkItem> to
// patch one item in place on each `work-item-changed` envelope, discarding
// any whose `version` ≤ the stored version (guards out-of-order WS delivery).
// Whole-list refetch fires only on mount, project switch, or when an unknown id
// arrives (new item) or a deleted item is observed.

import type { Project } from '@/features/projects/client';
import { workItemsApi, type WorkItem } from '@/features/work-items/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import type { WorkItemChangedEnvelope } from '@/features/runtime/ws-types';
import { useResourceList } from '@/hooks/use-resource-list';

export function useProjectWorkItems(
  project: Project | null,
  events: WsEnvelope[],
): { workItems: WorkItem[]; refetch: () => void } {
  const { records, refetch } = useResourceList<WorkItem>(project, events, {
    envelopeKind: 'work-item-changed',
    extractSnapshot: (env, projectId) => {
      const e = env as WorkItemChangedEnvelope;
      if (e.type !== 'work-item-changed') return null;
      if (!e.workItem || e.workItem.projectId !== projectId) return null;
      // Cast: server WorkItem is a superset of the frontend WorkItem type.
      return e.workItem as unknown as WorkItem;
    },
    getId: (r) => r.id,
    // Deleted items have deletedAt set; treat them as "terminal" so the list
    // refetches (which returns only live rows) and cleans them up.
    isTerminal: (r) => r.deletedAt != null,
    // Deleted items should be dropped from the local map immediately.
    dropOnTerminal: true,
    getVersion: (r) => r.version,
    list: (projectId) => workItemsApi.workItems(projectId),
  });

  return { workItems: records, refetch };
}
