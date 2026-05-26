// Section 37.1 — placeholder for the Dashboard sub-tab. Real implementation
// arrives in 37.3 (Initiatives region) + 37.4 (Needs You region), both of
// which need a server-side initiative-selection endpoint that lives in 37.2.
// 37.2 is a high-collision phase parked until the Section 19 cull lands.

export function DashboardPlaceholder() {
  return (
    <div className="grid h-full place-items-center bg-background text-muted-foreground">
      <div className="flex max-w-md flex-col items-center gap-3 px-6 text-center">
        <div className="text-xs uppercase tracking-[0.12em] text-[var(--fg-dim)]">
          Dashboard · coming soon
        </div>
        <p className="text-sm leading-relaxed">
          Initiatives in flight + what needs your attention.
          Use the <span className="text-primary">Kanban</span> or{' '}
          <span className="text-primary">Table</span> tab for now.
        </p>
      </div>
    </div>
  );
}
