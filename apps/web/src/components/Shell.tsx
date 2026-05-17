// Vendored from emersonmccuin-pixel/project-companion @ 6053ad6 (MIT)
// Source: apps/web/src/components/Shell.tsx
// Adapted for Project Companion: react-resizable-panels v4 API; active-slug
// from zustand store; per-project tab persistence from a tab-store.

import { useEffect } from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';

import type { Project } from '@/api/client';
import type { WsEnvelope, WsOutbound, WsStatus } from '@/hooks/use-project-ws';
// WsStatus is used in props (activityStatus) below.
import { useActiveProject } from '@/store/active-project';
import { usePerProjectTab } from '@/store/per-project-tab';
import { ActivityPanel } from './ActivityPanel';
import { KanbanBoard } from './KanbanBoard';
import { Orchestrator } from './Orchestrator';
import { ProjectRail } from './ProjectRail';
import { ProjectSettingsPanel } from './ProjectSettingsPanel';
import { TabBar, TABS, type Tab } from './Tabs';
import { WorkflowList } from './WorkflowList';

interface ShellProps {
  projects: Project[];
  activityPanelOpen: boolean;
  onToggleActivityPanelOpen: (next: boolean) => void;
  onCreateProject: () => void;
  onProjectUpdated: (next: Project) => void;
  onProjectDeleted: (projectId: string) => void;
  wsEvents: WsEnvelope[];
  wsSend: (msg: WsOutbound) => boolean;
  activityEvents: WsEnvelope[];
  activityStatus: WsStatus;
  showAllProjects: boolean;
  onToggleShowAllProjects: (next: boolean) => void;
}

export function Shell({
  projects,
  activityPanelOpen,
  onToggleActivityPanelOpen,
  onCreateProject,
  onProjectUpdated,
  onProjectDeleted,
  wsEvents,
  wsSend,
  activityEvents,
  activityStatus,
  showAllProjects,
  onToggleShowAllProjects,
}: ShellProps) {
  const activityRef = usePanelRef();
  const activeSlug = useActiveProject((s) => s.activeSlug);
  const activeProject = projects.find((p) => p.slug === activeSlug) ?? null;

  useEffect(() => {
    const panel = activityRef.current;
    if (!panel) return;
    const collapsed = panel.isCollapsed();
    if (activityPanelOpen && collapsed) panel.expand();
    else if (!activityPanelOpen && !collapsed) panel.collapse();
  }, [activityPanelOpen, activityRef]);

  return (
    <Group orientation="horizontal" id="pc-shell" className="h-full">
      <Panel defaultSize={15} minSize={10} maxSize={30}>
        <ProjectRail projects={projects} onCreateProject={onCreateProject} />
      </Panel>
      <Separator className="w-px bg-border transition-colors hover:bg-primary" />
      <Panel defaultSize={65} minSize={30}>
        <Center
          activeProject={activeProject}
          wsEvents={wsEvents}
          wsSend={wsSend}
          onProjectUpdated={onProjectUpdated}
          onProjectDeleted={onProjectDeleted}
        />
      </Panel>
      <Separator className="w-px bg-border transition-colors hover:bg-primary" />
      <Panel
        panelRef={activityRef}
        defaultSize={20}
        minSize={10}
        maxSize={40}
        collapsible
        collapsedSize={0}
      >
        <ActivityPanel
          projects={projects}
          events={activityEvents}
          status={activityStatus}
          showAllProjects={showAllProjects}
          onToggleShowAll={onToggleShowAllProjects}
          onClose={() => onToggleActivityPanelOpen(false)}
        />
      </Panel>
    </Group>
  );
}

function Center({
  activeProject,
  wsEvents,
  wsSend,
  onProjectUpdated,
  onProjectDeleted,
}: {
  activeProject: Project | null;
  wsEvents: WsEnvelope[];
  wsSend: (msg: WsOutbound) => boolean;
  onProjectUpdated: (next: Project) => void;
  onProjectDeleted: (projectId: string) => void;
}) {
  const storedTab = usePerProjectTab((s) =>
    activeProject ? s.tabBySlug[activeProject.slug] : undefined,
  );
  const setTab = usePerProjectTab((s) => s.setTab);

  if (!activeProject) {
    return (
      <div className="grid h-full place-items-center bg-background text-muted-foreground">
        <div className="text-sm">Create a project to get started.</div>
      </div>
    );
  }

  const tab: Tab = storedTab ?? TABS[1]; // default to work-items

  return (
    <div className="flex h-full flex-col bg-background">
      <TabBar value={tab} onChange={(t) => setTab(activeProject.slug, t)} />
      <div className="flex-1 overflow-hidden">
        {tab === 'work-items' ? (
          <KanbanBoard project={activeProject} events={wsEvents} />
        ) : tab === 'orchestrator' ? (
          <Orchestrator project={activeProject} events={wsEvents} send={wsSend} />
        ) : tab === 'workflows' ? (
          <WorkflowList project={activeProject} events={wsEvents} />
        ) : tab === 'project-settings' ? (
          <ProjectSettingsPanel
            project={activeProject}
            onProjectUpdated={onProjectUpdated}
            onProjectDeleted={onProjectDeleted}
          />
        ) : null}
      </div>
    </div>
  );
}
