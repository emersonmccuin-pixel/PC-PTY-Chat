// Section 2c — stub shell for the work-item detail modal.
//
// Tabs are stubbed; 2d (Overview) / 2e (Children) / 2f (Attachments) / 2i
// (Activity) fill them in. The shell already wires backdrop + Esc close so the
// card's click-to-open lands somewhere user-visible from this phase.

import { useEffect, useState } from 'react';

import type { WorkItem } from '@/api/client';

type TabId = 'overview' | 'children' | 'attachments' | 'activity';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'children', label: 'Children' },
  { id: 'attachments', label: 'Attachments' },
  { id: 'activity', label: 'Activity' },
];

interface WorkItemDetailModalProps {
  workItem: WorkItem;
  onClose: () => void;
}

export function WorkItemDetailModal({ workItem, onClose }: WorkItemDetailModalProps) {
  const [tab, setTab] = useState<TabId>('overview');

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col border border-border bg-card text-foreground"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-base font-semibold">{workItem.title}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              v{workItem.version} · {workItem.status}
            </p>
          </div>
          <button
            onClick={onClose}
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
                'border-b-2 px-3 py-1.5 text-sm transition-colors ' +
                (tab === t.id
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground')
              }
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="min-h-[12rem] flex-1 overflow-y-auto px-4 py-3 text-sm text-muted-foreground">
          {tab === 'overview' && (
            <StubPanel
              label="Overview"
              note="Title, stage, parent breadcrumb, body, and typed fields land in phase 2d."
              workItem={workItem}
            />
          )}
          {tab === 'children' && (
            <StubPanel
              label="Children"
              note="Child list + “+ New child” form lands in phase 2e."
            />
          )}
          {tab === 'attachments' && (
            <StubPanel
              label="Attachments"
              note="Attachment rows + expand-on-click rendering land in phase 2f."
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
          <button
            onClick={onClose}
            className="border border-border bg-background px-3 py-1 text-sm hover:bg-muted"
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

function StubPanel({
  label,
  note,
  workItem,
}: {
  label: string;
  note: string;
  workItem?: WorkItem;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs uppercase tracking-wider text-foreground">{label}</div>
      <p>{note}</p>
      {workItem && (
        <pre className="mt-2 max-h-64 overflow-auto border border-border bg-background p-2 font-mono text-[11px] leading-snug text-foreground">
{JSON.stringify(workItem, null, 2)}
        </pre>
      )}
    </div>
  );
}
