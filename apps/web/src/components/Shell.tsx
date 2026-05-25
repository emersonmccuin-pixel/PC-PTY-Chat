// Vendored from emersonmccuin-pixel/project-companion @ 6053ad6 (MIT)
// Source: apps/web/src/components/Shell.tsx
// Adapted for Project Companion: react-resizable-panels v4 API; active-slug
// from zustand store; per-project tab persistence from a tab-store.
//
// v4 sizing gotcha: numeric Panel size props ({18}) are pixels; strings
// without a unit are percentages; "18%" is explicit. Always use the string
// form for percent-based layouts or you get pixel constraints that lock
// the rails to ~20px wide. (Found 2026-05-17 after a UX bug report.)

import { useEffect, useMemo } from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';

import type { AgentRunRecord, Project } from '@/api/client';
import type { WsEnvelope, WsOutbound, WsStatus } from '@/hooks/use-project-ws';
import { useProjectAgentRuns } from '@/hooks/use-project-agent-runs';
import { useActiveCenterTab } from '@/store/active-center-tab';
import { useActiveProject } from '@/store/active-project';
import { useAgentTranscript } from '@/store/agent-transcript';
import { ActivityPanel } from './ActivityPanel';
import { AgentsList } from './AgentsList';
import { AgentTranscriptModal } from './AgentTranscriptModal';
import { FilesViewer } from './FilesViewer';
import { KanbanBoard } from './KanbanBoard';
import { LeftRail } from './LeftRail';
import { Orchestrator } from './Orchestrator';
import { AttachmentLightboxMount } from './AttachmentLightbox';
import { ChatWorkItemModalMount } from './ChatWorkItemModalMount';
import { ProjectSettingsPanel } from './ProjectSettingsPanel';
import { RemoteControlCorner } from './RemoteControlCorner';
import { RichLinkPreviewCard } from './RichLinkPreviewCard';
import { TabBar } from './Tabs';
import { WorkflowList } from './WorkflowList';
import { WorkflowDrawer } from './workflows/WorkflowDrawer';

// Section 32.1 — TabBar lifted to a topbar but spanning the full width
// confused users. Refinement (Session 31) puts the tab strip back above the
// Center column only; rail + activity panel keep their own headers.

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
    <div className="flex h-full flex-col">
      <Group
        orientation="horizontal"
        id="pc-shell-v3"
        className="flex-1 min-h-0"
      >
        <Panel id="rail" defaultSize={192} minSize={192} maxSize={192}>
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
        <Panel id="center" defaultSize="70%" minSize="30%">
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
          defaultSize={192}
          minSize={192}
          maxSize={192}
          collapsible
          collapsedSize={36}
        >
          <ActivityPanel
            project={activeProject}
            events={wsEvents}
            expanded={activityPanelOpen}
            onExpand={() => onToggleActivityPanelOpen(true)}
          />
        </Panel>
        {activeProject && (
          <WorkflowDrawer projectId={activeProject.id} events={wsEvents} />
        )}
        {activeProject && (
          <AgentTranscriptModalMount
            project={activeProject}
            events={wsEvents}
          />
        )}
        {activeProject && (
          <ChatWorkItemModalMount project={activeProject} events={wsEvents} />
        )}
        {activeProject && <AttachmentLightboxMount projectId={activeProject.id} />}
        <RichLinkPreviewCard />
      </Group>
    </div>
  );
}

// 28.5 — single mount above tab content so any surface (Activity Panel,
// AgentDispatchGroupBubble in chat, future surfaces) can open the modal
// via the useAgentTranscript store. Derives the displayed AgentRunRecord
// from events + the project's agent-runs map.
function AgentTranscriptModalMount({
  project,
  events,
}: {
  project: Project;
  events: WsEnvelope[];
}) {
  const openRunId = useAgentTranscript((s) => s.runId);
  const close = useAgentTranscript((s) => s.close);
  const { runs: agentRuns } = useProjectAgentRuns(project, events);

  // Same fallback pattern ActivityPanel used pre-28.5: prefer the latest
  // matching agent-run-changed envelope (carries terminal status even
  // after useProjectAgentRuns drops the row from its map); fall back to
  // the live agentRuns list.
  const transcriptRun = useMemo<AgentRunRecord | null>(() => {
    if (!openRunId) return null;
    for (let i = events.length - 1; i >= 0; i--) {
      const env = events[i];
      if (!env || env.type !== 'agent-run-changed') continue;
      const record = (env as { record?: AgentRunRecord }).record;
      if (record && record.runId === openRunId) return record;
    }
    return agentRuns.find((r) => r.runId === openRunId) ?? null;
  }, [openRunId, events, agentRuns]);

  if (!transcriptRun) return null;
  return <AgentTranscriptModal run={transcriptRun} events={events} onClose={close} />;
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
      <div className="relative flex-1 overflow-hidden">
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
        ) : tab === 'agents' ? (
          <AgentsList project={activeProject} events={wsEvents} />
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
        <RemoteControlCorner events={wsEvents} />
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
