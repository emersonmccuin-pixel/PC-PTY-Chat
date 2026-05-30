import {
  isProjectChangedLiveEvent,
  isProjectChangedLiveEventFrame,
  isProjectChangedRefetchEnvelope,
  type ProjectChangedLiveEvent,
} from '@pc/contracts';

import type { WsEnvelope } from '../runtime/ws-types';

export interface ProjectChangedScanResult {
  shouldRefetch: boolean;
  latestCursor: string | null;
}

export function shouldAcceptProjectWsEnvelope(
  env: unknown,
  projectId: string,
): env is WsEnvelope {
  if (!env || typeof env !== 'object') return false;
  if (isProjectChangedRefetchEnvelope(env)) return true;
  if (isProjectChangedLiveEventFrame(env)) return true;
  return (env as { projectId?: unknown }).projectId === projectId;
}

export function containsProjectChangedRefetchEvent(
  events: readonly unknown[],
  startIndex: number,
): boolean {
  return scanProjectChangedEvents(events, startIndex).shouldRefetch;
}

export function scanProjectChangedEvents(
  events: readonly unknown[],
  startIndex: number,
  seenLiveEventIds: Set<string> = new Set(),
): ProjectChangedScanResult {
  const start = Math.max(0, Math.min(startIndex, events.length));
  let shouldRefetch = false;
  let latestCursor: string | null = null;
  for (let i = start; i < events.length; i++) {
    if (isProjectChangedRefetchEnvelope(events[i])) {
      shouldRefetch = true;
      continue;
    }
    const liveEvent = projectChangedLiveEventFromUnknown(events[i]);
    if (!liveEvent) continue;
    latestCursor = liveEvent.cursor;
    if (seenLiveEventIds.has(liveEvent.id)) continue;
    seenLiveEventIds.add(liveEvent.id);
    shouldRefetch = true;
  }
  return { shouldRefetch, latestCursor };
}

export function projectChangedLiveEventFromUnknown(value: unknown): ProjectChangedLiveEvent | null {
  if (isProjectChangedLiveEvent(value)) return value;
  if (isProjectChangedLiveEventFrame(value)) return value.event;
  return null;
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

export { isProjectChangedLiveEventFrame, isProjectChangedRefetchEnvelope };
