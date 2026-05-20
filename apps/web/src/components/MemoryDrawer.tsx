// /memory right-side drawer. Mounts inside the Orchestrator chat panel and
// overlays the right portion so the chat stays visible on the left. Three
// scope tabs (User / Project / Workspace) backed by the
// `/api/projects/:id/memory/:scope` endpoint pair.

import { useEffect, useState } from 'react';

import { api, type MemoryFile, type MemoryScope } from '@/api/client';
import { useMemoryDrawer } from '@/store/memory-drawer';

const SCOPE_TABS: { scope: MemoryScope; label: string; help: string }[] = [
  {
    scope: 'user',
    label: 'User',
    help: '~/.claude/CLAUDE.md — applies to every Claude Code session on this machine.',
  },
  {
    scope: 'project',
    label: 'Project',
    help: 'The current project\'s CLAUDE.md — applies only to this project.',
  },
  {
    scope: 'workspace',
    label: 'Workspace',
    help: 'The parent folder\'s CLAUDE.md — applies to every project under that folder.',
  },
];

interface MemoryDrawerProps {
  projectId: string;
}

export function MemoryDrawer({ projectId }: MemoryDrawerProps) {
  const open = useMemoryDrawer((s) => s.open);
  const setOpen = useMemoryDrawer((s) => s.setOpen);

  const [activeScope, setActiveScope] = useState<MemoryScope>('project');
  const [file, setFile] = useState<MemoryFile | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setSavedNote(null);
    api
      .getMemoryFile(projectId, activeScope)
      .then((f) => {
        if (cancelled) return;
        setFile(f);
        setDraft(f.content);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setErr((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId, activeScope]);

  if (!open) return null;

  const dirty = file !== null && draft !== file.content;

  async function save() {
    if (saveBusy || !dirty) return;
    setSaveBusy(true);
    setErr(null);
    setSavedNote(null);
    try {
      const next = await api.putMemoryFile(projectId, activeScope, draft);
      setFile(next);
      setSavedNote(next.exists ? `Saved · ${next.path}` : 'Saved');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaveBusy(false);
    }
  }

  return (
    <div className="absolute inset-y-0 right-0 z-20 flex w-1/2 min-w-[360px] flex-col border-l border-border bg-card shadow-xl">
      <div className="flex items-center justify-between border-b border-border bg-card px-3 py-2">
        <span className="text-sm font-semibold uppercase tracking-wider text-foreground">
          Memory
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Close memory drawer"
          title="Close (Esc)"
        >
          ×
        </button>
      </div>

      <div className="flex items-center border-b border-border bg-card px-3">
        {SCOPE_TABS.map((t) => (
          <button
            key={t.scope}
            type="button"
            onClick={() => setActiveScope(t.scope)}
            title={t.help}
            className={
              'px-3 py-2 text-xs uppercase tracking-wider border-b-2 -mb-px ' +
              (activeScope === t.scope
                ? 'border-primary text-primary font-medium'
                : 'border-transparent text-muted-foreground hover:text-foreground')
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="border-b border-border bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground">
        {file?.path ?? '…'}
        {file && !file.exists && (
          <span className="ml-2 text-warning">
            (file does not exist yet — first save creates it)
          </span>
        )}
      </div>

      <div className="flex-1 overflow-hidden p-3">
        {loading ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="# CLAUDE.md&#10;&#10;Project notes, conventions, anything the model should always know."
            className="h-full w-full resize-none border border-border bg-background p-2 font-mono text-xs leading-relaxed focus:border-primary focus:outline-none"
          />
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border bg-card px-3 py-2">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saveBusy || loading}
          className="bg-primary px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {saveBusy ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => setDraft(file?.content ?? '')}
          disabled={!dirty || saveBusy}
          className="border border-border px-3 py-1.5 text-xs uppercase tracking-wider hover:bg-muted disabled:opacity-50"
        >
          Discard
        </button>
        {err && <span className="text-xs text-destructive">{err}</span>}
        {savedNote && !err && (
          <span className="text-xs text-success">{savedNote}</span>
        )}
      </div>
    </div>
  );
}
