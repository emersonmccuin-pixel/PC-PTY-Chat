// Q6 wired up to the per-project WS hook so we can see live event flow.
// Q12 vendors a fuller WS event log (filterable, scrollable, click-through
// to runs) and adds the "all projects" toggle persisted in settings_global.

import type { WsEnvelope, WsStatus } from '@/hooks/use-project-ws';

interface ActivityPanelProps {
  events: WsEnvelope[];
  status: WsStatus;
  onClose: () => void;
}

const STATUS_LABEL: Record<WsStatus, string> = {
  idle: 'idle (no project)',
  connecting: 'connecting…',
  open: 'live',
  closed: 'disconnected',
};

const STATUS_COLOR: Record<WsStatus, string> = {
  idle: 'text-muted-foreground',
  connecting: 'text-warning',
  open: 'text-success',
  closed: 'text-destructive',
};

export function ActivityPanel({ events, status, onClose }: ActivityPanelProps) {
  return (
    <div className="flex h-full flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">
          Activity
        </div>
        <button
          onClick={onClose}
          title="Hide activity panel"
          aria-label="Hide activity panel"
          className="px-1 text-xs text-muted-foreground hover:text-foreground"
        >
          ▸
        </button>
      </div>
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs">
        <span className={STATUS_COLOR[status]}>{STATUS_LABEL[status]}</span>
        <span className="text-muted-foreground">{events.length} events</span>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {events.length === 0 ? (
          <div className="text-xs text-muted-foreground">
            No events yet. Full log + filtering + click-through lands in Q12.
          </div>
        ) : (
          <ul className="space-y-1">
            {events.slice(-50).reverse().map((env, i) => (
              <li
                key={`${env.type}-${events.length - i}`}
                className="truncate text-[11px] font-mono text-muted-foreground"
                title={JSON.stringify(env)}
              >
                {env.type}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
