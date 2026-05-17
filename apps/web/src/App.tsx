import { useEffect, useMemo, useState } from 'react';

import { api, type Project } from '@/api/client';
import { CreateProjectModal } from '@/components/CreateProjectModal';
import { Shell } from '@/components/Shell';
import { useProjectWs } from '@/hooks/use-project-ws';
import { useActiveProject } from '@/store/active-project';

export default function App() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [activityPanelOpen, setActivityPanelOpen] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const activeSlug = useActiveProject((s) => s.activeSlug);
  const setActiveSlug = useActiveProject((s) => s.setActiveSlug);

  useEffect(() => {
    void api.listProjects().then(setProjects).catch(() => setProjects([]));
  }, []);

  // Reconcile activeSlug with the loaded list — pick the first project if the
  // persisted selection no longer exists (e.g. fresh DB or after soft-delete).
  useEffect(() => {
    if (!projects || projects.length === 0) return;
    if (activeSlug && projects.some((p) => p.slug === activeSlug)) return;
    setActiveSlug(projects[0]!.slug);
  }, [projects, activeSlug, setActiveSlug]);

  const activeProject = useMemo(
    () => projects?.find((p) => p.slug === activeSlug) ?? null,
    [projects, activeSlug],
  );

  const ws = useProjectWs(activeProject);

  if (projects === null) {
    return (
      <div className="grid h-full place-items-center bg-background text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border bg-card px-3 py-2">
        <div className="text-sm font-semibold tracking-wide text-foreground">
          PROJECT COMPANION
        </div>
        <div className="flex items-center gap-2">
          <span
            className="text-[10px] uppercase tracking-wider text-muted-foreground"
            title={`WS: ${ws.status}`}
          >
            ws: {ws.status}
          </span>
          <button
            onClick={() => setActivityPanelOpen((v) => !v)}
            title={activityPanelOpen ? 'Hide activity panel' : 'Show activity panel'}
            aria-label="Toggle activity panel"
            className={`px-2 py-1 hover:bg-muted hover:text-foreground ${
              activityPanelOpen ? 'text-muted-foreground' : 'text-foreground'
            }`}
          >
            {activityPanelOpen ? '▸' : '◂'}
          </button>
        </div>
      </header>
      <div className="flex-1 overflow-hidden">
        <Shell
          projects={projects}
          activityPanelOpen={activityPanelOpen}
          onToggleActivityPanelOpen={setActivityPanelOpen}
          onCreateProject={() => setCreateOpen(true)}
          wsEvents={ws.events}
          wsStatus={ws.status}
          wsSend={ws.send}
        />
      </div>
      {createOpen && (
        <CreateProjectModal
          onClose={() => setCreateOpen(false)}
          onCreated={(p) => {
            setProjects((prev) => (prev ? [p, ...prev] : [p]));
            setActiveSlug(p.slug);
            setCreateOpen(false);
          }}
        />
      )}
    </div>
  );
}
