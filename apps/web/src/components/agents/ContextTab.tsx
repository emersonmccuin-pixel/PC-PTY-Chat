// Section 17d.5 — Context (knowledge) tab. Placeholder shell until the
// real implementation lands.

import type { PodBundle, ULID } from '@/api/client';

interface ContextTabProps {
  podId: ULID;
  bundle: PodBundle | null;
  loading: boolean;
  error: string | null;
  onChanged: () => void;
}

export function ContextTab({ bundle, loading, error }: ContextTabProps) {
  if (loading) return <div className="text-xs text-muted-foreground">Loading…</div>;
  if (error) return <div className="text-xs text-destructive">{error}</div>;
  if (!bundle) return null;
  return (
    <div className="text-xs text-muted-foreground">
      Knowledge docs ({bundle.knowledge.length}). Editor lands in 17d.5.
    </div>
  );
}
