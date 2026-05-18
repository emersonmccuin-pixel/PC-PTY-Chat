// Section 2d — detail modal Overview tab + footer wiring.
//
// Tabs: Overview (this phase) · Children (2e) · Attachments (2f) · Activity (2i).
// Save = version-checked PATCH; 409 surfaces an inline reload prompt. WS-driven
// prop updates: silent re-sync when not dirty, "remote changed" banner when the
// user has unsaved edits and the prop's version has advanced.

import { useEffect, useMemo, useState } from 'react';

import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import {
  api,
  WorkItemConflictError,
  type Attachment,
  type Project,
  type WorkItem,
  type WorkItemPatch,
} from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';

type TabId = 'overview' | 'children' | 'attachments' | 'activity';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'children', label: 'Children' },
  { id: 'attachments', label: 'Attachments' },
  { id: 'activity', label: 'Activity' },
];

interface WorkItemDetailModalProps {
  workItem: WorkItem;
  project: Project;
  items: WorkItem[];
  events: WsEnvelope[];
  onClose: () => void;
  onSwitchItem: (id: string) => void;
  /** Optimistic insert into the parent's items list. Used by "+ New child" so
   *  switching to the freshly-created child doesn't unmount the modal in the
   *  gap between create-response and WS-driven refetch. */
  onItemCreated: (wi: WorkItem) => void;
}

interface Draft {
  title: string;
  body: string;
  stageId: string;
}

function draftFromItem(wi: WorkItem): Draft {
  return { title: wi.title, body: wi.body, stageId: wi.stageId };
}

function isDirty(draft: Draft, baseline: WorkItem): boolean {
  return (
    draft.title !== baseline.title ||
    draft.body !== baseline.body ||
    draft.stageId !== baseline.stageId
  );
}

export function WorkItemDetailModal({
  workItem,
  project,
  items,
  events,
  onClose,
  onSwitchItem,
  onItemCreated,
}: WorkItemDetailModalProps) {
  const [tab, setTab] = useState<TabId>('overview');
  const [baseline, setBaseline] = useState<WorkItem>(workItem);
  const [draft, setDraft] = useState<Draft>(() => draftFromItem(workItem));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<WorkItem | null>(null);
  const [remoteChanged, setRemoteChanged] = useState<WorkItem | null>(null);

  // Re-sync when the parent passes us a new (or refreshed) work item.
  // - Different id: parent breadcrumb switched targets — reset everything.
  // - Same id, newer version, not dirty: silently adopt the new state.
  // - Same id, newer version, dirty: keep draft; surface a "remote changed" banner.
  useEffect(() => {
    if (workItem.id !== baseline.id) {
      setBaseline(workItem);
      setDraft(draftFromItem(workItem));
      setRemoteChanged(null);
      setConflict(null);
      setError(null);
      return;
    }
    if (workItem.version === baseline.version) return;
    if (isDirty(draft, baseline)) {
      setRemoteChanged(workItem);
    } else {
      setBaseline(workItem);
      setDraft(draftFromItem(workItem));
    }
  }, [workItem, baseline, draft]);

  const dirty = isDirty(draft, baseline);

  function confirmDiscardIfDirty(): boolean {
    if (!dirty) return true;
    return window.confirm('Discard unsaved changes?');
  }

  function attemptClose() {
    if (confirmDiscardIfDirty()) onClose();
  }

  function attemptSwitch(id: string) {
    if (confirmDiscardIfDirty()) onSwitchItem(id);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') attemptClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // attemptClose closes over `dirty`; refresh listener whenever dirty flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  async function save() {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    setConflict(null);
    try {
      const patch: WorkItemPatch = {};
      if (draft.title !== baseline.title) patch.title = draft.title;
      if (draft.body !== baseline.body) patch.body = draft.body;
      if (draft.stageId !== baseline.stageId) patch.stageId = draft.stageId;
      const updated = await api.patchWorkItem(
        project.id,
        baseline.id,
        baseline.version,
        patch,
      );
      setBaseline(updated);
      setDraft(draftFromItem(updated));
      setRemoteChanged(null);
    } catch (e) {
      if (e instanceof WorkItemConflictError) {
        setConflict(e.current);
      } else {
        setError((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  function reloadFromServer(next: WorkItem) {
    setBaseline(next);
    setDraft(draftFromItem(next));
    setConflict(null);
    setRemoteChanged(null);
    setError(null);
  }

  const parent = baseline.parentId
    ? items.find((i) => i.id === baseline.parentId) ?? null
    : null;
  const stageOptions = useMemo(
    () => [...project.stages].sort((a, b) => a.order - b.order),
    [project.stages],
  );
  const children = useMemo(
    () =>
      items
        .filter((i) => i.parentId === baseline.id)
        .sort((a, b) => a.position - b.position),
    [items, baseline.id],
  );
  const stageNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of project.stages) m.set(s.id, s.name);
    return m;
  }, [project.stages]);

  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-black/40"
      onClick={attemptClose}
    >
      <div
        className="flex h-[80vh] w-full max-w-3xl flex-col border border-border bg-card text-foreground"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <input
              type="text"
              value={draft.title}
              onChange={(e) => setDraft((p) => ({ ...p, title: e.target.value }))}
              placeholder="Untitled"
              className="w-full bg-transparent text-base font-semibold text-foreground outline-none placeholder:text-muted-foreground"
              aria-label="Title"
            />
            <p className="mt-0.5 text-xs text-muted-foreground">
              v{baseline.version} · {baseline.status}
              {baseline.statusReason && (
                <span className="ml-1 text-muted-foreground/70">
                  ({baseline.statusReason})
                </span>
              )}
            </p>
          </div>
          <button
            onClick={attemptClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <nav className="flex gap-1 border-b border-border px-2 pt-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={
                'flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-sm transition-colors ' +
                (tab === t.id
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground')
              }
            >
              <span>{t.label}</span>
              {t.id === 'children' && children.length > 0 && (
                <span className="border border-border px-1 text-[10px] font-normal text-muted-foreground">
                  {children.length}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {conflict && (
            <ConflictBanner
              kind="conflict"
              current={conflict}
              onReload={() => reloadFromServer(conflict)}
              onDismiss={() => setConflict(null)}
            />
          )}
          {!conflict && remoteChanged && (
            <ConflictBanner
              kind="remote"
              current={remoteChanged}
              onReload={() => reloadFromServer(remoteChanged)}
              onDismiss={() => setRemoteChanged(null)}
            />
          )}

          {tab === 'overview' && (
            <OverviewTab
              workItem={baseline}
              draft={draft}
              setDraft={setDraft}
              parent={parent}
              stages={stageOptions}
              onSwitchToParent={() => parent && attemptSwitch(parent.id)}
            />
          )}
          {tab === 'children' && (
            <ChildrenTab
              projectId={project.id}
              parent={baseline}
              children={children}
              stageNameById={stageNameById}
              onSwitch={attemptSwitch}
              onCreated={(child) => {
                onItemCreated(child);
                onSwitchItem(child.id);
              }}
            />
          )}
          {tab === 'attachments' && (
            <AttachmentsTab
              projectId={project.id}
              workItemId={baseline.id}
              events={events}
            />
          )}
          {tab === 'activity' && (
            <StubPanel
              label="Activity"
              note="events.jsonl-derived timeline lands in phase 2i."
            />
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          {error && (
            <span
              className="mr-auto truncate text-xs text-destructive"
              title={error}
            >
              {error}
            </span>
          )}
          {!error && dirty && (
            <span className="mr-auto text-xs text-muted-foreground">
              unsaved changes
            </span>
          )}
          <button
            onClick={attemptClose}
            className="border border-border bg-background px-3 py-1 text-sm hover:bg-muted disabled:opacity-50"
            disabled={busy}
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={!dirty || busy}
            className="bg-primary px-3 py-1 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function ConflictBanner({
  kind,
  current,
  onReload,
  onDismiss,
}: {
  kind: 'conflict' | 'remote';
  current: WorkItem;
  onReload: () => void;
  onDismiss: () => void;
}) {
  const headline =
    kind === 'conflict'
      ? 'Save failed: this item changed elsewhere.'
      : 'This item just changed elsewhere.';
  return (
    <div className="mb-3 flex items-start gap-2 border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{headline}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          Server is at v{current.version}. Reload replaces your draft with the latest.
        </div>
      </div>
      <button
        onClick={onReload}
        className="border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
      >
        Reload
      </button>
      <button
        onClick={onDismiss}
        className="px-1 text-xs text-muted-foreground hover:text-foreground"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

function OverviewTab({
  workItem,
  draft,
  setDraft,
  parent,
  stages,
  onSwitchToParent,
}: {
  workItem: WorkItem;
  draft: Draft;
  setDraft: (next: Draft | ((p: Draft) => Draft)) => void;
  parent: WorkItem | null;
  stages: { id: string; name: string }[];
  onSwitchToParent: () => void;
}) {
  const fieldEntries = Object.entries(workItem.fields ?? {});
  return (
    <div className="flex flex-col gap-4 text-foreground">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Stage">
          <select
            value={draft.stageId}
            onChange={(e) => setDraft((p) => ({ ...p, stageId: e.target.value }))}
            className="w-full border border-border bg-background px-2 py-1 text-sm"
          >
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Parent">
          {parent ? (
            <button
              onClick={onSwitchToParent}
              className="w-full truncate border border-border bg-muted/30 px-2 py-1 text-left text-sm text-foreground hover:bg-muted"
              title={parent.title}
            >
              ↑ {parent.title}
            </button>
          ) : (
            <div className="px-2 py-1 text-sm text-muted-foreground">
              — (top-level)
            </div>
          )}
        </Field>
      </div>

      <Field label="Body">
        <textarea
          value={draft.body}
          onChange={(e) => setDraft((p) => ({ ...p, body: e.target.value }))}
          rows={10}
          className="w-full resize-y border border-border bg-background px-2 py-1 font-mono text-xs leading-relaxed text-foreground"
          placeholder="No body."
        />
      </Field>

      <Field label="Fields">
        {fieldEntries.length === 0 ? (
          <div className="border border-dashed border-border px-2 py-3 text-xs text-muted-foreground">
            No fields set. Typed editor lands in phase 2g.
          </div>
        ) : (
          <div className="border border-border">
            {fieldEntries.map(([k, v]) => (
              <div
                key={k}
                className="flex items-start gap-3 border-b border-border px-2 py-1.5 last:border-b-0"
              >
                <div
                  className="w-32 shrink-0 truncate font-mono text-xs text-muted-foreground"
                  title={k}
                >
                  {k}
                </div>
                <div className="min-w-0 flex-1 break-words font-mono text-xs text-foreground">
                  {renderFieldValue(v)}
                </div>
              </div>
            ))}
          </div>
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
        <span>v{workItem.version}</span>
        <span aria-hidden>·</span>
        <span title={new Date(workItem.createdAt).toLocaleString()}>
          created {formatRelative(workItem.createdAt)}
        </span>
        <span aria-hidden>·</span>
        <span title={new Date(workItem.updatedAt).toLocaleString()}>
          updated {formatRelative(workItem.updatedAt)}
        </span>
      </div>
    </div>
  );
}

function renderFieldValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'string') return v.length === 0 ? '""' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  if (abs < minute) return 'just now';
  const future = diff < 0;
  let value: string;
  if (abs < hour) value = `${Math.round(abs / minute)}m`;
  else if (abs < day) value = `${Math.round(abs / hour)}h`;
  else if (abs < week) value = `${Math.round(abs / day)}d`;
  else value = `${Math.round(abs / week)}w`;
  return future ? `in ${value}` : `${value} ago`;
}

function ChildrenTab({
  projectId,
  parent,
  children,
  stageNameById,
  onSwitch,
  onCreated,
}: {
  projectId: string;
  parent: WorkItem;
  children: WorkItem[];
  stageNameById: Map<string, string>;
  onSwitch: (id: string) => void;
  onCreated: (child: WorkItem) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.createWorkItem(projectId, trimmed, parent.stageId, {
        parentId: parent.id,
      });
      setTitle('');
      setCreating(false);
      onCreated(r.workItem);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {children.length === 0 ? (
        <div className="border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          No children yet.
        </div>
      ) : (
        <div className="border border-border">
          {children.map((child) => (
            <button
              key={child.id}
              onClick={() => onSwitch(child.id)}
              className="flex w-full items-center gap-3 border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-muted"
            >
              <span className="line-clamp-1 min-w-0 flex-1 break-words text-sm text-foreground">
                {child.title}
              </span>
              <span className="shrink-0 text-[11px] uppercase tracking-wider text-muted-foreground">
                {stageNameById.get(child.stageId) ?? child.stageId}
              </span>
            </button>
          ))}
        </div>
      )}

      {creating ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="flex flex-col gap-2 border border-border p-2"
        >
          <input
            autoFocus
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Child title"
            className="border border-border bg-background px-2 py-1 text-sm"
          />
          {err && <div className="text-xs text-destructive">{err}</div>}
          <div className="flex gap-1">
            <button
              type="submit"
              disabled={busy || !title.trim()}
              className="bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create'}
            </button>
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setTitle('');
                setErr(null);
              }}
              className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Defaults to parent's stage ({stageNameById.get(parent.stageId) ?? parent.stageId}).
          </p>
        </form>
      ) : (
        <button
          onClick={() => setCreating(true)}
          className="self-start px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          + New child
        </button>
      )}
    </div>
  );
}

function AttachmentsTab({
  projectId,
  workItemId,
  events,
}: {
  projectId: string;
  workItemId: string;
  events: WsEnvelope[];
}) {
  const [items, setItems] = useState<Attachment[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const refetch = () => {
    api
      .listAttachments(projectId, workItemId)
      .then(setItems)
      .catch((e) => setErr((e as Error).message));
  };

  useEffect(() => {
    setItems(null);
    setExpandedId(null);
    setErr(null);
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, workItemId]);

  useEffect(() => {
    if (events.length === 0) return;
    const last = events[events.length - 1];
    if (!last) return;
    if (last.type === 'attachment-changed' && last.workItemId === workItemId) {
      refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, workItemId]);

  async function del(aId: string) {
    if (!window.confirm('Delete this attachment? This cannot be undone.')) return;
    try {
      await api.deleteAttachment(projectId, workItemId, aId);
      setItems((prev) => prev?.filter((a) => a.id !== aId) ?? null);
      if (expandedId === aId) setExpandedId(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (err) {
    return (
      <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        {err}
      </div>
    );
  }
  if (items === null) {
    return <div className="text-xs text-muted-foreground">Loading…</div>;
  }
  if (items.length === 0) {
    return (
      <div className="border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
        No attachments yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {items.map((att) => (
        <AttachmentRow
          key={att.id}
          attachment={att}
          expanded={expandedId === att.id}
          onToggle={() => setExpandedId((p) => (p === att.id ? null : att.id))}
          onDelete={() => void del(att.id)}
        />
      ))}
    </div>
  );
}

function AttachmentRow({
  attachment,
  expanded,
  onToggle,
  onDelete,
}: {
  attachment: Attachment;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const source = attachment.runId
    ? `run ${attachment.runId.slice(-8)}`
    : attachment.createdBySessionId
      ? `session ${attachment.createdBySessionId.slice(-8)}`
      : 'chat';
  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="shrink-0 border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {attachment.kind}
          </span>
          <span className="line-clamp-1 min-w-0 flex-1 break-words text-sm text-foreground">
            {attachment.name}
          </span>
          <span
            className="shrink-0 text-[11px] text-muted-foreground"
            title={new Date(attachment.createdAt).toLocaleString()}
          >
            {source} · {formatRelative(attachment.createdAt)}
          </span>
          <span aria-hidden className="shrink-0 text-xs text-muted-foreground">
            {expanded ? '▾' : '▸'}
          </span>
        </button>
        <button
          onClick={onDelete}
          className="shrink-0 border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
          aria-label={`Delete ${attachment.name}`}
        >
          Delete
        </button>
      </div>
      {expanded && (
        <div className="border-t border-border bg-background px-3 py-2">
          <AttachmentBody attachment={attachment} />
        </div>
      )}
    </div>
  );
}

function AttachmentBody({ attachment }: { attachment: Attachment }) {
  const kind = (attachment.kind || '').toLowerCase();
  if (kind === 'markdown' || kind === 'md') {
    return (
      <div className="prose prose-sm prose-invert max-w-none text-sm">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
          {attachment.content}
        </ReactMarkdown>
      </div>
    );
  }
  if (kind === 'json') {
    let pretty = attachment.content;
    try {
      pretty = JSON.stringify(JSON.parse(attachment.content), null, 2);
    } catch {
      // fall back to raw content
    }
    return (
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-foreground">
        {pretty}
      </pre>
    );
  }
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-foreground">
      {attachment.content}
    </pre>
  );
}

function StubPanel({ label, note }: { label: string; note: string }) {
  return (
    <div className="flex flex-col gap-2 text-muted-foreground">
      <div className="text-xs uppercase tracking-wider text-foreground">{label}</div>
      <p className="text-sm">{note}</p>
    </div>
  );
}
