// ProjectTiles — Section 32.2 compact rail view. Wax-stamp tiles for each
// project, click to activate, right-click for the same context menu as the
// full-width rail. Drag-reorder preserved.
//
// Sits at 56px wide and renders icon-only. The full-width project list still
// exists (ProjectRail) for the sessions / files expanded-rail modes; this
// component is the default rail content.

import { useEffect, useMemo, useState } from 'react';

import { api, type Project } from '@/api/client';
import { useActiveCenterTab } from '@/store/active-center-tab';
import { useActiveProject } from '@/store/active-project';
import {
  DeleteProjectFilesModal,
  SoftDeleteProjectModal,
} from './ProjectDangerModals';

interface ProjectTilesProps {
  projects: Project[];
  onCreateProject: () => void;
  onProjectDeleted: (projectId: string) => void;
  onProjectReorder: (orderedIds: string[]) => void;
  onOpenSessions: () => void;
}

interface MenuPos {
  project: Project;
  x: number;
  y: number;
}

type DangerModal =
  | { kind: 'soft-delete'; project: Project }
  | { kind: 'delete-files'; project: Project };

function initials(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9]/g, '');
  return cleaned.slice(0, 2).toUpperCase() || '··';
}

export function ProjectTiles({
  projects,
  onCreateProject,
  onProjectDeleted,
  onProjectReorder,
  onOpenSessions,
}: ProjectTilesProps) {
  const activeSlug = useActiveProject((s) => s.activeSlug);
  const setActiveSlug = useActiveProject((s) => s.setActiveSlug);
  const setTab = useActiveCenterTab((s) => s.setTab);
  const [menu, setMenu] = useState<MenuPos | null>(null);
  const [danger, setDanger] = useState<DangerModal | null>(null);
  const [filesNote, setFilesNote] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverPos, setDragOverPos] = useState<'before' | 'after'>('before');

  const dragEnabled = projects.length > 1;

  const sortedProjects = useMemo(() => projects, [projects]);

  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('click', dismiss);
    window.addEventListener('contextmenu', dismiss);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', dismiss);
      window.removeEventListener('contextmenu', dismiss);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  useEffect(() => {
    if (!filesNote) return;
    const t = setTimeout(() => setFilesNote(null), 4_000);
    return () => clearTimeout(t);
  }, [filesNote]);

  function openProjectSettings(project: Project) {
    setMenu(null);
    setActiveSlug(project.slug);
    setTab('project-settings');
  }

  async function revealInExplorer(project: Project) {
    setMenu(null);
    try {
      await api.revealProject(project.id);
    } catch (err) {
      alert(`Couldn't open the folder: ${(err as Error).message}`);
    }
  }

  async function copyFolderPath(project: Project) {
    setMenu(null);
    try {
      await navigator.clipboard.writeText(project.folderPath);
    } catch (err) {
      alert(`Couldn't copy: ${(err as Error).message}`);
    }
  }

  async function startNewSession(project: Project) {
    setMenu(null);
    try {
      await api.startNewSession(project.id);
    } catch (err) {
      alert(`Couldn't start a new session: ${(err as Error).message}`);
    }
  }

  function handleDragStart(e: React.DragEvent, project: Project) {
    if (!dragEnabled) return;
    setDraggingId(project.id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', project.id);
  }

  function handleDragOver(e: React.DragEvent, project: Project) {
    if (!draggingId || draggingId === project.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const pos: 'before' | 'after' = e.clientY < midY ? 'before' : 'after';
    if (project.id !== dragOverId) setDragOverId(project.id);
    if (pos !== dragOverPos) setDragOverPos(pos);
  }

  function handleDrop(e: React.DragEvent, target: Project) {
    e.preventDefault();
    const srcId = draggingId;
    setDraggingId(null);
    setDragOverId(null);
    if (!srcId || srcId === target.id) return;
    const srcIdx = projects.findIndex((p) => p.id === srcId);
    const tgtIdx = projects.findIndex((p) => p.id === target.id);
    if (srcIdx < 0 || tgtIdx < 0) return;
    const insertAt = dragOverPos === 'after' ? tgtIdx + 1 : tgtIdx;
    const next = projects.slice();
    const [moved] = next.splice(srcIdx, 1);
    if (!moved) return;
    const adjusted = srcIdx < insertAt ? insertAt - 1 : insertAt;
    next.splice(adjusted, 0, moved);
    onProjectReorder(next.map((p) => p.id));
  }

  function handleDragEnd() {
    setDraggingId(null);
    setDragOverId(null);
  }

  return (
    <div className="flex h-full flex-col border-r border-border bg-card text-foreground">
      <div className="px-1 pt-3 pb-1 text-center text-[8px] uppercase tracking-[0.12em] text-[var(--fg-dim)]">
        proj
      </div>
      <div className="flex flex-1 flex-col items-center gap-1.5 overflow-y-auto px-1 py-2">
        {sortedProjects.length === 0 ? (
          <div className="px-2 py-2 text-center text-[10px] text-muted-foreground">
            None yet
          </div>
        ) : (
          sortedProjects.map((p) => {
            const isActive = p.slug === activeSlug;
            const isDragging = draggingId === p.id;
            const isOver = dragOverId === p.id;
            const showLineBefore = isOver && dragOverPos === 'before';
            const showLineAfter = isOver && dragOverPos === 'after';
            return (
              <div key={p.id} className="relative w-full">
                {showLineBefore && (
                  <div className="pointer-events-none absolute left-1 right-1 top-0 z-10 h-0.5 bg-primary" />
                )}
                <button
                  draggable={dragEnabled}
                  onDragStart={(e) => handleDragStart(e, p)}
                  onDragOver={(e) => handleDragOver(e, p)}
                  onDrop={(e) => handleDrop(e, p)}
                  onDragEnd={handleDragEnd}
                  onClick={() => setActiveSlug(p.slug)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenu({ project: p, x: e.clientX, y: e.clientY });
                  }}
                  title={p.name}
                  className={
                    'pc-project-tile mx-auto block ' +
                    (isActive ? 'pc-project-tile-active' : 'pc-project-tile-inactive') +
                    (isDragging ? ' opacity-40' : '') +
                    (dragEnabled ? ' cursor-grab active:cursor-grabbing' : '')
                  }
                >
                  {initials(p.name)}
                </button>
                {showLineAfter && (
                  <div className="pointer-events-none absolute bottom-0 left-1 right-1 z-10 h-0.5 bg-primary" />
                )}
              </div>
            );
          })
        )}
        <button
          onClick={onCreateProject}
          title="New project"
          aria-label="New project"
          className="pc-project-tile pc-project-tile-new mx-auto mt-2"
        >
          +
        </button>
      </div>
      <button
        onClick={onOpenSessions}
        title="Browse sessions for the active project"
        className="border-t border-border px-1 py-2 text-center text-[9px] uppercase tracking-[0.08em] text-[var(--fg-dim)] hover:text-accent"
      >
        sessions
      </button>
      {filesNote && (
        <div className="border-t border-border bg-success/10 px-2 py-1 text-[10px] text-success">
          {filesNote}
        </div>
      )}
      {menu && (
        <div
          role="menu"
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          style={{ position: 'fixed', top: menu.y, left: menu.x, zIndex: 50 }}
          className="min-w-[12rem] border border-primary/40 bg-popover py-1 text-popover-foreground shadow-2xl"
        >
          <MenuItem onClick={() => openProjectSettings(menu.project)}>
            Open project settings
          </MenuItem>
          <MenuItem onClick={() => revealInExplorer(menu.project)}>
            Open in file explorer
          </MenuItem>
          <MenuItem onClick={() => copyFolderPath(menu.project)}>
            Copy folder path
          </MenuItem>
          <MenuItem onClick={() => startNewSession(menu.project)}>
            New session
          </MenuItem>
          <div className="my-1 border-t border-border" />
          <MenuItem
            onClick={() => {
              setMenu(null);
              setDanger({ kind: 'soft-delete', project: menu.project });
            }}
            variant="danger"
          >
            Archive…
          </MenuItem>
          <MenuItem
            onClick={() => {
              setMenu(null);
              setFilesNote(null);
              setDanger({ kind: 'delete-files', project: menu.project });
            }}
            variant="danger"
          >
            Delete files…
          </MenuItem>
        </div>
      )}
      {danger?.kind === 'soft-delete' && (
        <SoftDeleteProjectModal
          project={danger.project}
          onCancel={() => setDanger(null)}
          onDeleted={(id) => {
            setDanger(null);
            onProjectDeleted(id);
          }}
        />
      )}
      {danger?.kind === 'delete-files' && (
        <DeleteProjectFilesModal
          project={danger.project}
          onCancel={() => setDanger(null)}
          onDone={(removed) => {
            setDanger(null);
            setFilesNote(
              removed.length === 0
                ? `${danger.project.name}: PC scaffold dirs were already gone.`
                : `${danger.project.name}: removed ${removed.join(', ')}.`,
            );
          }}
        />
      )}
    </div>
  );
}

function MenuItem({
  onClick,
  children,
  variant,
}: {
  onClick: () => void;
  children: React.ReactNode;
  variant?: 'danger';
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={
        'block w-full px-3 py-1.5 text-left text-sm hover:bg-muted ' +
        (variant === 'danger' ? 'text-destructive' : '')
      }
    >
      {children}
    </button>
  );
}
