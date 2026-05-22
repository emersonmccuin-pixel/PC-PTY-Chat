// Q10 — app-wide settings modal.
//
// Opened from the header gear icon. Form fields are the Q10 envelope:
//   - projectsFolder (folder picker, hot-reloadable — used as the default
//     initial path in the create-project flow)
//   - telemetryOptIn (toggle, hot)
//   - dataDir (read-only display + edit button → restart-required banner)
//
// dataDir is the only field that needs a process restart per v1 decision #24;
// all others apply immediately on PATCH /api/settings.

import { useEffect, useRef, useState } from 'react';

import {
  api,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_STEP,
  type GlobalSettings,
  type Pod,
  type Project,
  type ULID,
} from '@/api/client';
import { FolderBrowserModal } from './FolderBrowserModal';
import { PodDetailModal } from './agents/PodDetailModal';

const STOCK_POD_NAMES = new Set([
  'orchestrator',
  'researcher',
  'writer',
  'reviewer',
  'planner',
  'extractor',
  'agent-designer',
]);

interface AppSettingsModalProps {
  settings: GlobalSettings;
  onClose: () => void;
  onSaved: (next: GlobalSettings, restartRequired: boolean) => void;
}

export function AppSettingsModal({ settings, onClose, onSaved }: AppSettingsModalProps) {
  const [draft, setDraft] = useState<GlobalSettings>(settings);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [specialistsOpen, setSpecialistsOpen] = useState(false);
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
      if (e.key === 'Escape' && !pickerOpen) cancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerOpen]);

  useEffect(() => {
    let cancelled = false;
    void api.listProjects().then((list) => {
      if (!cancelled) setProjects(list);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Load stock pods when the Specialists section is first expanded. They're
  // a global-scope subset; filter the global pool to stock names.
  useEffect(() => {
    if (!specialistsOpen) return;
    if (stockPods !== null) return; // already loaded
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
  }, [specialistsOpen, stockPods]);

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

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const patch: Partial<GlobalSettings> = {
        projectsFolder: draft.projectsFolder,
        telemetryOptIn: draft.telemetryOptIn,
        bugLogTargetProjectId: draft.bugLogTargetProjectId,
        fontScale: draft.fontScale,
      };
      if (dataDirDirty) patch.dataDir = draft.dataDir;
      const r = await api.patchSettings(patch);
      initialFontScale.current = r.settings.fontScale;
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
        className="fixed inset-0 z-40 grid place-items-center bg-black/40"
        onClick={cancel}
      >
        <div
          className="flex w-[560px] flex-col border border-border bg-card text-foreground"
          onClick={(e) => e.stopPropagation()}
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

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            className="flex flex-col gap-4 px-4 py-4"
          >
            <FieldRow
              label="Projects folder"
              help="Default initial path for the create-project folder picker. Hot-reloadable."
            >
              <div className="flex items-stretch gap-1">
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
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
                  onChange={(e) => setDraft({ ...draft, telemetryOptIn: e.target.checked })}
                />
                <span>Enable telemetry</span>
              </label>
            </FieldRow>

            <FieldRow
              label="Bug log target"
              help="When Log Bug is called from any project's chat, the bug card lands here. Leave unset to disable the tool."
            >
              <select
                value={draft.bugLogTargetProjectId ?? ''}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    bugLogTargetProjectId: e.target.value === '' ? null : (e.target.value as ULID),
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
                  onChange={(e) =>
                    setDraft({ ...draft, fontScale: parseFloat(e.target.value) })
                  }
                  className="flex-1 accent-primary"
                />
                <span className="w-12 text-right tabular-nums text-xs text-muted-foreground">
                  {Math.round(draft.fontScale * 100)}%
                </span>
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, fontScale: 1 })}
                  disabled={draft.fontScale === 1}
                  className="border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                >
                  Reset
                </button>
              </div>
            </FieldRow>

            <FieldRow
              label="Data dir"
              help="Where PC stores sqlite, worktrees, events. Changing requires a restart."
            >
              <input
                type="text"
                value={draft.dataDir}
                onChange={(e) => setDraft({ ...draft, dataDir: e.target.value })}
                className="w-full border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
              />
              {dataDirDirty && (
                <div className="mt-1 border border-warning/60 bg-warning/10 px-2 py-1 text-xs text-warning">
                  Restart required for data-dir change to take effect.
                </div>
              )}
            </FieldRow>

            {err && <div className="text-xs text-destructive">{err}</div>}

            <section className="flex flex-col gap-2 border-t border-border pt-3">
              <button
                type="button"
                onClick={() => setSpecialistsOpen((v) => !v)}
                className="flex items-center justify-between gap-3 text-left text-sm uppercase tracking-wider text-muted-foreground hover:opacity-80"
              >
                <span className="flex items-center gap-2">
                  <span aria-hidden className="inline-block w-3 text-[10px]">
                    {specialistsOpen ? '▼' : '▶'}
                  </span>
                  <span>Specialists</span>
                  <span className="bg-destructive/20 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-destructive">
                    danger zone
                  </span>
                </span>
              </button>
              {specialistsOpen && (
                <div className="flex flex-col gap-3">
                  <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    Editing stock specialists changes how every project's agents behave. Workflows that depend on the seeded prompt or tools may break. Reset to default restores the seeded content; knowledge, secrets, and MCP servers are untouched.
                  </div>
                  {resetErr && (
                    <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      {resetErr}
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
                              onClick={() => setEditPodId(pod.id)}
                              className="border border-border bg-card px-2 py-1 text-xs hover:bg-muted"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => void resetPod(pod)}
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
              )}
            </section>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={cancel}
                className="border border-border px-3 py-1.5 text-sm hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
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
