// Vendored from emersonmccuin-pixel/project-companion @ 6053ad6 (MIT)
// Source: apps/web/src/components/ProjectRail.tsx
// Adapted for Project Companion: no inline create-project form here — the
// "+ New project" button bubbles up via `onCreateProject` so the create flow
// (folder picker + probe + POST /api/projects) lives in a top-level modal
// shared with future affordances (Q5). Active-slug comes from a zustand
// store, not props. Right-click context menu built out per D86 (5.4).

import { useEffect, useState } from 'react';

import { api, type Project } from '@/api/client';
import { useActiveProject } from '@/store/active-project';
import { usePerProjectTab } from '@/store/per-project-tab';
import {
  DeleteProjectFilesModal,
  SoftDeleteProjectModal,
} from './ProjectDangerModals';

interface ProjectRailProps {
  projects: Project[];
  onCreateProject: () => void;
  onProjectDeleted: (projectId: string) => void;
}

interface MenuPos {
  project: Project;
  x: number;
  y: number;
}

type DangerModal =
  | { kind: 'soft-delete'; project: Project }
  | { kind: 'delete-files'; project: Project };

export function ProjectRail({
  projects,
  onCreateProject,
  onProjectDeleted,
}: ProjectRailProps) {
  const activeSlug = useActiveProject((s) => s.activeSlug);
  const setActiveSlug = useActiveProject((s) => s.setActiveSlug);
  const setTab = usePerProjectTab((s) => s.setTab);
  const [menu, setMenu] = useState<MenuPos | null>(null);
  const [danger, setDanger] = useState<DangerModal | null>(null);
  const [filesNote, setFilesNote] = useState<string | null>(null);

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

  // Auto-clear the "Removed: …" toast after a short window.
  useEffect(() => {
    if (!filesNote) return;
    const t = setTimeout(() => setFilesNote(null), 4_000);
    return () => clearTimeout(t);
  }, [filesNote]);

  function openProjectSettings(project: Project) {
    setMenu(null);
    setActiveSlug(project.slug);
    setTab(project.slug, 'project-settings');
  }

  async function revealInExplorer(project: Project) {
    setMenu(null);
    try {
      await api.revealProject(project.id);
    } catch (err) {
      console.error('[pc] revealProject failed', err);
      alert(`Couldn't open the folder: ${(err as Error).message}`);
    }
  }

  async function copyFolderPath(project: Project) {
    setMenu(null);
    try {
      await navigator.clipboard.writeText(project.folderPath);
    } catch (err) {
      console.error('[pc] clipboard write failed', err);
      alert(`Couldn't copy: ${(err as Error).message}`);
    }
  }

  async function startNewSession(project: Project) {
    setMenu(null);
    try {
      await api.startNewSession(project.id);
    } catch (err) {
      console.error('[pc] startNewSession failed', err);
      alert(`Couldn't start a new session: ${(err as Error).message}`);
    }
  }

  function openSoftDelete(project: Project) {
    setMenu(null);
    setDanger({ kind: 'soft-delete', project });
  }

  function openDeleteFiles(project: Project) {
    setMenu(null);
    setFilesNote(null);
    setDanger({ kind: 'delete-files', project });
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
                  setMenu({ project: p, x: e.clientX, y: e.clientY });
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
          className="min-w-[12rem] rounded-md border border-border bg-popover py-1 shadow-md"
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
          <MenuItem onClick={() => openSoftDelete(menu.project)} variant="danger">
            Archive…
          </MenuItem>
          <MenuItem onClick={() => openDeleteFiles(menu.project)} variant="danger">
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
