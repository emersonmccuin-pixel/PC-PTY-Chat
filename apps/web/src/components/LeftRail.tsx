// LeftRail — Section 32.2 reshape: project tiles (56px compact) by default;
// expands to 240px for Sessions list or Files tree. The old Projects/Sessions
// tab toggle in the header is gone — projects live as wax-stamp tiles, the
// footer "sessions" link flips the rail into Sessions mode, and an explicit
// "‹ projects" link in the expanded modes flips back.
//
// Center-tab = files still overrides the rail content to FilesRail (5+P.C
// behavior preserved); the rail auto-expands to 240px in that case via the
// width derivation in Shell.tsx that watches centerTab + railMode.

import type { Project } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';
import { useActiveCenterTab } from '@/store/active-center-tab';
import { useRailMode } from '@/store/rail-mode';
import { FilesRail } from './FilesRail';
import { ProjectTiles } from './ProjectTiles';
import { SessionsRail } from './SessionsRail';

interface LeftRailProps {
  projects: Project[];
  activeProject: Project | null;
  events: WsEnvelope[];
  onCreateProject: () => void;
  onProjectDeleted: (projectId: string) => void;
  onProjectReorder: (orderedIds: string[]) => void;
}

export function LeftRail({
  projects,
  activeProject,
  events,
  onCreateProject,
  onProjectDeleted,
  onProjectReorder,
}: LeftRailProps) {
  const mode = useRailMode((s) => s.mode);
  const setMode = useRailMode((s) => s.setMode);
  const centerTab = useActiveCenterTab((s) => s.tab);
  const setCenterTab = useActiveCenterTab((s) => s.setTab);

  if (centerTab === 'files') {
    return (
      <div className="flex h-full flex-col">
        <button
          onClick={() => setCenterTab('orchestrator')}
          className="border-b border-border bg-card px-3 py-2 text-left text-[10px] uppercase tracking-[0.08em] text-muted-foreground hover:text-accent"
          title="Leave files view"
        >
          ‹ projects
        </button>
        <div className="flex-1 overflow-hidden">
          <FilesRail project={activeProject} />
        </div>
      </div>
    );
  }

  if (mode === 'sessions') {
    return (
      <div className="flex h-full flex-col">
        <button
          onClick={() => setMode('projects')}
          className="border-b border-border bg-card px-3 py-2 text-left text-[10px] uppercase tracking-[0.08em] text-muted-foreground hover:text-accent"
          title="Back to project tiles"
        >
          ‹ projects
        </button>
        <div className="flex-1 overflow-hidden">
          <SessionsRail project={activeProject} events={events} />
        </div>
      </div>
    );
  }

  return (
    <ProjectTiles
      projects={projects}
      onCreateProject={onCreateProject}
      onProjectDeleted={onProjectDeleted}
      onProjectReorder={onProjectReorder}
      onOpenSessions={() => setMode('sessions')}
    />
  );
}
