// UI Spine step 3 — version-aware id-keyed store slice for pods.
//
// Replaces the bespoke Map loop with useResourceList<Pod>. Each pod-changed
// envelope now carries a versioned full snapshot (the PodAgentRow with `rev`).
// Stale or duplicate WS deliveries are discarded when incoming rev ≤ stored rev.
//
// Scope filter: only project-scope pods for this project + stock globals.
// Cross-project envelopes from broadcastAll() are rejected by the extractor.
//
// Pod deletions: the delete envelope carries only podId + name (no full pod),
// so the useResourceList extractor skips it. A separate scan effect detects
// the delete and triggers refetch to purge the row from the map.

import { useEffect, useRef, useMemo } from 'react';
import type { Project, ULID } from '@/features/projects/client';
import { agentsApi, type Pod } from '@/features/agents/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { useResourceList } from '@/hooks/use-resource-list';

interface PodChangedEnvelope extends WsEnvelope {
  type: 'pod-changed';
  change: 'created' | 'updated' | 'deleted';
  pod?: Pod;
  podId?: ULID;
  name?: string;
}

export function useProjectPods(
  project: Project | null,
  events: WsEnvelope[],
): { pods: Pod[]; refetch: () => void } {
  const { records, refetch } = useResourceList<Pod>(project, events, {
    envelopeKind: 'pod-changed',
    extractSnapshot: (env, projectId) => {
      const e = env as PodChangedEnvelope;
      if (e.type !== 'pod-changed') return null;
      if (e.change === 'deleted') return null; // handled separately below
      if (!e.pod) return null;
      // Accept: project-scope pods for this project + stock globals.
      const pod = e.pod;
      if (pod.scope === 'project' && pod.projectId !== projectId) return null;
      if (pod.scope === 'global' && pod.origin !== 'stock') return null;
      return pod;
    },
    getId: (pod) => pod.id,
    isTerminal: () => false,
    dropOnTerminal: false,
    getVersion: (pod) => pod.rev,
    list: (projectId) => agentsApi.listPods(projectId as ULID),
  });

  // Detect pod-deleted envelopes and refetch so the deleted row is purged.
  const deleteIdx = useRef(0);
  useEffect(() => {
    if (events.length < deleteIdx.current) deleteIdx.current = 0;
    const start = deleteIdx.current;
    deleteIdx.current = events.length;
    if (start >= events.length) return;
    for (let i = start; i < events.length; i++) {
      const env = events[i];
      if (!env || env.type !== 'pod-changed') continue;
      if ((env as PodChangedEnvelope).change === 'deleted') {
        refetch();
        return;
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  // Sort alphabetically — mirrors the original hook.
  const pods = useMemo(
    () => [...records].sort((a, b) => a.name.localeCompare(b.name)),
    [records],
  );

  return { pods, refetch };
}
