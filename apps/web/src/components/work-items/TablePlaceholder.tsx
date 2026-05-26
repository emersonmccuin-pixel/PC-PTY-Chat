// Section 37.1 — placeholder for the Table sub-tab. Real implementation in
// 37.7 (after the shared toolbar lands in 37.5).

export function TablePlaceholder() {
  return (
    <div className="grid h-full place-items-center bg-background text-muted-foreground">
      <div className="flex max-w-md flex-col items-center gap-3 px-6 text-center">
        <div className="text-xs uppercase tracking-[0.12em] text-[var(--fg-dim)]">
          Table · coming soon
        </div>
        <p className="text-sm leading-relaxed">
          Sortable + searchable flat-list view of every work item in this project.
        </p>
      </div>
    </div>
  );
}
