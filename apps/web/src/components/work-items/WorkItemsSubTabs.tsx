// Section 37.1 — sub-tab strip above the Work Items page. Three values:
// Dashboard (default) · Kanban · Table. Visual matches the existing app-level
// TabBar shape (underline-active, lowercase, monospace) but lives one level
// deeper inside the Work Items tab.

import { useWorkItemsView, type WorkItemsSubTab } from '@/store/work-items-view';

const ORDER: readonly WorkItemsSubTab[] = ['dashboard', 'kanban', 'table'] as const;
const LABEL: Record<WorkItemsSubTab, string> = {
  dashboard: 'Dashboard',
  kanban: 'Kanban',
  table: 'Table',
};

export function WorkItemsSubTabs() {
  const value = useWorkItemsView((s) => s.activeSubTab);
  const setValue = useWorkItemsView((s) => s.setActiveSubTab);
  return (
    <div
      className="flex items-stretch gap-1 border-b border-border/30 bg-[var(--surface-1)] px-5"
      style={{ height: 36 }}
    >
      {ORDER.map((t) => {
        const active = value === t;
        return (
          <button
            key={t}
            type="button"
            onClick={() => setValue(t)}
            className={`inline-flex items-center px-3.5 text-[11px] uppercase tracking-[0.08em] transition-colors ${
              active
                ? 'text-primary'
                : 'text-muted-foreground hover:text-accent'
            }`}
            style={{
              borderBottom: `2px solid ${active ? 'var(--primary)' : 'transparent'}`,
            }}
            aria-pressed={active}
          >
            {LABEL[t]}
          </button>
        );
      })}
    </div>
  );
}
