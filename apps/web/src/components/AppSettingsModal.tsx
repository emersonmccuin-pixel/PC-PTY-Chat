// Q10 — app-wide settings modal.
//
// Tabbed shell modelled on ProjectSettingsPanel: left-side nav + per-tab
// content + per-tab Save (where applicable).
//
// Tabs:
//   - General: projectsFolder, telemetryOptIn, bugLogTargetProjectId, fontScale.
//   - Storage: dataDir (restart-required).
//   - Specialists: stock pod editor (danger zone) — per-pod actions, no form Save.
//
// dataDir is the only field that needs a process restart per v1 decision #24;
// all others apply immediately on PATCH /api/settings.

import { useEffect, useRef, useState } from 'react';

import {
  api,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_STEP,
  STOCK_POD_NAMES,
  type GlobalSettings,
  type Pod,
  type Project,
  type ULID,
} from '@/api/client';
import { FolderBrowserModal } from './FolderBrowserModal';
import { PodDetailModal } from './agents/PodDetailModal';

type TabId = 'general' | 'storage' | 'specialists';

const TABS: { id: TabId; label: string; danger?: boolean }[] = [
  { id: 'general', label: 'General' },
  { id: 'storage', label: 'Storage' },
  { id: 'specialists', label: 'Specialists', danger: true },
];

interface AppSettingsModalProps {
  settings: GlobalSettings;
  onClose: () => void;
  onSaved: (next: GlobalSettings, restartRequired: boolean) => void;
}

export function AppSettingsModal({ settings, onClose, onSaved }: AppSettingsModalProps) {
  const [active, setActive] = useState<TabId>('general');
  const [draft, setDraft] = useState<GlobalSettings>(settings);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [stockPods, setStockPods] = useState<Pod[] | null>(null);
  const [editPodId, setEditPodId] = useState<ULID | null>(null);
  const [resetBusyId, setResetBusyId] = useState<ULID | null>(null);
  const [resetErr, setResetErr] = useState<string | null>(null);
  const initialDataDir = useRef(settings.dataDir);
  const initialFontScale = useRef(settings.fontScale);

  // Live-preview the font scale as the slider moves. Revert to the persisted
  // value if the user closes without saving.
  useEffect(() => {
    document.documentElement.style.setProperty('--font-scale', String(draft.fontScale));
  }, [draft.fontScale]);

  function cancel() {
    document.documentElement.style.setProperty('--font-scale', String(initialFontScale.current));
    onClose();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !pickerOpen && !editPodId) cancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerOpen, editPodId]);

  useEffect(() => {
    let cancelled = false;
    void api
      .listProjects()
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Load stock pods when the Specialists tab is first activated.
  useEffect(() => {
    if (active !== 'specialists') return;
    if (stockPods !== null) return;
    let cancelled = false;
    void api
      .listPods()
      .then((pods) => {
        if (cancelled) return;
        setStockPods(pods.filter((p) => p.scope === 'global' && STOCK_POD_NAMES.has(p.name)));
      })
      .catch((e) => {
        if (!cancelled) setResetErr((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [active, stockPods]);

  function refetchStockPods() {
    void api
      .listPods()
      .then((pods) => {
        setStockPods(pods.filter((p) => p.scope === 'global' && STOCK_POD_NAMES.has(p.name)));
      })
      .catch((e) => setResetErr((e as Error).message));
  }

  async function resetPod(pod: Pod) {
    const ok = window.confirm(
      `Reset "${pod.name}" to the seeded default?\n\nThe prompt, tools, model, effort, max-turns, and output destination revert. Knowledge, secrets, and MCP servers are untouched. The change is audited.`,
    );
    if (!ok) return;
    setResetErr(null);
    setResetBusyId(pod.id);
    try {
      await api.resetStockPodToDefault(pod.id);
      refetchStockPods();
    } catch (e) {
      setResetErr((e as Error).message);
    } finally {
      setResetBusyId(null);
    }
  }

  const editPod = stockPods?.find((p) => p.id === editPodId) ?? null;
  const dataDirDirty = draft.dataDir !== initialDataDir.current;

  const generalDirty =
    draft.projectsFolder !== settings.projectsFolder ||
    draft.telemetryOptIn !== settings.telemetryOptIn ||
    draft.bugLogTargetProjectId !== settings.bugLogTargetProjectId ||
    draft.fontScale !== settings.fontScale ||
    draft.hideCancelledStage !== settings.hideCancelledStage;

  async function saveGeneral() {
    if (busy || !generalDirty) return;
    setBusy(true);
    setErr(null);
    try {
      const patch: Partial<GlobalSettings> = {
        projectsFolder: draft.projectsFolder,
        telemetryOptIn: draft.telemetryOptIn,
        bugLogTargetProjectId: draft.bugLogTargetProjectId,
        fontScale: draft.fontScale,
        hideCancelledStage: draft.hideCancelledStage,
      };
      const r = await api.patchSettings(patch);
      initialFontScale.current = r.settings.fontScale;
      onSaved(r.settings, r.restartRequired);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveStorage() {
    if (busy || !dataDirDirty) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.patchSettings({ dataDir: draft.dataDir });
      initialDataDir.current = r.settings.dataDir;
      onSaved(r.settings, r.restartRequired);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div
        // NO backdrop dismissal per [[feedback_modals_explicit_close_only]] —
        // app settings hosts hard-to-redo work; implicit-close is destructive.
        className="fixed inset-0 z-40 grid place-items-center bg-black/40"
      >
        <div
          className="flex h-[600px] w-[800px] flex-col border border-border bg-card text-foreground"
        >
          <header className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-base font-semibold">App settings</h2>
            <button
              onClick={cancel}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              ×
            </button>
          </header>

          <div className="flex min-h-0 flex-1">
            <nav className="flex w-44 shrink-0 flex-col border-r border-border bg-card py-2">
              {TABS.map((t) => {
                const isActive = active === t.id;
                const base = 'block w-full border-l-2 px-3 py-2 text-left text-xs ';
                const state = isActive
                  ? 'border-primary bg-muted ' +
                    (t.danger ? 'text-destructive font-medium' : 'text-primary font-medium')
                  : 'border-transparent hover:bg-muted ' +
                    (t.danger ? 'text-destructive/80 hover:text-destructive' : 'text-foreground/80');
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setActive(t.id)}
                    className={base + state}
                  >
                    {t.label}
                  </button>
                );
              })}
            </nav>

            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex-1 overflow-y-auto px-5 py-4">
                {active === 'general' && (
                  <GeneralTab
                    draft={draft}
                    onDraftChange={(patch) => setDraft((p) => ({ ...p, ...patch }))}
                    projects={projects}
                    onBrowse={() => setPickerOpen(true)}
                  />
                )}
                {active === 'storage' && (
                  <StorageTab
                    draft={draft}
                    dataDirDirty={dataDirDirty}
                    onDraftChange={(patch) => setDraft((p) => ({ ...p, ...patch }))}
                  />
                )}
                {active === 'specialists' && (
                  <SpecialistsTab
                    stockPods={stockPods}
                    error={resetErr}
                    resetBusyId={resetBusyId}
                    onEdit={(id) => setEditPodId(id)}
                    onReset={(pod) => void resetPod(pod)}
                  />
                )}
              </div>

              {err && (
                <div className="border-t border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive">
                  {err}
                </div>
              )}

              <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
                {active === 'specialists' ? (
                  <button
                    type="button"
                    onClick={cancel}
                    className="border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
                  >
                    Close
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={cancel}
                      disabled={busy}
                      className="border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (active === 'general') void saveGeneral();
                        if (active === 'storage') void saveStorage();
                      }}
                      disabled={
                        busy ||
                        (active === 'general' && !generalDirty) ||
                        (active === 'storage' && !dataDirDirty)
                      }
                      className="bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    >
                      {busy ? 'Saving…' : 'Save'}
                    </button>
                  </>
                )}
              </footer>
            </div>
          </div>
        </div>
      </div>
      {pickerOpen && (
        <FolderBrowserModal
          initialPath={draft.projectsFolder}
          onCancel={() => setPickerOpen(false)}
          onSelect={(p) => {
            setDraft({ ...draft, projectsFolder: p });
            setPickerOpen(false);
          }}
        />
      )}
      {editPod && (
        <PodDetailModal
          pod={editPod}
          onClose={() => {
            setEditPodId(null);
            refetchStockPods();
          }}
          onDeleted={() => {
            // Stock pods can't be deleted server-side; this branch is
            // structurally unreachable. Refetch defensively if it does fire.
            setEditPodId(null);
            refetchStockPods();
          }}
        />
      )}
    </>
  );
}

// ── General tab ───────────────────────────────────────────────────────────

function GeneralTab({
  draft,
  onDraftChange,
  projects,
  onBrowse,
}: {
  draft: GlobalSettings;
  onDraftChange: (patch: Partial<GlobalSettings>) => void;
  projects: Project[];
  onBrowse: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <FieldRow
        label="Projects folder"
        help="Default initial path for the create-project folder picker. Hot-reloadable."
      >
        <div className="flex items-stretch gap-1">
          <button
            type="button"
            onClick={onBrowse}
            className="border border-border bg-card px-2 py-1 text-xs text-foreground hover:bg-muted"
          >
            Browse…
          </button>
          <code className="flex-1 truncate border border-border bg-muted px-2 py-1 font-mono text-xs text-foreground">
            {draft.projectsFolder}
          </code>
        </div>
      </FieldRow>

      <FieldRow label="Telemetry" help="Opt in to send anonymous usage stats. Off by default.">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.telemetryOptIn}
            onChange={(e) => onDraftChange({ telemetryOptIn: e.target.checked })}
          />
          <span>Enable telemetry</span>
        </label>
      </FieldRow>

      <FieldRow
        label="Hide cancelled stage"
        help="When on, the cancelled column is hidden on every project's kanban board. Each project can override this in its own settings."
      >
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.hideCancelledStage}
            onChange={(e) => onDraftChange({ hideCancelledStage: e.target.checked })}
          />
          <span>Hide cancelled by default</span>
        </label>
      </FieldRow>

      <FieldRow
        label="Bug log target"
        help="When Log Bug is called from any project's chat, the bug card lands here. Leave unset to disable the tool."
      >
        <select
          value={draft.bugLogTargetProjectId ?? ''}
          onChange={(e) =>
            onDraftChange({
              bugLogTargetProjectId:
                e.target.value === '' ? null : (e.target.value as ULID),
            })
          }
          className="w-full border border-border bg-background px-2 py-1 text-sm text-foreground"
        >
          <option value="">(none — Log Bug disabled)</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </FieldRow>

      <FieldRow
        label="Font scale"
        help={`Scales every text size in the app. ${Math.round(draft.fontScale * 100)}% — drag to preview, Save to keep.`}
      >
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={FONT_SCALE_MIN}
            max={FONT_SCALE_MAX}
            step={FONT_SCALE_STEP}
            value={draft.fontScale}
            onChange={(e) => onDraftChange({ fontScale: parseFloat(e.target.value) })}
            className="flex-1 accent-primary"
          />
          <span className="w-12 text-right tabular-nums text-xs text-muted-foreground">
            {Math.round(draft.fontScale * 100)}%
          </span>
          <button
            type="button"
            onClick={() => onDraftChange({ fontScale: 1 })}
            disabled={draft.fontScale === 1}
            className="border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            Reset
          </button>
        </div>
      </FieldRow>
    </div>
  );
}

// ── Storage tab ───────────────────────────────────────────────────────────

function StorageTab({
  draft,
  dataDirDirty,
  onDraftChange,
}: {
  draft: GlobalSettings;
  dataDirDirty: boolean;
  onDraftChange: (patch: Partial<GlobalSettings>) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <FieldRow
        label="Data dir"
        help="Where PC stores sqlite, worktrees, events. Changing requires a restart."
      >
        <input
          type="text"
          value={draft.dataDir}
          onChange={(e) => onDraftChange({ dataDir: e.target.value })}
          className="w-full border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
        />
        {dataDirDirty && (
          <div className="mt-1 border border-warning/60 bg-warning/10 px-2 py-1 text-xs text-warning">
            Restart required for data-dir change to take effect.
          </div>
        )}
      </FieldRow>
    </div>
  );
}

// ── Specialists tab ───────────────────────────────────────────────────────

function SpecialistsTab({
  stockPods,
  error,
  resetBusyId,
  onEdit,
  onReset,
}: {
  stockPods: Pod[] | null;
  error: string | null;
  resetBusyId: ULID | null;
  onEdit: (id: ULID) => void;
  onReset: (pod: Pod) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        Editing stock specialists changes how every project's agents behave. Workflows that depend on the seeded prompt or tools may break. Reset to default restores the seeded content; knowledge, secrets, and MCP servers are untouched.
      </div>
      {error && (
        <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      {stockPods === null ? (
        <div className="text-xs text-muted-foreground">Loading specialists…</div>
      ) : stockPods.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          No stock specialists found. They seed at server boot.
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {stockPods.map((pod) => (
            <div
              key={pod.id}
              className="grid grid-cols-[1fr_auto] items-center gap-3 border border-border bg-background px-3 py-2"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">{pod.name}</div>
                {pod.description && (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {pod.description}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => onEdit(pod.id)}
                  className="border border-border bg-card px-2 py-1 text-xs hover:bg-muted"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => onReset(pod)}
                  disabled={resetBusyId !== null}
                  className="border border-destructive/60 bg-card px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                  title="Restore the seeded canonical content."
                >
                  {resetBusyId === pod.id ? 'Resetting…' : 'Reset to default'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Shared field row ──────────────────────────────────────────────────────

function FieldRow({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-sm text-muted-foreground">{label}</div>
      {children}
      {help && <div className="text-xs text-muted-foreground">{help}</div>}
    </div>
  );
}
