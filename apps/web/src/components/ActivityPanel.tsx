// Q3 stub. Q12 vendors the WS event log scoped to active project (or all
// projects when toggled), with persistence in settings_global.activity_panel.

interface ActivityPanelProps {
  onClose: () => void;
}

export function ActivityPanel({ onClose }: ActivityPanelProps) {
  return (
    <div className="flex h-full flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">Activity</div>
        <button
          onClick={onClose}
          title="Hide activity panel"
          aria-label="Hide activity panel"
          className="px-1 text-xs text-muted-foreground hover:text-foreground"
        >
          ▸
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-4 text-xs text-muted-foreground">
        Live event log lands in Q12.
      </div>
    </div>
  );
}
