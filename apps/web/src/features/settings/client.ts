import { getJson, postJson, postJsonMethod } from '@/api/http';
import type { ULID } from '@/features/projects/client';

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

export const settingsApi = {
  getSettings: () =>
    getJson<{ ok: true; settings: GlobalSettings }>('/api/settings').then((r) => r.settings),

  getPreflight: () =>
    getJson<{ ok: true; preflight: PreflightReport }>('/api/preflight').then((r) => r.preflight),

  installClaude: () =>
    postJson<{ ok: true; preflight: PreflightReport; log: string }>(
      '/api/onboarding/install/claude',
      {},
    ),

  installGit: () =>
    postJson<{ ok: true; preflight: PreflightReport; log: string }>(
      '/api/onboarding/install/git',
      {},
    ),

  startOnboardingLogin: () =>
    postJson<{ ok: true; login: OnboardingLoginState }>('/api/onboarding/auth/login', {}),

  getOnboardingAuthState: () =>
    getJson<{ ok: true; login: OnboardingLoginState; authed: boolean }>(
      '/api/onboarding/auth/state',
    ),

  cancelOnboardingLogin: () =>
    postJson<{ ok: true }>('/api/onboarding/auth/cancel', {}),

  getMcpStatus: (projectId?: string) =>
    getJson<{ alive: boolean; toolCount: number; tools: string[] }>(
      projectId
        ? `/api/mcp-status?projectId=${encodeURIComponent(projectId)}`
        : '/api/mcp-status',
    ),

  patchSettings: (patch: Partial<GlobalSettings>) =>
    postJsonMethod<{ ok: true; settings: GlobalSettings; restartRequired: boolean }>(
      '/api/settings',
      patch,
      'PATCH',
    ),

  getClaudeProfile: () =>
    getJson<{
      ok: true;
      override: string | null;
      effective: string;
      source: 'override' | 'shell' | 'default';
    }>('/api/settings/claude-profile'),
};
