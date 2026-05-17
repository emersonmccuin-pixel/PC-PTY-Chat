// Vendored from emersonmccuin-pixel/project-companion @ 6053ad6 (MIT)
// Source: apps/web/src/components/Shell.tsx
// Adapted for Project Companion: stripped to the 3-col skeleton — center area
// renders an empty-state placeholder until Q5+ tabs land. ActivityPanel +
// ProjectRail stubs swap in via later Q-milestones (Q12, Q5). API migrated to
// react-resizable-panels v4 (Group/Panel/Separator + usePanelRef hook).
// Active-project state read from zustand directly inside children.

import { useEffect } from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';

import type { Project } from '@/api/client';
import type { WsEnvelope, WsStatus } from '@/hooks/use-project-ws';
import { useActiveProject } from '@/store/active-project';
import { ActivityPanel } from './ActivityPanel';
import { ProjectRail } from './ProjectRail';

interface ShellProps {
  projects: Project[];
  activityPanelOpen: boolean;
  onToggleActivityPanelOpen: (next: boolean) => void;
  onCreateProject: () => void;
  wsEvents: WsEnvelope[];
  wsStatus: WsStatus;
}

export function Shell({
  projects,
  activityPanelOpen,
  onToggleActivityPanelOpen,
  onCreateProject,
  wsEvents,
  wsStatus,
}: ShellProps) {
  const activityRef = usePanelRef();
  const activeSlug = useActiveProject((s) => s.activeSlug);
  const activeProject = projects.find((p) => p.slug === activeSlug) ?? null;

  // Sync the imperative panel to the persisted `open` flag — settings is the
  // source of truth (header chevron and app-settings both flip it).
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
        <Center activeProject={activeProject} />
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
          events={wsEvents}
          status={wsStatus}
          onClose={() => onToggleActivityPanelOpen(false)}
        />
      </Panel>
    </Group>
  );
}

function Center({ activeProject }: { activeProject: Project | null }) {
  if (!activeProject) {
    return (
      <div className="grid h-full place-items-center bg-background text-muted-foreground">
        <div className="text-sm">Create a project to get started.</div>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b border-border px-4 py-2 text-sm">
        <span className="text-muted-foreground">project:</span>{' '}
        <span className="font-semibold text-foreground">{activeProject.name}</span>{' '}
        <span className="text-muted-foreground">/ {activeProject.slug}</span>
      </div>
      <div className="grid flex-1 place-items-center text-muted-foreground">
        <div className="text-sm">Workspace tabs land in Q7+.</div>
      </div>
    </div>
  );
}
