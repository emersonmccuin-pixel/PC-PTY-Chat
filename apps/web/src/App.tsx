import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, type GlobalSettings, type Project } from '@/api/client';
import { AppSettingsModal } from '@/components/AppSettingsModal';
import { CreateProjectModal } from '@/components/CreateProjectModal';
import { Shell } from '@/components/Shell';
import { useAllProjectsWs } from '@/hooks/use-all-projects-ws';
import { useProjectWs, type WsEnvelope, type WsStatus } from '@/hooks/use-project-ws';
import { useActiveProject } from '@/store/active-project';

// Merge two FIFO event streams by inner `ts` if present. Falls back to a
// simple alternating interleave when ts is absent. Each stream is already
// in arrival order on its own connection.
function mergeByOrder(a: WsEnvelope[], b: WsEnvelope[]): WsEnvelope[] {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out: WsEnvelope[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ta = tsOf(a[i]!);
    const tb = tsOf(b[j]!);
    if (ta !== null && tb !== null) {
      if (ta <= tb) out.push(a[i++]!);
      else out.push(b[j++]!);
    } else {
      out.push(a[i++]!);
      out.push(b[j++]!);
    }
  }
  while (i < a.length) out.push(a[i++]!);
  while (j < b.length) out.push(b[j++]!);
  return out;
}

function tsOf(env: WsEnvelope): string | null {
  const inner = (env.event as Record<string, unknown> | undefined) ?? null;
  if (inner && typeof inner.ts === 'string') return inner.ts;
  return null;
}

const STATUS_RANK: Record<WsStatus, number> = {
  open: 0,
  connecting: 1,
  closed: 2,
  idle: 3,
};

function worstStatus(a: WsStatus, b: WsStatus): WsStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

export default function App() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const activeSlug = useActiveProject((s) => s.activeSlug);
  const setActiveSlug = useActiveProject((s) => s.setActiveSlug);

  // Activity panel state lives in settings_global.activity_panel (Q12).
  // Default to `{ open: true, showAllProjects: false }` until settings load.
  const activityPanelOpen = settings?.activityPanel.open ?? true;
  const showAllProjects = settings?.activityPanel.showAllProjects ?? false;

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
  const allWs = useAllProjectsWs(
    projects ?? [],
    activeProject?.id ?? null,
    showAllProjects,
  );

  // ActivityPanel input: merge active-project events with the rest in
  // all-projects mode; otherwise just the active project's stream.
  const activityEvents = useMemo(
    () => (showAllProjects ? mergeByOrder(ws.events, allWs.events) : ws.events),
    [showAllProjects, ws.events, allWs.events],
  );
  const activityStatus =
    showAllProjects && allWs.status !== 'idle'
      ? worstStatus(ws.status, allWs.status)
      : ws.status;

  const persistActivityPanelSetting = useCallback(
    (patch: { open?: boolean; showAllProjects?: boolean }) => {
      // Optimistic update so the UI doesn't lag behind the PATCH.
      setSettings((prev) =>
        prev
          ? {
              ...prev,
              activityPanel: {
                open: patch.open ?? prev.activityPanel.open,
                showAllProjects: patch.showAllProjects ?? prev.activityPanel.showAllProjects,
              },
            }
          : prev,
      );
      void api
        .patchSettings({
          activityPanel: {
            open: patch.open ?? settings?.activityPanel.open ?? true,
            showAllProjects:
              patch.showAllProjects ?? settings?.activityPanel.showAllProjects ?? false,
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
          activityEvents={activityEvents}
          activityStatus={activityStatus}
          showAllProjects={showAllProjects}
          onToggleShowAllProjects={(next) =>
            persistActivityPanelSetting({ showAllProjects: next })
          }
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
