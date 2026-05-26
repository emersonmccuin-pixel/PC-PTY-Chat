// Section 37.1 — top-level wrapper for the Work Items tab. Hosts the
// Dashboard / Kanban / Table sub-tab strip and routes to the active surface.
// Existing KanbanBoard is preserved unchanged; this just remounts it under a
// new wrapper. Dashboard + Table are placeholders this phase (real builds in
// 37.3/37.4 + 37.7).

import type { Project } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';
import { useWorkItemsView } from '@/store/work-items-view';
import { KanbanBoard } from '../KanbanBoard';
import { DashboardPlaceholder } from './DashboardPlaceholder';
import { TablePlaceholder } from './TablePlaceholder';
import { WorkItemsSubTabs } from './WorkItemsSubTabs';

interface WorkItemsPageProps {
  project: Project;
  events: WsEnvelope[];
}

export function WorkItemsPage({ project, events }: WorkItemsPageProps) {
  const tab = useWorkItemsView((s) => s.activeSubTab);
  return (
    <div className="flex h-full flex-col bg-background">
      <WorkItemsSubTabs />
      <div className="flex-1 overflow-hidden">
        {tab === 'kanban' ? (
          <KanbanBoard project={project} events={events} />
        ) : tab === 'table' ? (
          <TablePlaceholder />
        ) : (
          <DashboardPlaceholder />
        )}
      </div>
    </div>
  );
}
