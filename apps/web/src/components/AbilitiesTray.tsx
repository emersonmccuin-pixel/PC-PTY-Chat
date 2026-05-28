// Abilities tray. Pops up above the composer when the ⚡ Abilities button is
// clicked or `/` is pressed on an empty composer. Inline-categorized layout
// per the locked spec: Claude Code / Navigation / Project / Custom, alpha
// within each, single fuzzy-search bar at top.

import { useEffect, useMemo, useRef, useState } from 'react';

import { projectContextApi, type CustomCommand } from '@/features/project-context/client';
import type { Ability } from '@/lib/abilities';
import {
  BUILTIN_ABILITIES,
  filterAbilities,
  groupByCategory,
} from '@/lib/abilities';

interface AbilitiesTrayProps {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onPick: (ability: Ability) => void;
  /** Seed query — used when `/` is typed and we want the slash itself to NOT
   *  appear in the search field, but later keystrokes filter. */
  initialQuery?: string;
}

export function AbilitiesTray({
  projectId,
  open,
  onClose,
  onPick,
  initialQuery = '',
}: AbilitiesTrayProps) {
  const [query, setQuery] = useState(initialQuery);
  const [customs, setCustoms] = useState<CustomCommand[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Refresh custom commands every time the tray opens — cheap and keeps the
  // list live without polling.
  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    setSelectedIdx(0);
    projectContextApi.listCustomCommands(projectId)
      .then(setCustoms)
      .catch(() => setCustoms([]));
    // Focus the search box on open so typing flows naturally.
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [open, projectId, initialQuery]);

  // Click-outside closes.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      onClose();
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open, onClose]);

  const allAbilities = useMemo<Ability[]>(() => {
    const customAsAbility: Ability[] = customs.map((c) => ({
      kind: 'custom' as const,
      command: `/${c.name}`,
      description:
        c.scope === 'project'
          ? 'Project custom command'
          : 'User-global custom command',
      category: 'Custom' as const,
      body: c.body,
      scope: c.scope,
    }));
    return [...BUILTIN_ABILITIES, ...customAsAbility];
  }, [customs]);

  const filtered = useMemo(
    () => filterAbilities(allAbilities, query),
    [allAbilities, query],
  );
  const groups = useMemo(() => groupByCategory(filtered), [filtered]);

  // Flat order for arrow-key navigation (matches visual top-to-bottom).
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => {
    if (selectedIdx >= flat.length) setSelectedIdx(Math.max(0, flat.length - 1));
  }, [flat.length, selectedIdx]);

  if (!open) return null;

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(flat.length - 1, i + 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const picked = flat[selectedIdx];
      if (picked) onPick(picked);
      return;
    }
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Abilities"
      onKeyDown={handleKeyDown}
      className="absolute bottom-full left-0 right-0 mb-1 max-h-[60vh] overflow-y-auto border border-border bg-card shadow-lg"
    >
      <div className="sticky top-0 border-b border-border bg-card px-3 py-2">
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search abilities…"
          className="w-full border border-border bg-background px-2 py-1 text-sm focus:border-primary focus:outline-none"
        />
      </div>
      {flat.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          No abilities match "{query}".
        </div>
      ) : (
        <div className="px-2 py-2">
          {groups.map((group) => (
            <div key={group.category} className="mb-2">
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                — {group.category} —
              </div>
              <ul className="space-y-0.5">
                {group.items.map((ability) => {
                  const idx = flat.indexOf(ability);
                  const selected = idx === selectedIdx;
                  return (
                    <li key={ability.command}>
                      <button
                        type="button"
                        onMouseEnter={() => setSelectedIdx(idx)}
                        onClick={() => onPick(ability)}
                        className={`flex w-full items-center justify-between gap-3 rounded px-2 py-1 text-left text-xs ${
                          selected
                            ? 'bg-primary/20 text-foreground'
                            : 'hover:bg-muted text-foreground/90'
                        }`}
                      >
                        <span className="font-mono">{ability.command}</span>
                        <span className="truncate text-muted-foreground">
                          {ability.description}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
