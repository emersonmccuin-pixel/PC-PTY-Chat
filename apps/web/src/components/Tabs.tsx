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
  return (
    <div className="flex items-center border-b border-border bg-card px-4">
      {TABS.map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={
            'px-3 py-2 text-sm border-b-2 -mb-px uppercase tracking-wider ' +
            (value === t
              ? 'border-primary text-primary font-medium'
              : 'border-transparent text-muted-foreground hover:text-foreground')
          }
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
            'px-2 py-1 text-sm border-b-2 -mb-px ' +
            (value === 'project-settings'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground')
          }
        >
          ⚙
        </button>
      </div>
    </div>
  );
}
