// LeftRail — Projects / Sessions tab wrapper for the rail panel. The Sessions
// view is scoped to the active project; switching projects changes what the
// Sessions tab lists.

import type { Project } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';
import { useRailMode } from '@/store/rail-mode';
import { ProjectRail } from './ProjectRail';
import { SessionsRail } from './SessionsRail';

interface LeftRailProps {
  projects: Project[];
  activeProject: Project | null;
  events: WsEnvelope[];
  onCreateProject: () => void;
  onProjectDeleted: (projectId: string) => void;
}

export function LeftRail({
  projects,
  activeProject,
  events,
  onCreateProject,
  onProjectDeleted,
}: LeftRailProps) {
  const mode = useRailMode((s) => s.mode);
  const setMode = useRailMode((s) => s.setMode);

  return (
    <div className="flex h-full flex-col">
      <div className="flex border-b border-border bg-card text-xs">
        <button
          onClick={() => setMode('projects')}
          className={
            'flex-1 px-3 py-2 ' +
            (mode === 'projects'
              ? 'border-b-2 border-primary text-primary -mb-px'
              : 'text-muted-foreground hover:text-foreground')
          }
        >
          Projects
        </button>
        <button
          onClick={() => setMode('sessions')}
          className={
            'flex-1 px-3 py-2 ' +
            (mode === 'sessions'
              ? 'border-b-2 border-primary text-primary -mb-px'
              : 'text-muted-foreground hover:text-foreground')
          }
        >
          Sessions
        </button>
      </div>
      <div className="flex-1 overflow-hidden">
        {mode === 'projects' ? (
          <ProjectRail
            projects={projects}
            onCreateProject={onCreateProject}
            onProjectDeleted={onProjectDeleted}
          />
        ) : (
          <SessionsRail project={activeProject} events={events} />
        )}
      </div>
    </div>
  );
}
