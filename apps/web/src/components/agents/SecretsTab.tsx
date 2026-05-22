// Section 17d.6 — Secrets tab. Placeholder shell until the real
// implementation lands.

import type { PodBundle, ULID } from '@/api/client';

interface SecretsTabProps {
  podId: ULID;
  bundle: PodBundle | null;
  loading: boolean;
  error: string | null;
  onChanged: () => void;
}

export function SecretsTab({ bundle, loading, error }: SecretsTabProps) {
  if (loading) return <div className="text-xs text-muted-foreground">Loading…</div>;
  if (error) return <div className="text-xs text-destructive">{error}</div>;
  if (!bundle) return null;
  return (
    <div className="text-xs text-muted-foreground">
      Secrets ({bundle.secrets.length}). Plaintext-warning + editor land in 17d.6.
    </div>
  );
}
