// Q3 stub. Q4 vendors the full rail (create-project button, project list with
// click-to-select, slug + git-state badges). Q5 wires the FolderPicker modal.

import type { Project } from '@/api/client';

interface ProjectRailProps {
  projects: Project[];
  activeSlug: string | null;
  onSelectProject: (slug: string) => void;
}

export function ProjectRail({ projects, activeSlug, onSelectProject }: ProjectRailProps) {
  return (
    <div className="flex h-full flex-col border-r border-border bg-card">
      <div className="border-b border-border px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground">
        Projects
      </div>
      <div className="flex-1 overflow-y-auto">
        {projects.length === 0 ? (
          <div className="px-3 py-4 text-xs text-muted-foreground">no projects</div>
        ) : (
          <ul className="py-1">
            {projects.map((p) => (
              <li key={p.id}>
                <button
                  onClick={() => onSelectProject(p.slug)}
                  className={`block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-muted ${
                    p.slug === activeSlug
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground'
                  }`}
                  title={p.name}
                >
                  {p.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
