// Section 37.1 — top-level wrapper for the Work Items tab. Hosts the
// Dashboard / Kanban / Table sub-tab strip and routes to the active surface.
// Section 37.8 — adds the InitiativeInspector overlay. When `inspectedItem`
// is set, the inspector takes over the body below the sub-tab strip; clicking
// any sub-tab or the inspector's back-breadcrumb returns the user. For v1 the
// inspector receives a static WorkItem snapshot at open time + relies on its
// own onWorkItemPatched callback to stay in sync with local edits. Live
// refresh from external orchestrator/agent writes is a follow-up (would need
// either a single-item GET or moving the items list up to this layer).

import { useCallback, useEffect, useState } from 'react';

import type { Project, WorkItem } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';
import { useWorkItemsView, type WorkItemsSubTab } from '@/store/work-items-view';
import { KanbanBoard } from '../KanbanBoard';
import { DashboardPlaceholder } from './DashboardPlaceholder';
import { InitiativeInspector } from './InitiativeInspector';
import { WorkItemsSubTabs } from './WorkItemsSubTabs';
import { WorkItemsTable } from './WorkItemsTable';

interface WorkItemsPageProps {
  project: Project;
  events: WsEnvelope[];
}

export function WorkItemsPage({ project, events }: WorkItemsPageProps) {
  const tab = useWorkItemsView((s) => s.activeSubTab);
  const setTab = useWorkItemsView((s) => s.setActiveSubTab);
  const [inspectedItem, setInspectedItem] = useState<WorkItem | null>(null);
  const [returnTab, setReturnTab] = useState<WorkItemsSubTab>('table');

  // Drop the inspector when the active project switches.
  useEffect(() => {
    setInspectedItem(null);
  }, [project.id]);

  const openInspector = useCallback((item: WorkItem, from: WorkItemsSubTab) => {
    setReturnTab(from);
    setInspectedItem(item);
  }, []);

  const closeInspector = useCallback(() => {
    setInspectedItem(null);
    setTab(returnTab);
  }, [returnTab, setTab]);

  // Switching sub-tabs while inspecting returns to that sub-tab.
  function handleSubTabChange(next: WorkItemsSubTab) {
    if (inspectedItem) setInspectedItem(null);
    setTab(next);
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <WorkItemsSubTabs onBeforeChange={handleSubTabChange} />
      <div className="flex-1 overflow-hidden">
        {inspectedItem ? (
          <InitiativeInspector
            project={project}
            workItem={inspectedItem}
            events={events}
            backLabel={labelForSubTab(returnTab)}
            onBack={closeInspector}
            onWorkItemPatched={(next) => setInspectedItem(next)}
            onNavigate={(next) => setInspectedItem(next)}
          />
        ) : tab === 'kanban' ? (
          <KanbanBoard project={project} events={events} />
        ) : tab === 'table' ? (
          <WorkItemsTable
            project={project}
            events={events}
            onOpenInspector={(item) => openInspector(item, 'table')}
          />
        ) : (
          <DashboardPlaceholder />
        )}
      </div>
    </div>
  );
}

function labelForSubTab(t: WorkItemsSubTab): string {
  switch (t) {
    case 'dashboard':
      return 'Dashboard';
    case 'kanban':
      return 'Kanban';
    case 'table':
      return 'Table';
  }
}
