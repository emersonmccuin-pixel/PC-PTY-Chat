import type { ULID } from '@/features/projects/types';

export interface ActivityPanelSettings {
  open: boolean;
  showAllProjects: boolean;
}

export type OrchestratorSurfacePreference = 'chat' | 'terminal';

export interface GlobalSettings {
  dataDir: string;
  telemetryOptIn: boolean;
  claudeConfigDir: string | null;
  defaultOrchestratorSurface: OrchestratorSurfacePreference;
  projectsFolder: string;
  activityPanel: ActivityPanelSettings;
  bugLogTargetProjectId: ULID | null;
  fontScale: number;
  hideCancelledStage: boolean;
  onboardingCompletedAt: string | null;
}

export const FONT_SCALE_MIN = 0.85;
export const FONT_SCALE_MAX = 1.5;
export const FONT_SCALE_STEP = 0.05;

export interface ClaudePreflight {
  status: 'ok' | 'not-found' | 'version-too-old' | 'unverified';
  path: string | null;
  source: string;
  version: string | null;
  minVersion: string;
}

export interface DependencyProbe {
  name: string;
  present: boolean;
  version: string | null;
  severity: 'hard' | 'soft';
  note?: string;
}

export interface PreflightReport {
  claude: ClaudePreflight;
  auth: { status: 'unknown' | 'authed' | 'login-required'; note: string };
  git: DependencyProbe;
  soft: DependencyProbe[];
  ok: boolean;
}

export interface OnboardingLoginState {
  running: boolean;
  url: string | null;
  exited: boolean;
  exitCode: number | null;
  tail: string;
}
