// GlobalSettings — app-level singleton (one row, id='global').

import type { ULID } from './ulid.ts';

export interface ActivityPanelSettings {
  /** User's last persisted open/closed state for the right-rail activity panel. */
  open: boolean;
  /**
   * If true, ActivityPanel subscribes to every project's WS feed (Q12), not
   * just the active one. Defaults false — single-project scope is the
   * cheaper default.
   */
  showAllProjects: boolean;
}

/** Section 18.6 — dispatch-side controls for `pc_invoke_agent`. */
export interface AgentDispatchSettings {
  /**
   * Async-dispatch ack window. `pc_invoke_agent` (wait: false) blocks until
   * the spawned agent emits its first non-system JSONL event OR this timer
   * fires. Default 30s — gut-feel for spawn + CC boot + dev-channels
   * confirmation + initial prompt read.
   */
  ackTimeoutMs: number;
}

export const AGENT_ACK_TIMEOUT_MS_MIN = 1_000;
export const AGENT_ACK_TIMEOUT_MS_MAX = 5 * 60 * 1000;

export interface GlobalSettings {
  /** Active data dir at last write. */
  dataDir: string;
  /** Telemetry opt-in. Default false. */
  telemetryOptIn: boolean;
  /**
   * Default parent dir for new projects. Used by the create-project folder
   * picker as the initial path. Hot-reloadable — no restart required.
   */
  projectsFolder: string;
  /** Activity-panel UI preferences. */
  activityPanel: ActivityPanelSettings;
  /**
   * Target project id for the `pc_log_bug` MCP tool. When set, Log Bug calls
   * from any project's orchestrator file a bug card here with type='bug'.
   * Null = Log Bug returns a configuration error.
   */
  bugLogTargetProjectId: ULID | null;
  /**
   * Multiplier for the html root font size — every rem-based UI size scales
   * with this. Slider in App Settings clamps the value to [0.85, 1.5].
   * Default 1.0 = no change.
   */
  fontScale: number;
  /** Section 18.6 — dispatch-side controls for `pc_invoke_agent`. */
  agentDispatch: AgentDispatchSettings;
}

export const FONT_SCALE_MIN = 0.85;
export const FONT_SCALE_MAX = 1.5;

/** Defaults for a fresh settings_global row. The DB seeder calls this with
 *  the launch-time data dir and home dir so domain stays I/O-free. */
export function defaultGlobalSettings(dataDir: string, homeDir: string): GlobalSettings {
  return {
    dataDir,
    telemetryOptIn: false,
    projectsFolder: joinPath(homeDir, 'Projects'),
    activityPanel: {
      open: true,
      showAllProjects: false,
    },
    bugLogTargetProjectId: null,
    fontScale: 1,
    agentDispatch: {
      ackTimeoutMs: 30_000,
    },
  };
}

export function clampFontScale(n: number): number {
  if (!Number.isFinite(n)) return 1;
  if (n < FONT_SCALE_MIN) return FONT_SCALE_MIN;
  if (n > FONT_SCALE_MAX) return FONT_SCALE_MAX;
  return Math.round(n * 100) / 100;
}

/** Clamp `ackTimeoutMs` to [1s, 5min]. Default 30s on non-finite / out-of-band. */
export function clampAckTimeoutMs(n: number): number {
  if (!Number.isFinite(n)) return 30_000;
  if (n < AGENT_ACK_TIMEOUT_MS_MIN) return AGENT_ACK_TIMEOUT_MS_MIN;
  if (n > AGENT_ACK_TIMEOUT_MS_MAX) return AGENT_ACK_TIMEOUT_MS_MAX;
  return Math.floor(n);
}

/**
 * Backfill any fields a stored envelope is missing — old `settings_global`
 * rows predate the Q10 envelope. Mutates a shallow copy so the row at rest
 * stays untouched until the next PATCH.
 */
export function withSettingsDefaults(
  stored: Partial<GlobalSettings>,
  dataDir: string,
  homeDir: string,
): GlobalSettings {
  const defaults = defaultGlobalSettings(dataDir, homeDir);
  return {
    dataDir: stored.dataDir ?? defaults.dataDir,
    telemetryOptIn: stored.telemetryOptIn ?? defaults.telemetryOptIn,
    projectsFolder: stored.projectsFolder ?? defaults.projectsFolder,
    activityPanel: {
      open: stored.activityPanel?.open ?? defaults.activityPanel.open,
      showAllProjects:
        stored.activityPanel?.showAllProjects ?? defaults.activityPanel.showAllProjects,
    },
    bugLogTargetProjectId: stored.bugLogTargetProjectId ?? defaults.bugLogTargetProjectId,
    fontScale: clampFontScale(stored.fontScale ?? defaults.fontScale),
    agentDispatch: {
      ackTimeoutMs: clampAckTimeoutMs(
        stored.agentDispatch?.ackTimeoutMs ?? defaults.agentDispatch.ackTimeoutMs,
      ),
    },
  };
}

function joinPath(a: string, b: string): string {
  if (!a) return b;
  const trimmed = a.replace(/[\\/]+$/, '');
  const sep = trimmed.includes('\\') ? '\\' : '/';
  return `${trimmed}${sep}${b}`;
}
