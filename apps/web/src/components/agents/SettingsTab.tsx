// Section 17d.7 — Settings tab. Placeholder shell until the real
// implementation lands (model / effort / maxTurns / tools / output_destination
// + MCP servers subsection).

import type { PodBundle, ULID } from '@/api/client';

interface SettingsTabProps {
  podId: ULID;
  draft: {
    model: string;
    effort: string;
    maxTurns: string;
    tools: string;
    outputDestination: string;
  };
  bundle: PodBundle | null;
  bundleLoading: boolean;
  bundleErr: string | null;
  onDraftChange: (
    patch: Partial<{
      model: string;
      effort: string;
      maxTurns: string;
      tools: string;
      outputDestination: string;
    }>,
  ) => void;
  onBundleChanged: () => void;
}

export function SettingsTab({ draft, bundle, bundleLoading }: SettingsTabProps) {
  return (
    <div className="text-xs text-muted-foreground">
      <p>
        Model: <span className="font-mono">{draft.model || '(default)'}</span> ·
        Effort: <span className="font-mono">{draft.effort || '(default)'}</span> ·
        Max turns: <span className="font-mono">{draft.maxTurns || '(no cap)'}</span>
      </p>
      <p className="mt-1">Tools: <span className="font-mono">{draft.tools || '(inherit)'}</span></p>
      <p className="mt-1">
        Output destination:{' '}
        <span className="font-mono">{draft.outputDestination || '(default)'}</span>
      </p>
      <p className="mt-1">
        MCP servers:{' '}
        {bundleLoading ? 'loading…' : bundle ? bundle.mcpServers.length : 0}
      </p>
      <p className="mt-3 italic">
        Editable form + MCP servers subsection land in 17d.7.
      </p>
    </div>
  );
}
