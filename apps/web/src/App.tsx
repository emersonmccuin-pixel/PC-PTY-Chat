import { useEffect, useMemo, useState } from 'react';

import { api, type GlobalSettings, type Project } from '@/api/client';
import { AppSettingsModal } from '@/components/AppSettingsModal';
import { CreateProjectModal } from '@/components/CreateProjectModal';
import { Shell } from '@/components/Shell';
import { useProjectWs } from '@/hooks/use-project-ws';
import { useActiveProject } from '@/store/active-project';

export default function App() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [activityPanelOpen, setActivityPanelOpen] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const activeSlug = useActiveProject((s) => s.activeSlug);
  const setActiveSlug = useActiveProject((s) => s.setActiveSlug);

  useEffect(() => {
    void api.listProjects().then(setProjects).catch(() => setProjects([]));
    void api.getSettings().then(setSettings).catch(() => {
      /* best-effort — surfaces as gear icon disabled until next load */
    });
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
            onClick={() => setSettingsOpen(true)}
            disabled={!settings}
            title="App settings"
            aria-label="App settings"
            className="px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            ⚙
          </button>
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
      {restartRequired && (
        <div className="flex items-center justify-between gap-3 border-b border-warning/60 bg-warning/10 px-3 py-1.5 text-xs text-warning">
          <span>
            Data-dir change saved — restart the server for it to take effect.
          </span>
          <button
            onClick={() => setRestartRequired(false)}
            className="text-warning hover:text-foreground"
          >
            dismiss
          </button>
        </div>
      )}
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
          {...(settings?.projectsFolder ? { defaultFolder: settings.projectsFolder } : {})}
          onClose={() => setCreateOpen(false)}
          onCreated={(p) => {
            setProjects((prev) => (prev ? [p, ...prev] : [p]));
            setActiveSlug(p.slug);
            setCreateOpen(false);
          }}
        />
      )}
      {settingsOpen && settings && (
        <AppSettingsModal
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={(next, needsRestart) => {
            setSettings(next);
            if (needsRestart) setRestartRequired(true);
            setSettingsOpen(false);
          }}
        />
      )}
    </div>
  );
}
