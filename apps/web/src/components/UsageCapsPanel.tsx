// Section 31.7 — 5h-above-7d usage caps pinned to the bottom of the left rail.
//
// Snapshot source: `useStatuslineStore` (populated by CC's statusLine.command
// hook). The 5h + 7d percentages are account-wide; the visible bar tracks
// `used_percentage` 0-100 (rendered 0-100% but data may exceed 100 in overage
// mode — clamp the bar fill, surface the raw % in the label).
//
// Empty-state: until the first statusline snapshot arrives we show neutral
// "—" placeholders rather than collapsing the section, so the user knows
// the data path exists and is waiting for the next CC turn to populate it.

import { useEffect, useState } from 'react';

import type { StatuslineRateLimit, StatuslineSnapshot } from '@/store/statusline';

interface UsageCapsPanelProps {
  snapshot: StatuslineSnapshot | null;
}

function formatResetIn(resetsAt: string | undefined | null, now: number): string {
  if (!resetsAt) return '—';
  let t = Date.parse(resetsAt);
  if (!Number.isFinite(t)) {
    // Fallback: producer may have sent epoch-seconds as a numeric string.
    const secs = Number(resetsAt);
    if (Number.isFinite(secs) && secs > 1_000_000_000) t = secs * 1_000;
    else return '—';
  }
  const ms = t - now;
  if (ms <= 0) return 'resetting…';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH === 0 ? `${days}d` : `${days}d ${remH}h`;
}

function CapBar({ label, limit, now }: { label: string; limit: StatuslineRateLimit | null; now: number }) {
  const hasData = limit !== null;
  const pct = hasData ? Math.max(0, limit.usedPercentage) : 0;
  const fill = Math.min(100, pct);
  const tone =
    pct >= 90 ? 'bg-destructive' : pct >= 75 ? 'bg-warning' : 'bg-primary';
  const resetIn = formatResetIn(limit?.resetsAt, now);
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>{label}</span>
        <span className="text-foreground/70">{hasData ? `${pct.toFixed(0)}%` : '—'}</span>
      </div>
      <div className="relative h-1.5 w-full overflow-hidden bg-muted">
        <div
          className={`absolute inset-y-0 left-0 ${tone}`}
          style={{ width: `${fill}%` }}
        />
      </div>
      <div className="text-[10px] text-muted-foreground/80">
        {hasData ? `resets in ${resetIn}` : '—'}
      </div>
    </div>
  );
}

export function UsageCapsPanel({ snapshot }: UsageCapsPanelProps) {
  // Tick once a minute so the "resets in" string stays live without spamming
  // re-renders. 60s granularity matches the human-meaningful unit we display.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const five = snapshot?.rateLimits.fiveHour ?? null;
  const seven = snapshot?.rateLimits.sevenDay ?? null;

  return (
    <div className="border-t border-border bg-card/60 px-3 py-2">
      <div className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        Usage
      </div>
      <div className="flex flex-col gap-2">
        <CapBar label="5h" limit={five} now={now} />
        <CapBar label="7d" limit={seven} now={now} />
      </div>
    </div>
  );
}
