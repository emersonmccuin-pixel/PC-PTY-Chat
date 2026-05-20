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
  // Folder tabs — equal-width, centered text, rounded top corners, soft gold
  // for active. Inline styles because the Vellum theme zeroes every Tailwind
  // `rounded-*` utility (line 64-70 of index.css) so border-radius via class
  // doesn't render. Inline styles bypass that.
  const baseStyle: React.CSSProperties = {
    padding: '8px 16px',
    fontSize: 13,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    textAlign: 'center',
    transition: 'background 140ms, color 140ms',
    borderRadius: '8px 8px 0 0',
    borderStyle: 'solid',
    borderWidth: '1px 1px 0 1px',
  };
  // Match the YOU chat-bubble: bg-primary/30 + border-primary/60. Inactive
  // tabs reuse the same primary color at ~25% of the active intensity so
  // they read as the same "family" but visually subordinate.
  const activeStyle: React.CSSProperties = {
    background: 'rgba(240, 208, 128, 0.30)',
    color: '#f0e4c4',
    fontWeight: 600,
    borderColor: 'rgba(240, 208, 128, 0.60)',
    marginBottom: -1,
  };
  const inactiveStyle: React.CSSProperties = {
    background: 'rgba(240, 208, 128, 0.075)',
    color: '#9a8e7a',
    borderColor: 'rgba(240, 208, 128, 0.15)',
  };
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 4,
        padding: '8px 16px 0',
        background: '#100c08',
        borderBottom: '1px solid rgba(240, 208, 128, 0.22)',
      }}
    >
      {TABS.map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          style={{
            ...baseStyle,
            flex: 1,
            ...(value === t ? activeStyle : inactiveStyle),
          }}
        >
          {LABEL[t]}
        </button>
      ))}
      <button
        onClick={() => onChange('project-settings')}
        title="Project settings"
        aria-label="Project settings"
        style={{
          ...baseStyle,
          padding: '8px 12px',
          fontSize: 14,
          marginLeft: 4,
          ...(value === 'project-settings' ? activeStyle : inactiveStyle),
        }}
      >
        ⚙
      </button>
    </div>
  );
}
