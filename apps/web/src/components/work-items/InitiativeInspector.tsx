// Section 37.8 — full-page inspector for a single work item. Replaces the
// modal as the surface for top-level (and recursive) drilling. Sticky header
// + four-tab strip: Brief (this phase) · Children (37.9) · Documents (37.11)
// · Activity (37.12). The latter three are placeholders here.
//
// Open / close is controlled by the parent (WorkItemsPage); this component
// is presentational + handles inline editing of the body via the existing
// PATCH /work-items/:id endpoint.

import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import {
  api,
  WorkItemConflictError,
  type Project,
  type Stage,
  type WorkItem,
} from '@/api/client';

type InspectorTab = 'brief' | 'children' | 'documents' | 'activity';

interface Props {
  project: Project;
  workItem: WorkItem;
  /** Where the user came from — drives the back-breadcrumb label. */
  backLabel: string;
  onBack: () => void;
  /** Called after a successful body edit so the parent can update its list. */
  onWorkItemPatched: (next: WorkItem) => void;
}

export function InitiativeInspector({
  project,
  workItem,
  backLabel,
  onBack,
  onWorkItemPatched,
}: Props) {
  const [tab, setTab] = useState<InspectorTab>('brief');
  // Reset to Brief whenever we switch which item is being inspected.
  useEffect(() => setTab('brief'), [workItem.id]);

  const stage = useMemo(
    () => project.stages.find((s) => s.id === workItem.stageId) ?? null,
    [project.stages, workItem.stageId],
  );
  const phaseLabel = derivePhaseLabel(stage, workItem);

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Back breadcrumb */}
      <div
        className="flex items-center gap-2 border-b border-border/30 bg-[var(--surface-1)] px-5 text-[11px] uppercase tracking-[0.06em] text-muted-foreground"
        style={{ height: 32 }}
      >
        <button
          type="button"
          onClick={onBack}
          className="hover:text-primary"
        >
          ← {backLabel}
        </button>
        <span className="text-[var(--fg-dim)]">/</span>
        <span className="text-primary normal-case tracking-normal">
          {workItem.title}
        </span>
      </div>

      {/* Sticky header */}
      <div className="flex items-center gap-4 border-b border-border/30 bg-background px-7 py-4">
        <div className="flex items-baseline gap-2">
          <h1 className="text-[18px] font-bold tracking-[0.02em] text-[var(--fg-hot)]">
            {workItem.title}
          </h1>
          {workItem.callsign && (
            <span className="text-[11px] text-[var(--fg-dim)]">
              {workItem.callsign}
            </span>
          )}
        </div>
        <span className="border border-border/40 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-secondary">
          {phaseLabel}
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          <HeaderButton title="Pin (coming in 37.15)" disabled>
            Pin
          </HeaderButton>
          <HeaderButton title="Archive (coming in 37.15)" disabled>
            Archive
          </HeaderButton>
          <HeaderButton primary title="Chat about this (coming in 37.13)" disabled>
            Chat about this →
          </HeaderButton>
        </div>
      </div>

      {/* Tab bar */}
      <div
        className="flex items-center gap-1 border-b border-border/30 bg-[var(--surface-1)] px-7"
        style={{ height: 36 }}
      >
        <InspectorTabButton value="brief" active={tab} onSelect={setTab}>
          Brief
        </InspectorTabButton>
        <InspectorTabButton value="children" active={tab} onSelect={setTab}>
          Children
        </InspectorTabButton>
        <InspectorTabButton value="documents" active={tab} onSelect={setTab}>
          Documents
        </InspectorTabButton>
        <InspectorTabButton value="activity" active={tab} onSelect={setTab}>
          Activity
        </InspectorTabButton>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'brief' ? (
          <BriefTab
            project={project}
            workItem={workItem}
            onPatched={onWorkItemPatched}
          />
        ) : (
          <ComingSoonPane tab={tab} />
        )}
      </div>
    </div>
  );
}

function HeaderButton({
  children,
  primary,
  disabled,
  title,
  onClick,
}: {
  children: React.ReactNode;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`border px-2.5 py-1 text-[11px] uppercase tracking-[0.06em] disabled:opacity-40 ${
        primary
          ? 'border-primary text-primary hover:bg-primary/10'
          : 'border-border/40 text-muted-foreground hover:border-border hover:text-accent'
      }`}
    >
      {children}
    </button>
  );
}

function InspectorTabButton({
  value,
  active,
  onSelect,
  children,
}: {
  value: InspectorTab;
  active: InspectorTab;
  onSelect: (tab: InspectorTab) => void;
  children: React.ReactNode;
}) {
  const isActive = active === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={`inline-flex h-full items-center px-3 text-[11px] uppercase tracking-[0.08em] ${
        isActive
          ? 'text-primary'
          : 'text-muted-foreground hover:text-accent'
      }`}
      style={{
        borderBottom: `2px solid ${isActive ? 'var(--primary)' : 'transparent'}`,
      }}
    >
      {children}
    </button>
  );
}

function ComingSoonPane({ tab }: { tab: InspectorTab }) {
  const phase = tab === 'children' ? '37.9' : tab === 'documents' ? '37.11' : '37.12';
  const label =
    tab === 'children' ? 'Children' : tab === 'documents' ? 'Documents' : 'Activity';
  return (
    <div className="grid h-full place-items-center text-muted-foreground">
      <div className="text-center">
        <div className="text-[11px] uppercase tracking-[0.12em] text-[var(--fg-dim)]">
          {label} · coming in {phase}
        </div>
      </div>
    </div>
  );
}

function BriefTab({
  project,
  workItem,
  onPatched,
}: {
  project: Project;
  workItem: WorkItem;
  onPatched: (next: WorkItem) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(workItem.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync the draft when the underlying body changes (e.g. orchestrator
  // updates it while we have the inspector open).
  useEffect(() => {
    if (!editing) setDraft(workItem.body);
  }, [workItem.body, editing]);

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const next = await api.patchWorkItem(project.id, workItem.id, workItem.version, {
        body: draft,
      });
      onPatched(next);
      setEditing(false);
    } catch (e) {
      if (e instanceof WorkItemConflictError) {
        setError('This item changed elsewhere. Reloading the brief.');
        onPatched(e.current);
        setDraft(e.current.body);
        setEditing(false);
      } else {
        setError((e as Error).message);
      }
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setDraft(workItem.body);
    setEditing(false);
    setError(null);
  }

  return (
    <div className="mx-auto max-w-[820px] px-7 py-7 pb-16">
      <div className="mb-4 flex items-center justify-between border-b border-dashed border-border/30 pb-2 text-[11px] uppercase tracking-[0.06em] text-[var(--fg-dim)]">
        <span>Last updated {formatRelative(workItem.updatedAt)}</span>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="border border-border/40 px-2.5 py-0.5 text-[10px] text-muted-foreground hover:border-border hover:text-primary"
          >
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={24}
            className="w-full resize-y border border-border bg-background px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground"
            placeholder="No body yet — write what this initiative is about, the current state, decisions, links."
            autoFocus
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="border border-primary bg-primary/10 px-3 py-1 text-[11px] uppercase tracking-[0.06em] text-primary hover:bg-primary/20 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={saving}
              className="border border-border/40 px-3 py-1 text-[11px] uppercase tracking-[0.06em] text-muted-foreground hover:border-border hover:text-accent disabled:opacity-50"
            >
              Cancel
            </button>
            {error && (
              <span className="text-[11px] text-destructive">{error}</span>
            )}
          </div>
        </div>
      ) : workItem.body.trim().length > 0 ? (
        <div className="markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
            {workItem.body}
          </ReactMarkdown>
        </div>
      ) : (
        <div className="border border-dashed border-border/30 px-4 py-8 text-center text-sm text-muted-foreground">
          No brief yet. Click <span className="text-primary">Edit</span> to add one
          — overview, current state, decisions, links.
        </div>
      )}
    </div>
  );
}

function derivePhaseLabel(stage: Stage | null, wi: WorkItem): string {
  // Status-driven labels take priority for clearly-named lifecycle states.
  if (wi.status === 'blocked') return 'Blocked';
  if (wi.status === 'failed') return 'Failed';
  if (wi.status === 'complete') return 'Done';
  if (wi.status === 'archived') return 'Archived';
  // Otherwise show the stage name (e.g. "In dev", "Spec review", "Discovery").
  if (stage) return stage.name;
  // Final fallback when stage is missing.
  return wi.status === 'in-progress' ? 'In progress' : 'Pending';
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
  if (abs < hour) value = `${Math.round(abs / minute)}m ago`;
  else if (abs < day) value = `${Math.round(abs / hour)}h ago`;
  else if (abs < week) value = `${Math.round(abs / day)}d ago`;
  else value = `${Math.round(abs / week)}w ago`;
  return future ? `in ${value.replace(' ago', '')}` : value;
}
