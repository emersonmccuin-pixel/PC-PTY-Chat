// Section 6 — Activity panel. Five-region layout, per-project scoped:
//   1. Status line (sticky top)
//   2. Running workflows
//   3. Orchestrator status (always-visible card)
//   4. Workflow human-review inbox
//   5. Failed recently (collapsed, 7-day window)
//
// Sub-task 6.1 lays down the shell with empty-state placeholders for each
// region. Individual regions are wired in 6.2 → 6.6. Today's flat WS event
// log is dropped from this surface — events.jsonl on disk + the WS stream
// preserve the data; Section 8 (Diagnostics tab) will re-derive when it
// opens.

import type { Project } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';

interface ActivityPanelProps {
  project: Project | null;
  events: WsEnvelope[];
  onClose: () => void;
}

export function ActivityPanel({ project, events, onClose }: ActivityPanelProps) {
  return (
    <div className="flex h-full flex-col border-l border-border bg-card">
      <Header onClose={onClose} />
      {project === null ? (
        <div className="flex-1 px-3 py-2 text-xs text-muted-foreground">
          No project selected.
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden">
          <StatusLine />
          <div className="flex-1 overflow-y-auto">
            <RunningWorkflowsRegion project={project} />
            <OrchestratorStatusRegion project={project} events={events} />
            <HumanReviewRegion project={project} />
            <FailedRecentlyRegion project={project} />
          </div>
        </div>
      )}
    </div>
  );
}

function Header({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex items-center justify-between border-b border-border px-3 py-2">
      <div className="text-sm uppercase tracking-wider text-muted-foreground">
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
  );
}

function StatusLine() {
  // 6.2 — derived from region counts. Stub: zero state until wired.
  return (
    <div className="border-b border-border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">
      0 running · 0 waiting · 0 failed today
    </div>
  );
}

function RegionShell({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-border">
      <div className="flex items-center justify-between px-3 py-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </div>
        {badge !== undefined && (
          <div className="bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
            {badge}
          </div>
        )}
      </div>
      <div>{children}</div>
    </section>
  );
}

function EmptyRegion({ text }: { text: string }) {
  return <div className="px-3 pb-2 text-[11px] italic text-muted-foreground/70">{text}</div>;
}

function RunningWorkflowsRegion({ project: _project }: { project: Project }) {
  // 6.3 wires this region.
  return (
    <RegionShell title="Running workflows" badge="0">
      <EmptyRegion text="No workflows running." />
    </RegionShell>
  );
}

function OrchestratorStatusRegion({
  project: _project,
  events: _events,
}: {
  project: Project;
  events: WsEnvelope[];
}) {
  // 6.4 wires this region.
  return (
    <RegionShell title="Orchestrator">
      <div className="px-3 pb-2 text-[11px] text-muted-foreground/70 italic">Idle</div>
    </RegionShell>
  );
}

function HumanReviewRegion({ project: _project }: { project: Project }) {
  // 6.5 wires this region.
  return (
    <RegionShell title="Waiting on you" badge="0">
      <EmptyRegion text="Nothing waiting for your input." />
    </RegionShell>
  );
}

function FailedRecentlyRegion({ project: _project }: { project: Project }) {
  // 6.6 wires this region. Collapsed by default.
  return (
    <RegionShell title="Failed recently" badge="0">
      <EmptyRegion text="No failures in the last 7 days." />
    </RegionShell>
  );
}
