import { useEffect, useMemo, useState } from 'react';

import { api, type Project } from '@/api/client';
import { Shell } from '@/components/Shell';

export default function App() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [activityPanelOpen, setActivityPanelOpen] = useState(true);

  useEffect(() => {
    void api.listProjects().then(setProjects).catch(() => setProjects([]));
  }, []);

  // Reconcile activeSlug with the loaded list — pick the first project if the
  // current selection no longer exists (e.g. fresh DB or after soft-delete).
  useEffect(() => {
    if (!projects || projects.length === 0) return;
    if (activeSlug && projects.some((p) => p.slug === activeSlug)) return;
    setActiveSlug(projects[0]!.slug);
  }, [projects, activeSlug]);

  const activeProject = useMemo(
    () => projects?.find((p) => p.slug === activeSlug) ?? null,
    [projects, activeSlug],
  );

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
        <div className="flex items-center gap-1">
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
          activeSlug={activeSlug}
          activeProject={activeProject}
          activityPanelOpen={activityPanelOpen}
          onSelectProject={setActiveSlug}
          onToggleActivityPanelOpen={setActivityPanelOpen}
        />
      </div>
    </div>
  );
}
