// LeftRail — Projects / Sessions / Files tab wrapper for the rail panel.
// Sessions + Files views are scoped to the active project; switching projects
// changes what each tab lists.

import type { Project } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';
import { useRailMode, type RailMode } from '@/store/rail-mode';
import { FilesRail } from './FilesRail';
import { ProjectRail } from './ProjectRail';
import { SessionsRail } from './SessionsRail';

interface LeftRailProps {
  projects: Project[];
  activeProject: Project | null;
  events: WsEnvelope[];
  onCreateProject: () => void;
  onProjectDeleted: (projectId: string) => void;
  onProjectReorder: (orderedIds: string[]) => void;
}

const TABS: { mode: RailMode; label: string }[] = [
  { mode: 'projects', label: 'Projects' },
  { mode: 'sessions', label: 'Sessions' },
  { mode: 'files', label: 'Files' },
];

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

  return (
    <div className="flex h-full flex-col">
      <div className="flex border-b border-border bg-card text-xs">
        {TABS.map((t) => (
          <button
            key={t.mode}
            onClick={() => setMode(t.mode)}
            className={
              'flex-1 px-3 py-2 ' +
              (mode === t.mode
                ? 'border-b-2 border-primary text-primary -mb-px'
                : 'text-muted-foreground hover:text-foreground')
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-hidden">
        {mode === 'projects' ? (
          <ProjectRail
            projects={projects}
            onCreateProject={onCreateProject}
            onProjectDeleted={onProjectDeleted}
            onProjectReorder={onProjectReorder}
          />
        ) : mode === 'sessions' ? (
          <SessionsRail project={activeProject} events={events} />
        ) : (
          <FilesRail project={activeProject} />
        )}
      </div>
    </div>
  );
}
