// Vendored from emersonmccuin-pixel/project-companion @ 6053ad6 (MIT)
// Source: apps/web/src/components/ProjectRail.tsx
// Adapted for Project Companion: no inline create-project form here — the
// "+ New project" button bubbles up via `onCreateProject` so the create flow
// (folder picker + probe + POST /api/projects) lives in a top-level modal
// shared with future affordances (Q5). Active-slug comes from a zustand
// store, not props.

import { useEffect, useState } from 'react';

import { api, type Project } from '@/api/client';
import { useActiveProject } from '@/store/active-project';

interface ProjectRailProps {
  projects: Project[];
  onCreateProject: () => void;
}

interface MenuPos {
  projectId: string;
  x: number;
  y: number;
}

export function ProjectRail({ projects, onCreateProject }: ProjectRailProps) {
  const activeSlug = useActiveProject((s) => s.activeSlug);
  const setActiveSlug = useActiveProject((s) => s.setActiveSlug);
  const [menu, setMenu] = useState<MenuPos | null>(null);

  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    window.addEventListener('click', dismiss);
    window.addEventListener('contextmenu', dismiss);
    window.addEventListener('keydown', dismiss);
    return () => {
      window.removeEventListener('click', dismiss);
      window.removeEventListener('contextmenu', dismiss);
      window.removeEventListener('keydown', dismiss);
    };
  }, [menu]);

  async function startNewSession(projectId: string) {
    setMenu(null);
    try {
      await api.startNewSession(projectId);
    } catch (err) {
      console.error('[pc] startNewSession failed', err);
      alert(`Couldn't start a new session: ${(err as Error).message}`);
    }
  }

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
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ projectId: p.id, x: e.clientX, y: e.clientY });
                }}
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
      {menu && (
        <div
          role="menu"
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          style={{ position: 'fixed', top: menu.y, left: menu.x, zIndex: 50 }}
          className="min-w-[10rem] rounded-md border border-border bg-popover py-1 shadow-md"
        >
          <button
            role="menuitem"
            onClick={() => startNewSession(menu.projectId)}
            className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
          >
            New session
          </button>
        </div>
      )}
    </div>
  );
}
