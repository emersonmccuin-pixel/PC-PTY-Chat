// LeftRail — Projects / Sessions tab wrapper for the rail panel. Sessions
// view is scoped to the active project. 5+P.C: Files left the rail tab strip;
// when the center tab is Files, rail content overrides to <FilesRail>
// regardless of `mode`. Clicking a rail tab while in Files mode flips center
// back to Orchestrator (rail-becomes-file-tree is a coupled state — leaving
// it via the rail strip means the user is done browsing files).

import type { Project } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';
import { useActiveCenterTab } from '@/store/active-center-tab';
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
  const centerTab = useActiveCenterTab((s) => s.tab);
  const setCenterTab = useActiveCenterTab((s) => s.setTab);

  const filesOverride = centerTab === 'files';

  return (
    <div className="flex h-full flex-col">
      <div className="flex border-b border-border bg-card text-sm">
        {TABS.map((t) => (
          <button
            key={t.mode}
            onClick={() => {
              setMode(t.mode);
              if (filesOverride) setCenterTab('orchestrator');
            }}
            className={
              'flex-1 px-3 py-2 ' +
              (!filesOverride && mode === t.mode
                ? 'border-b-2 border-primary text-primary -mb-px'
                : 'text-muted-foreground hover:text-foreground')
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-hidden">
        {filesOverride ? (
          <FilesRail project={activeProject} />
        ) : mode === 'projects' ? (
          <ProjectRail
            projects={projects}
            onCreateProject={onCreateProject}
            onProjectDeleted={onProjectDeleted}
            onProjectReorder={onProjectReorder}
          />
        ) : (
          <SessionsRail project={activeProject} events={events} />
        )}
      </div>
    </div>
  );
}
