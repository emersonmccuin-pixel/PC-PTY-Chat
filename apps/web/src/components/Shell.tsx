// Vendored from emersonmccuin-pixel/project-companion @ 6053ad6 (MIT)
// Source: apps/web/src/components/Shell.tsx
// Adapted for Project Companion: react-resizable-panels v4 API; active-slug
// from zustand store; per-project tab persistence from a tab-store.
//
// v4 sizing gotcha: numeric Panel size props ({18}) are pixels; strings
// without a unit are percentages; "18%" is explicit. Always use the string
// form for percent-based layouts or you get pixel constraints that lock
// the rails to ~20px wide. (Found 2026-05-17 after a UX bug report.)

import { useEffect } from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';

import type { Project } from '@/api/client';
import type { WsEnvelope, WsOutbound, WsStatus } from '@/hooks/use-project-ws';
import { useActiveCenterTab } from '@/store/active-center-tab';
import { useActiveProject } from '@/store/active-project';
import { ActivityPanel } from './ActivityPanel';
import { FilesViewer } from './FilesViewer';
import { KanbanBoard } from './KanbanBoard';
import { LeftRail } from './LeftRail';
import { Orchestrator } from './Orchestrator';
import { ProjectSettingsPanel } from './ProjectSettingsPanel';
import { TabBar } from './Tabs';
import { WorkflowList } from './WorkflowList';
import { WorkflowDrawer } from './workflows/WorkflowDrawer';

interface ShellProps {
  projects: Project[];
  activityPanelOpen: boolean;
  onToggleActivityPanelOpen: (next: boolean) => void;
  onCreateProject: () => void;
  onProjectUpdated: (next: Project) => void;
  onProjectDeleted: (projectId: string) => void;
  onProjectReorder: (orderedIds: string[]) => void;
  wsEvents: WsEnvelope[];
  wsSend: (msg: WsOutbound) => boolean;
  wsClear: () => void;
  wsStatus: WsStatus;
}

export function Shell({
  projects,
  activityPanelOpen,
  onToggleActivityPanelOpen,
  onCreateProject,
  onProjectUpdated,
  onProjectDeleted,
  onProjectReorder,
  wsEvents,
  wsSend,
  wsClear,
  wsStatus,
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
    <Group
      orientation="horizontal"
      id="pc-shell-v3"
      className="h-full"
    >
      <Panel id="rail" defaultSize="14%" minSize="14%" maxSize="14%">
        <LeftRail
          projects={projects}
          activeProject={activeProject}
          events={wsEvents}
          onCreateProject={onCreateProject}
          onProjectDeleted={onProjectDeleted}
          onProjectReorder={onProjectReorder}
        />
      </Panel>
      <Separator className="w-px bg-border" />
      <Panel id="center" defaultSize="72%" minSize="30%">
        <Center
          activeProject={activeProject}
          projectCount={projects.length}
          wsEvents={wsEvents}
          wsSend={wsSend}
          wsClear={wsClear}
          wsStatus={wsStatus}
          onCreateProject={onCreateProject}
          onProjectUpdated={onProjectUpdated}
          onProjectDeleted={onProjectDeleted}
        />
      </Panel>
      <Separator className="w-px bg-border" />
      <Panel
        id="activity"
        panelRef={activityRef}
        defaultSize="14%"
        minSize="14%"
        maxSize="14%"
        collapsible
        collapsedSize="0%"
      >
        <ActivityPanel
          project={activeProject}
          events={wsEvents}
          onClose={() => onToggleActivityPanelOpen(false)}
        />
      </Panel>
      {activeProject && (
        <WorkflowDrawer projectId={activeProject.id} events={wsEvents} />
      )}
    </Group>
  );
}

function Center({
  activeProject,
  projectCount,
  wsEvents,
  wsSend,
  wsClear,
  wsStatus,
  onCreateProject,
  onProjectUpdated,
  onProjectDeleted,
}: {
  activeProject: Project | null;
  projectCount: number;
  wsEvents: WsEnvelope[];
  wsSend: (msg: WsOutbound) => boolean;
  wsClear: () => void;
  wsStatus: WsStatus;
  onCreateProject: () => void;
  onProjectUpdated: (next: Project) => void;
  onProjectDeleted: (projectId: string) => void;
}) {
  const tab = useActiveCenterTab((s) => s.tab);
  const setTab = useActiveCenterTab((s) => s.setTab);

  if (!activeProject) {
    return <EmptyState projectCount={projectCount} onCreateProject={onCreateProject} />;
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <TabBar value={tab} onChange={setTab} />
      <div className="flex-1 overflow-hidden">
        {tab === 'work-items' ? (
          <KanbanBoard project={activeProject} events={wsEvents} />
        ) : tab === 'orchestrator' ? (
          <Orchestrator
            project={activeProject}
            events={wsEvents}
            send={wsSend}
            clearWs={wsClear}
            wsStatus={wsStatus}
          />
        ) : tab === 'workflows' ? (
          <WorkflowList project={activeProject} events={wsEvents} send={wsSend} />
        ) : tab === 'files' ? (
          <FilesViewer project={activeProject} />
        ) : tab === 'project-settings' ? (
          <ProjectSettingsPanel
            project={activeProject}
            events={wsEvents}
            onProjectUpdated={onProjectUpdated}
            onProjectDeleted={onProjectDeleted}
          />
        ) : null}
      </div>
    </div>
  );
}

function EmptyState({
  projectCount,
  onCreateProject,
}: {
  projectCount: number;
  onCreateProject: () => void;
}) {
  // No projects at all → prominent first-run CTA (D85). At least one project
  // but none active (rail unselected) → quieter "pick a project" hint.
  if (projectCount === 0) {
    return (
      <div className="grid h-full place-items-center bg-background">
        <div className="flex max-w-md flex-col items-center gap-4 px-6 text-center">
          <h1 className="text-2xl font-semibold text-foreground">
            Create your first project
          </h1>
          <p className="text-sm text-muted-foreground">
            Project Companion turns a folder on disk into a chat-driven
            workspace: orchestrator conversations, work items, and workflows
            scoped to one project at a time.
          </p>
          <button
            onClick={onCreateProject}
            className="bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Create your first project
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="grid h-full place-items-center bg-background text-muted-foreground">
      <div className="text-sm">Select a project from the rail.</div>
    </div>
  );
}
