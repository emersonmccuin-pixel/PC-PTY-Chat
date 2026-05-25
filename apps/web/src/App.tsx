import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, type GlobalSettings, type Project } from '@/api/client';
import { AppSettingsModal } from '@/components/AppSettingsModal';
import { CreateProjectModal } from '@/components/CreateProjectModal';
import { SessionSwitcher } from '@/components/SessionSwitcher';
import { Shell } from '@/components/Shell';
import { tabLabel } from '@/components/Tabs';
import { useProjectWs } from '@/hooks/use-project-ws';
import { useRichLinkInvalidator } from '@/hooks/use-rich-link-invalidator';
import { useActiveCenterTab } from '@/store/active-center-tab';
import { useActiveProject } from '@/store/active-project';
import { useOrchestratorTelemetry } from '@/store/orchestrator-telemetry';

export default function App() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const activeSlug = useActiveProject((s) => s.activeSlug);
  const setActiveSlug = useActiveProject((s) => s.setActiveSlug);
  const activeTab = useActiveCenterTab((s) => s.tab);
  const telemetryModel = useOrchestratorTelemetry((s) => s.model);
  const telemetryUsage = useOrchestratorTelemetry((s) => s.usage);
  const sessionId = useOrchestratorTelemetry((s) => s.sessionId);
  const sessionLabel = useOrchestratorTelemetry((s) => s.sessionLabel);
  const [sessionSwitcherOpen, setSessionSwitcherOpen] = useState(false);
  const sessionBreadcrumbRef = useRef<HTMLButtonElement | null>(null);
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const brandMenuRef = useRef<HTMLDivElement | null>(null);
  const brandButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!brandMenuOpen) return;
    function onClick(e: MouseEvent) {
      const t = e.target as Node;
      if (brandMenuRef.current?.contains(t)) return;
      if (brandButtonRef.current?.contains(t)) return;
      setBrandMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setBrandMenuOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [brandMenuOpen]);

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
  useRichLinkInvalidator(ws.events);

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
      {/* Section 32.1 — slim 32px header. Brand-block (192px) mirrors the
          rail width so the breadcrumb starts at the same x as the center
          column. Right-side keeps the gear + activity toggle. */}
      <header
        className="flex items-center border-b border-border bg-card text-xs"
        style={{ height: 32 }}
      >
        <div className="flex shrink-0 items-center" style={{ width: 192 }}>
          <button
            ref={brandButtonRef}
            type="button"
            onClick={() => setBrandMenuOpen((v) => !v)}
            className={`flex h-full w-full items-center gap-1.5 px-3 text-left hover:bg-muted/50 ${
              brandMenuOpen ? 'bg-muted/50' : ''
            }`}
            aria-haspopup="menu"
            aria-expanded={brandMenuOpen}
            title="App menu"
          >
            <img src="/icon.svg" alt="" className="h-5 w-5" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-primary">
              caisson
            </span>
            <span className="text-[10px] text-[var(--fg-dim)]">▾</span>
          </button>
        </div>
        <div className="flex flex-1 items-center gap-3 pr-3">
        {activeProject && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="text-foreground">{activeProject.name}</span>
            <span className="text-[var(--fg-dim)]">›</span>
            <span>{tabLabel(activeTab)}</span>
            {sessionLabel && activeTab === 'orchestrator' && (
              <>
                <span className="text-[var(--fg-dim)]">·</span>
                <button
                  ref={sessionBreadcrumbRef}
                  type="button"
                  onClick={() => setSessionSwitcherOpen((v) => !v)}
                  className={`inline-flex items-center gap-1 italic hover:text-accent ${
                    sessionSwitcherOpen ? 'text-accent' : ''
                  }`}
                  title="Switch sessions"
                  aria-expanded={sessionSwitcherOpen}
                  aria-haspopup="menu"
                >
                  <span className="max-w-[260px] truncate">{sessionLabel}</span>
                  <span className="text-[var(--fg-dim)]">▾</span>
                </button>
              </>
            )}
          </div>
        )}
        <div className="ml-auto flex items-center gap-3 text-[10px] uppercase tracking-[0.04em]">
          {telemetryModel && (
            <span className="flex items-center gap-1.5" title="Active orchestrator model">
              <span className="text-[var(--fg-dim)]">model</span>
              <span className="text-foreground">{telemetryModel}</span>
            </span>
          )}
          {(telemetryUsage.inputTokens +
            telemetryUsage.outputTokens +
            telemetryUsage.cacheCreationTokens +
            telemetryUsage.cacheReadTokens) > 0 && (
            <span
              className="flex items-center gap-1.5 tabular-nums"
              title={formatTokenTooltip(telemetryUsage)}
            >
              <span className="text-[var(--fg-dim)]">tokens</span>
              <span className="text-foreground">
                {formatTokens(
                  telemetryUsage.inputTokens +
                    telemetryUsage.outputTokens +
                    telemetryUsage.cacheCreationTokens +
                    telemetryUsage.cacheReadTokens,
                )}
              </span>
              <span className="text-[var(--fg-dim)]">·</span>
              <span className="text-foreground">{formatCostFromUsage(telemetryUsage)}</span>
              <span className="text-[var(--fg-dim)]">est</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
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
      {sessionSwitcherOpen && activeProject && (
        <SessionSwitcher
          projectId={activeProject.id}
          activeSessionId={sessionId}
          anchorEl={sessionBreadcrumbRef.current}
          onClose={() => setSessionSwitcherOpen(false)}
        />
      )}
      {brandMenuOpen && (
        <div
          ref={brandMenuRef}
          role="menu"
          style={{ position: 'fixed', top: 32, left: 0, width: 192, zIndex: 50 }}
          className="border border-primary/40 bg-popover py-1 text-popover-foreground shadow-2xl"
        >
          <button
            role="menuitem"
            type="button"
            disabled={!settings}
            onClick={() => {
              setBrandMenuOpen(false);
              setSettingsOpen(true);
            }}
            className="block w-full px-3 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-40"
          >
            App settings…
          </button>
        </div>
      )}
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

// Anthropic list pricing per 1M tokens (Opus tier). Same constants StatusBar
// used pre-32.4; kept here so the header roll-up shows the same numbers.
const OPUS_PRICING_PER_TOKEN = {
  input: 15 / 1_000_000,
  output: 75 / 1_000_000,
  cacheCreate: 18.75 / 1_000_000,
  cacheRead: 1.5 / 1_000_000,
};

interface UsageLike {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1) + 'k';
  return (n / 1_000_000).toFixed(2) + 'M';
}

function formatCost(dollars: number): string {
  if (dollars === 0) return '$0.00';
  if (dollars < 0.01) return '<$0.01';
  if (dollars < 1) return '$' + dollars.toFixed(3);
  return '$' + dollars.toFixed(2);
}

function formatCostFromUsage(u: UsageLike): string {
  return formatCost(
    u.inputTokens * OPUS_PRICING_PER_TOKEN.input +
      u.outputTokens * OPUS_PRICING_PER_TOKEN.output +
      u.cacheCreationTokens * OPUS_PRICING_PER_TOKEN.cacheCreate +
      u.cacheReadTokens * OPUS_PRICING_PER_TOKEN.cacheRead,
  );
}

function formatTokenTooltip(u: UsageLike): string {
  const total =
    u.inputTokens + u.outputTokens + u.cacheCreationTokens + u.cacheReadTokens;
  return (
    `input:        ${u.inputTokens.toLocaleString()}\n` +
    `output:       ${u.outputTokens.toLocaleString()}\n` +
    `cache write:  ${u.cacheCreationTokens.toLocaleString()}\n` +
    `cache read:   ${u.cacheReadTokens.toLocaleString()}\n` +
    `─────────────────────\n` +
    `total:        ${total.toLocaleString()}\n\n` +
    `est. API cost (informational — subscription billing):\n` +
    `  ${formatCostFromUsage(u)}`
  );
}
