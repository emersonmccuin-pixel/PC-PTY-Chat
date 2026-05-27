// D84 — typed-confirm modals for the project danger-zone surfaces.
// Used from ProjectSettingsPanel's DangerZone block and from the
// ProjectRail right-click menu (D86). Explicit close-only — no
// backdrop-click / Escape dismissal — and the destructive button stays
// disabled until the user types the project slug verbatim.

import { useState } from 'react';

import { api, type Project } from '@/api/client';

interface SoftDeleteProjectModalProps {
  project: Project;
  onCancel: () => void;
  onDeleted: (projectId: string) => void;
}

export function SoftDeleteProjectModal({
  project,
  onCancel,
  onDeleted,
}: SoftDeleteProjectModalProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const matches = typed === project.slug;

  async function run() {
    if (!matches || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.softDeleteProject(project.id);
      onDeleted(project.id);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <ModalFrame title="Archive project" onCancel={onCancel} busy={busy}>
      <p className="text-sm text-foreground/90">
        Hides <span className="font-medium">{project.name}</span> from the rail.
        Files on disk are untouched and the project can be restored from
        <span className="whitespace-nowrap"> "Show archived"</span> later.
      </p>
      <TypeToConfirm
        slug={project.slug}
        value={typed}
        onChange={setTyped}
        busy={busy}
      />
      {err && <p className="text-xs text-destructive">{err}</p>}
      <ModalFooter
        onCancel={onCancel}
        onAction={run}
        actionLabel={busy ? 'Archiving…' : 'Archive project'}
        actionDisabled={!matches || busy}
        busy={busy}
      />
    </ModalFrame>
  );
}

interface DeleteProjectFilesModalProps {
  project: Project;
  onCancel: () => void;
  onDone: (removed: string[]) => void;
}

export function DeleteProjectFilesModal({
  project,
  onCancel,
  onDone,
}: DeleteProjectFilesModalProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const matches = typed === project.slug;

  async function run() {
    if (!matches || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const removed = await api.deleteProjectFiles(project.id);
      onDone(removed);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <ModalFrame title="Delete PC files on disk" onCancel={onCancel} busy={busy}>
      <p className="text-sm text-foreground/90">
        Removes <code className="bg-muted px-1 font-mono text-xs">.project-companion/</code>{' '}
        from <span className="font-medium">{project.name}</span>'s folder. Legacy
        PC-owned <code className="bg-muted px-1 font-mono text-xs">.claude/</code>{' '}
        config is removed only when marked as PC-managed. Your own files,{' '}
        <code className="bg-muted px-1 font-mono text-xs">.git/</code>, README, and{' '}
        <code className="bg-muted px-1 font-mono text-xs">.mcp.json</code> stay.
        Independent of the archive state — does not remove the project record from PC.
      </p>
      <p className="text-xs text-foreground/80">
        Folder: <code className="bg-muted px-1 font-mono text-xs">{project.folderPath}</code>
      </p>
      <TypeToConfirm
        slug={project.slug}
        value={typed}
        onChange={setTyped}
        busy={busy}
      />
      {err && <p className="text-xs text-destructive">{err}</p>}
      <ModalFooter
        onCancel={onCancel}
        onAction={run}
        actionLabel={busy ? 'Removing…' : 'Delete files'}
        actionDisabled={!matches || busy}
        busy={busy}
      />
    </ModalFrame>
  );
}

// ─── Shared building blocks ───────────────────────────────────────────────

function ModalFrame({
  title,
  onCancel,
  busy,
  children,
}: {
  title: string;
  onCancel: () => void;
  busy: boolean;
  children: React.ReactNode;
}) {
  // Backdrop click is a no-op (explicit close-only per memory
  // [[modals-explicit-close-only]]). No Escape handler either — destructive
  // actions shouldn't dismiss on a stray keypress.
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50">
      <div className="flex w-[520px] flex-col border border-destructive/40 bg-card text-foreground shadow-xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold text-destructive">{title}</h2>
          <button
            onClick={onCancel}
            disabled={busy}
            className="text-muted-foreground hover:text-foreground disabled:opacity-50"
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <div className="flex flex-col gap-3 px-4 py-4">{children}</div>
      </div>
    </div>
  );
}

function TypeToConfirm({
  slug,
  value,
  onChange,
  busy,
}: {
  slug: string;
  value: string;
  onChange: (v: string) => void;
  busy: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">
        Type <code className="bg-muted px-1 font-mono">{slug}</code> to confirm.
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={busy}
        autoFocus
        spellCheck={false}
        autoComplete="off"
        className="border border-border bg-background px-2 py-1 font-mono text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
      />
    </label>
  );
}

function ModalFooter({
  onCancel,
  onAction,
  actionLabel,
  actionDisabled,
  busy,
}: {
  onCancel: () => void;
  onAction: () => void;
  actionLabel: string;
  actionDisabled: boolean;
  busy: boolean;
}) {
  return (
    <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
      <button
        onClick={onCancel}
        disabled={busy}
        className="border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
      >
        Cancel
      </button>
      <button
        onClick={onAction}
        disabled={actionDisabled}
        className="bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
      >
        {actionLabel}
      </button>
    </div>
  );
}
