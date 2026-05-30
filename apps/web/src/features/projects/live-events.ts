import { isProjectChangedRefetchEnvelope } from '@pc/contracts';

import type { WsEnvelope } from '../runtime/ws-types';

export function shouldAcceptProjectWsEnvelope(
  env: unknown,
  projectId: string,
): env is WsEnvelope {
  if (!env || typeof env !== 'object') return false;
  if (isProjectChangedRefetchEnvelope(env)) return true;
  return (env as { projectId?: unknown }).projectId === projectId;
}

export function containsProjectChangedRefetchEvent(
  events: readonly unknown[],
  startIndex: number,
): boolean {
  const start = Math.max(0, Math.min(startIndex, events.length));
  for (let i = start; i < events.length; i++) {
    if (isProjectChangedRefetchEnvelope(events[i])) return true;
  }
  return false;
}

export function projectWsTargetIds(
  projects: readonly { id: string }[],
  excludeProjectId: string | null,
  enabled: boolean,
): string[] {
  if (!enabled) return [];
  return projects
    .map((p) => p.id)
    .filter((id) => id !== excludeProjectId)
    .sort();
}

export function projectWsTargetKeyFromIds(targetIds: readonly string[]): string {
  return targetIds.join(',');
}

export function projectWsTargetIdsFromKey(targetKey: string): string[] {
  return targetKey ? targetKey.split(',') : [];
}

export { isProjectChangedRefetchEnvelope };
