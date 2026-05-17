// Vendored from emersonmccuin-pixel/project-companion @ 6053ad6 (MIT)
// Source: apps/web/src/components/ProjectRail.tsx
// Adapted for Project Companion: no inline create-project form here — the
// "+ New project" button bubbles up via `onCreateProject` so the create flow
// (folder picker + probe + POST /api/projects) lives in a top-level modal
// shared with future affordances (Q5). Active-slug comes from a zustand
// store, not props.

import type { Project } from '@/api/client';
import { useActiveProject } from '@/store/active-project';

interface ProjectRailProps {
  projects: Project[];
  onCreateProject: () => void;
}

export function ProjectRail({ projects, onCreateProject }: ProjectRailProps) {
  const activeSlug = useActiveProject((s) => s.activeSlug);
  const setActiveSlug = useActiveProject((s) => s.setActiveSlug);

  return (
    <div className="flex h-full flex-col border-r border-border bg-card text-foreground">
      <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Projects
      </div>
      <div className="flex-1 overflow-y-auto">
        {projects.length === 0 ? (
          <div className="px-3 py-3 text-xs text-muted-foreground">No projects yet.</div>
        ) : (
          projects.map((p) => {
            const isActive = p.slug === activeSlug;
            return (
              <button
                key={p.id}
                onClick={() => setActiveSlug(p.slug)}
                title={p.folderPath}
                className={
                  'block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-muted ' +
                  (isActive
                    ? 'border-l-2 border-primary -ml-px pl-[calc(0.75rem-1px)] bg-muted text-primary'
                    : 'border-l-2 border-transparent text-foreground/80')
                }
              >
                {p.name}
              </button>
            );
          })
        )}
      </div>
      <div className="border-t border-border p-2">
        <button
          onClick={onCreateProject}
          className="w-full px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          + New project
        </button>
      </div>
    </div>
  );
}
