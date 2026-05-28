// Vendored from emersonmccuin-pixel/project-companion @ 6053ad6 (MIT)
// Source: apps/web/src/components/ProjectRail.tsx
// Adapted for Caisson: no inline create-project form here — the
// "+ New project" button bubbles up via `onCreateProject` so the create flow
// (folder picker + probe + POST /api/projects) lives in a top-level modal
// shared with future affordances (Q5). Active-slug comes from a zustand
// store, not props. Right-click context menu built out per D86 (5.4).
//
// Session 31 reshape: 32.2's compact tile column reverted to the full-name
// project list. Each row now carries a small wax-stamp icon on the left
// (24px square; same active/inactive treatment as the old 32px tile).

import { useEffect, useMemo, useState } from 'react';

import { projectsApi, type Project } from '@/features/projects/client';
import { runtimeApi } from '@/features/runtime/client';
import { useActiveCenterTab } from '@/store/active-center-tab';
import { useActiveProject } from '@/store/active-project';
import { useStatuslineStore } from '@/store/statusline';
import {
  DeleteProjectFilesModal,
  SoftDeleteProjectModal,
} from './ProjectDangerModals';
import { UsageCapsPanel } from './UsageCapsPanel';

interface ProjectRailProps {
  projects: Project[];
  onCreateProject: () => void;
  onProjectDeleted: (projectId: string) => void;
  onProjectReorder: (orderedIds: string[]) => void;
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

export function ProjectRail({
  projects,
  onCreateProject,
  onProjectDeleted,
  onProjectReorder,
}: ProjectRailProps) {
  const activeSlug = useActiveProject((s) => s.activeSlug);
  const setActiveSlug = useActiveProject((s) => s.setActiveSlug);
  const setTab = useActiveCenterTab((s) => s.setTab);
  const activeProject = useMemo(
    () => projects.find((p) => p.slug === activeSlug) ?? null,
    [projects, activeSlug],
  );
  const activeSnapshot = useStatuslineStore((s) =>
    activeProject ? s.byProject[activeProject.id] ?? null : null,
  );
  const [menu, setMenu] = useState<MenuPos | null>(null);
  const [danger, setDanger] = useState<DangerModal | null>(null);
  const [filesNote, setFilesNote] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  // 5+.4 (D87) — drag state. `draggingId` is the source row; `dragOverId` +
  // `dragOverPos` drive the insertion-line indicator. Drag is disabled while
  // the filter input has text — reorder semantics on a partial view get weird
  // fast, and the filter is a transient lookup tool anyway.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverPos, setDragOverPos] = useState<'before' | 'after'>('before');

  // 5+.3 (D89): rail-local, transient, name-only substring filter.
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.name.toLowerCase().includes(q));
  }, [projects, filter]);

  const dragEnabled = filter.trim() === '' && projects.length > 1;

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
      await projectsApi.revealProject(project.id);
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
      await runtimeApi.startNewSession(project.id);
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
      <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground">
        <span>Projects</span>
        <button
          onClick={onCreateProject}
          title="New project"
          aria-label="New project"
          className="flex h-5 w-5 items-center justify-center text-base leading-none text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          +
        </button>
      </div>
      {projects.length > 0 && (
        <div className="border-b border-border px-2 py-1.5">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter projects…"
            className="w-full px-2 py-1 text-xs"
          />
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        {projects.length === 0 ? (
          <div className="px-3 py-3 text-xs text-muted-foreground">No projects yet.</div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-3 text-xs text-muted-foreground">No matches.</div>
        ) : (
          filtered.map((p) => {
            const isActive = p.slug === activeSlug;
            const isDragging = draggingId === p.id;
            const isOver = dragOverId === p.id;
            const showLineBefore = isOver && dragOverPos === 'before';
            const showLineAfter = isOver && dragOverPos === 'after';
            return (
              <div key={p.id} className="relative">
                {showLineBefore && (
                  <div className="pointer-events-none absolute left-0 right-0 top-0 z-10 h-0.5 bg-primary" />
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
                    // stopPropagation so the SAME contextmenu doesn't bubble to
                    // the window-level dismiss listener attached by the useEffect
                    // above — React 18 commits + runs the effect fast enough that
                    // the listener was live before bubbling finished, opening and
                    // immediately closing the menu (5+.1 regression hunt).
                    e.stopPropagation();
                    setMenu({ project: p, x: e.clientX, y: e.clientY });
                  }}
                  title={p.folderPath}
                  className={
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted ' +
                    (isActive
                      ? 'border-l-2 border-primary -ml-px pl-[calc(0.75rem-1px)] bg-muted text-primary '
                      : 'border-l-2 border-transparent text-foreground/80 ') +
                    (isDragging ? 'opacity-40 ' : '') +
                    (dragEnabled ? 'cursor-grab active:cursor-grabbing' : '')
                  }
                >
                  <span
                    aria-hidden="true"
                    className={
                      'pc-project-tile pc-project-tile-row shrink-0 ' +
                      (isActive ? 'pc-project-tile-active' : 'pc-project-tile-inactive')
                    }
                  >
                    {initials(p.name)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                </button>
                {showLineAfter && (
                  <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-10 h-0.5 bg-primary" />
                )}
              </div>
            );
          })
        )}
      </div>
      <UsageCapsPanel snapshot={activeSnapshot} />
      {filesNote && (
        <div className="border-t border-border bg-success/10 px-3 py-1.5 text-xs text-success">
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
        'block w-full px-3 py-1.5 text-left text-xs hover:bg-muted ' +
        (variant === 'danger' ? 'text-destructive' : '')
      }
    >
      {children}
    </button>
  );
}
