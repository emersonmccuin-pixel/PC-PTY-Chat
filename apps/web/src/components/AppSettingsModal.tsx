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

import { api, type GlobalSettings } from '@/api/client';
import { FolderBrowserModal } from './FolderBrowserModal';

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
  const initialDataDir = useRef(settings.dataDir);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !pickerOpen) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickerOpen, onClose]);

  const dataDirDirty = draft.dataDir !== initialDataDir.current;

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const patch: Partial<GlobalSettings> = {
        projectsFolder: draft.projectsFolder,
        telemetryOptIn: draft.telemetryOptIn,
      };
      if (dataDirDirty) patch.dataDir = draft.dataDir;
      const r = await api.patchSettings(patch);
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
        onClick={onClose}
      >
        <div
          className="flex w-[560px] flex-col border border-border bg-card text-foreground"
          onClick={(e) => e.stopPropagation()}
        >
          <header className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-base font-semibold">App settings</h2>
            <button
              onClick={onClose}
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

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
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
