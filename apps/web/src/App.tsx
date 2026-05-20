import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, type GlobalSettings, type Project } from '@/api/client';
import { AppSettingsModal } from '@/components/AppSettingsModal';
import { CreateProjectModal } from '@/components/CreateProjectModal';
import { Shell } from '@/components/Shell';
import { useProjectWs } from '@/hooks/use-project-ws';
import { useActiveProject } from '@/store/active-project';

export default function App() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const activeSlug = useActiveProject((s) => s.activeSlug);
  const setActiveSlug = useActiveProject((s) => s.setActiveSlug);

  // Activity panel open/closed lives in settings_global.activity_panel.
  // `showAllProjects` field still in settings schema (additive — Section 7
  // will re-consume it via the global cross-project bell); the activity
  // panel itself is per-project scoped since Section 6.
  const activityPanelOpen = settings?.activityPanel.open ?? true;

  useEffect(() => {
    void api.listProjects().then(setProjects).catch(() => setProjects([]));
    void api.getSettings().then(setSettings).catch(() => {
      /* best-effort — surfaces as gear icon disabled until next load */
    });
  }, []);

  // Apply the persisted fontScale to documentElement so every rem-based UI
  // size scales. The slider in AppSettingsModal updates the same variable
  // live during preview; on Save this useEffect re-syncs from the canonical
  // settings envelope.
  useEffect(() => {
    if (!settings) return;
    document.documentElement.style.setProperty('--font-scale', String(settings.fontScale));
  }, [settings?.fontScale]);

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

  const persistActivityPanelSetting = useCallback(
    (patch: { open?: boolean }) => {
      // Optimistic update so the UI doesn't lag behind the PATCH.
      setSettings((prev) =>
        prev
          ? {
              ...prev,
              activityPanel: {
                open: patch.open ?? prev.activityPanel.open,
                showAllProjects: prev.activityPanel.showAllProjects,
              },
            }
          : prev,
      );
      void api
        .patchSettings({
          activityPanel: {
            open: patch.open ?? settings?.activityPanel.open ?? true,
            showAllProjects: settings?.activityPanel.showAllProjects ?? false,
          },
        })
        .catch(() => {
          /* best-effort — next save reconciles */
        });
    },
    [settings],
  );

  const handleProjectUpdated = useCallback((next: Project) => {
    setProjects((prev) => (prev ? prev.map((p) => (p.id === next.id ? next : p)) : prev));
  }, []);

  const handleProjectDeleted = useCallback(
    (projectId: string) => {
      setProjects((prev) => {
        if (!prev) return prev;
        const filtered = prev.filter((p) => p.id !== projectId);
        const wasActive = prev.find((p) => p.id === projectId)?.slug === activeSlug;
        if (wasActive) {
          setActiveSlug(filtered[0]?.slug ?? null);
        }
        return filtered;
      });
    },
    [activeSlug, setActiveSlug],
  );

  // 5+.4 (D87) — drag-reorder. Optimistic local reorder, then PATCH; refetch
  // on failure to recover the canonical order.
  const handleProjectReorder = useCallback((orderedIds: string[]) => {
    setProjects((prev) => {
      if (!prev) return prev;
      const byId = new Map(prev.map((p) => [p.id, p] as const));
      const reordered: Project[] = [];
      for (const id of orderedIds) {
        const p = byId.get(id);
        if (p) reordered.push(p);
      }
      // Append any projects the caller didn't include (defensive — keeps the
      // rail from accidentally dropping rows on a partial-list reorder).
      for (const p of prev) if (!orderedIds.includes(p.id)) reordered.push(p);
      return reordered;
    });
    void api.reorderProjects(orderedIds).then(setProjects).catch(() => {
      void api.listProjects().then(setProjects).catch(() => {});
    });
  }, []);

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
          {activeProject?.name ?? 'PROJECT COMPANION'}
        </div>
        <div className="flex items-center gap-2">
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
            onClick={() => persistActivityPanelSetting({ open: !activityPanelOpen })}
            disabled={!settings}
            title={activityPanelOpen ? 'Hide activity panel' : 'Show activity panel'}
            aria-label="Toggle activity panel"
            className={`px-2 py-1 hover:bg-muted hover:text-foreground disabled:opacity-40 ${
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
          onToggleActivityPanelOpen={(next) => persistActivityPanelSetting({ open: next })}
          onCreateProject={() => setCreateOpen(true)}
          onProjectUpdated={handleProjectUpdated}
          onProjectDeleted={handleProjectDeleted}
          onProjectReorder={handleProjectReorder}
          wsEvents={ws.events}
          wsSend={ws.send}
          wsClear={ws.clear}
          wsStatus={ws.status}
        />
      </div>
      {createOpen && (
        <CreateProjectModal
          {...(settings?.projectsFolder ? { projectsFolder: settings.projectsFolder } : {})}
          onClose={() => setCreateOpen(false)}
          onOpenAppSettings={() => {
            setCreateOpen(false);
            setSettingsOpen(true);
          }}
          onCreated={(p) => {
            // 5+.4 (D87) — new projects land at the bottom of the rail,
            // matching the server-side `max(position) + 1` placement so the
            // optimistic update doesn't fight the next refetch.
            setProjects((prev) => (prev ? [...prev, p] : [p]));
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
