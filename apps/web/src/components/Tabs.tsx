// Vendored from emersonmccuin-pixel/project-companion @ 6053ad6 (MIT)
// Source: apps/web/src/components/Tabs.tsx
// Adapted for Project Companion: dropped the legacy-tab normalizer (no v1
// installations to migrate from in the rig).

export const TABS = ['orchestrator', 'work-items', 'workflows', 'files'] as const;
/** `project-settings` is reachable via the right-aligned gear, not the main strip. */
export type Tab = (typeof TABS)[number] | 'project-settings';

const LABEL: Record<(typeof TABS)[number], string> = {
  orchestrator: 'Orchestrator',
  'work-items': 'Work items',
  workflows: 'Workflows',
  files: 'Files',
};

export function TabBar({
  value,
  onChange,
}: {
  value: Tab;
  onChange: (t: Tab) => void;
}) {
  // BOLD folder-tab style. Dark vellum palette swallows subtle borders, so the
  // active tab uses a full primary-tinted background + 2px gold border on three
  // sides. `-mb-px` overlaps the strip's border-b so the tab visually merges
  // into the content panel below.
  const tabBase =
    'rounded-t-md px-4 py-2 text-sm uppercase tracking-wider transition-colors border-2 border-b-0';
  const activeTab =
    '-mb-px border-primary bg-primary/20 text-primary font-bold';
  const inactiveTab =
    'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground';
  return (
    <div className="flex items-end gap-1 border-b border-border bg-card px-4 pt-2">
      {TABS.map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={`${tabBase} ${value === t ? activeTab : inactiveTab}`}
        >
          {LABEL[t]}
        </button>
      ))}
      <div className="ml-auto">
        <button
          onClick={() => onChange('project-settings')}
          title="Project settings"
          aria-label="Project settings"
          className={
            `rounded-t-md border-2 border-b-0 px-3 py-2 text-sm transition-colors ` +
            (value === 'project-settings'
              ? '-mb-px border-primary bg-primary/20 text-primary'
              : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground')
          }
        >
          ⚙
        </button>
      </div>
    </div>
  );
}
