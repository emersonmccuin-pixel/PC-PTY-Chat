// Section 17d.8 — History tab. Placeholder shell until the real
// implementation lands (audit-log list, change-set grouping, per-row revert).

import { useEffect, useState } from 'react';

import { api, type PodAuditEntry, type ULID } from '@/api/client';

interface HistoryTabProps {
  podId: ULID;
}

export function HistoryTab({ podId }: HistoryTabProps) {
  const [rows, setRows] = useState<PodAuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    api
      .listPodAudit(podId, { limit: 50 })
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [podId]);

  if (error) return <div className="text-xs text-destructive">{error}</div>;
  if (rows === null) return <div className="text-xs text-muted-foreground">Loading…</div>;
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      <p className="italic">Filters + diff display + revert land in 17d.8.</p>
      {rows.map((r) => (
        <div key={r.id} className="border border-border bg-card px-2 py-1">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider">
            <span>{r.actor}</span>
            <span>·</span>
            <span>{r.field}</span>
            {r.fieldRef && (
              <>
                <span>·</span>
                <span className="font-mono">{r.fieldRef}</span>
              </>
            )}
            <span className="ml-auto">{new Date(r.createdAt).toLocaleString()}</span>
          </div>
          {r.reason && <div className="mt-0.5 text-[11px]">{r.reason}</div>}
        </div>
      ))}
    </div>
  );
}
