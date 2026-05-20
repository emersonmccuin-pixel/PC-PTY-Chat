// Abilities catalog: the source of truth for what appears in the tray, how
// each entry is rendered, and what happens when it's picked.
//
// Three "kinds":
//   - 'passthrough': send literal command text to claude.exe; no user bubble.
//   - 'nav':         switch a UI tab/rail; no claude.exe round-trip.
//   - 'panel':       open a PC-native panel (MCP details, Memory drawer, etc.).
//
// Custom commands (`.claude/commands/*.md`) come in dynamically via
// `listCustomCommands` and are merged into the catalog at tray render time.

import type { Tab } from '@/components/Tabs';
import type { RailMode } from '@/store/rail-mode';

export type AbilityCategory = 'Claude Code' | 'Navigation' | 'Project' | 'Custom';

export interface AbilityBase {
  /** Command form as the user sees it in the tray and types via `/`. */
  command: string;
  /** One-line label shown next to the command in the tray. */
  description: string;
  category: AbilityCategory;
  /** Optional comma-separated terms to widen fuzzy-search matching. */
  aliases?: string[];
}

export type Ability =
  | (AbilityBase & {
      kind: 'passthrough';
      /** Literal text sent to claude.exe. Defaults to `command`. */
      sendText?: string;
    })
  | (AbilityBase & {
      kind: 'nav';
      /** What to switch to. Center-tab and left-rail are mutually exclusive. */
      target:
        | { centerTab: Tab }
        | { rail: RailMode }
        | { appSettings: true };
    })
  | (AbilityBase & {
      kind: 'panel';
      panel: 'mcp' | 'memory' | 'agents';
    })
  | (AbilityBase & {
      kind: 'custom';
      /** Full markdown body of the custom command file. */
      body: string;
      /** Where it came from — project shadows user on collisions. */
      scope: 'project' | 'user';
    });

/** Static built-in catalog. Custom commands merged in at tray render time.
 *
 *  Pass-through commands (/help, /doctor, /loop, /schedule, /review,
 *  /security-review, /skill) intentionally OMITTED — claude.exe's CLI REPL
 *  intercepts them and writes output to its terminal (not to the JSONL we
 *  tail), so they produce a stuck "Thinking…" spinner with no visible output.
 *  See TRACKER.md "Deferred until later" for the surfacing plan. The
 *  `passthrough` ability kind + dispatcher case are kept in place so the
 *  commands can be re-added once that surface exists.
 */
export const BUILTIN_ABILITIES: Ability[] = [
  // ── PC-native navigation ─────────────────────────────────────────────
  {
    kind: 'nav',
    command: '/sessions',
    description: 'Switch left rail to Sessions',
    category: 'Navigation',
    target: { rail: 'sessions' },
  },
  {
    kind: 'nav',
    command: '/workflows',
    description: 'Switch center tab to Workflows',
    category: 'Navigation',
    target: { centerTab: 'workflows' },
  },
  {
    kind: 'nav',
    command: '/work-items',
    description: 'Switch center tab to Work items (Kanban)',
    category: 'Navigation',
    target: { centerTab: 'work-items' },
    aliases: ['/wi', 'kanban'],
  },
  {
    kind: 'nav',
    command: '/wi',
    description: 'Alias for /work-items',
    category: 'Navigation',
    target: { centerTab: 'work-items' },
    aliases: ['kanban', 'work items'],
  },
  {
    kind: 'nav',
    command: '/settings',
    description: 'Open Project Settings',
    category: 'Navigation',
    target: { centerTab: 'project-settings' },
  },
  {
    kind: 'nav',
    command: '/app-settings',
    description: 'Open App Settings',
    category: 'Navigation',
    target: { appSettings: true },
  },

  // ── PC-native panels ─────────────────────────────────────────────────
  {
    kind: 'panel',
    command: '/agents',
    description: 'Manage project agents',
    category: 'Project',
    panel: 'agents',
  },
  {
    kind: 'panel',
    command: '/memory',
    description: 'Edit CLAUDE.md (User / Project / Workspace)',
    category: 'Project',
    panel: 'memory',
  },
  {
    kind: 'panel',
    command: '/mcp',
    description: 'MCP server status + tools',
    category: 'Project',
    panel: 'mcp',
  },
];

const CATEGORY_ORDER: AbilityCategory[] = [
  'Claude Code',
  'Navigation',
  'Project',
  'Custom',
];

/** Group abilities by category in the locked tray order, alpha within each. */
export function groupByCategory(abilities: Ability[]): {
  category: AbilityCategory;
  items: Ability[];
}[] {
  const buckets = new Map<AbilityCategory, Ability[]>();
  for (const cat of CATEGORY_ORDER) buckets.set(cat, []);
  for (const a of abilities) buckets.get(a.category)?.push(a);
  return CATEGORY_ORDER.map((category) => ({
    category,
    items: (buckets.get(category) ?? []).sort((a, b) =>
      a.command.localeCompare(b.command),
    ),
  })).filter((g) => g.items.length > 0);
}

/** Fuzzy-ish filter: substring match on command + description + aliases. Case
 *  insensitive. No real fuzzy ranking yet — substring is good enough for the
 *  ~20-entry catalog and CC parity. */
export function filterAbilities(abilities: Ability[], query: string): Ability[] {
  const q = query.trim().toLowerCase();
  if (!q) return abilities;
  return abilities.filter((a) => {
    if (a.command.toLowerCase().includes(q)) return true;
    if (a.description.toLowerCase().includes(q)) return true;
    if (a.aliases?.some((al) => al.toLowerCase().includes(q))) return true;
    return false;
  });
}

/** `$ARGUMENTS` substitution for custom commands (CC parity). If the user's
 *  invocation included extra text after the command name in the composer, that
 *  text replaces `$ARGUMENTS` in the body. */
export function substituteArguments(body: string, argText: string): string {
  return body.replace(/\$ARGUMENTS/g, argText);
}
