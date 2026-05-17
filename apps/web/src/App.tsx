import { useEffect, useState } from 'react';

import { api, type Project } from '@/api/client';
import { Shell } from '@/components/Shell';
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
          activityPanelOpen={activityPanelOpen}
          onToggleActivityPanelOpen={setActivityPanelOpen}
          onCreateProject={() => setCreateOpen(true)}
        />
      </div>
      {createOpen && (
        <CreateProjectPlaceholder onClose={() => setCreateOpen(false)} />
      )}
    </div>
  );
}

// Q5 swaps this for the real FolderPicker + FolderBrowserModal + create flow.
function CreateProjectPlaceholder({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 grid place-items-center bg-background/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="border border-border bg-card p-6 text-sm text-foreground"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 font-semibold">Create project</div>
        <div className="mb-4 text-muted-foreground">
          Folder picker + folder probe + POST /api/projects land in Q5.
        </div>
        <button
          onClick={onClose}
          className="bg-primary px-3 py-1 text-primary-foreground hover:bg-primary/90"
        >
          Close
        </button>
      </div>
    </div>
  );
}
