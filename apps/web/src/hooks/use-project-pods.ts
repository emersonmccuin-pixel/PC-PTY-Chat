// Section 17d.2 — Pods can be global OR project-scoped. The hook lists the
// union for the active project (globals + the project's project-scope rows)
// by passing projectId to listPods. WS broadcasts are still app-wide via
// broadcastAll(); the upsert ignores rows that belong to a different project.
//
// Envelope shapes:
//   { type: 'pod-changed', change: 'created' | 'updated', pod: Pod }       -- agent CRUD
//   { type: 'pod-changed', change: 'updated', podId, name }                -- nested mutation (knowledge/secret/mcp)
//   { type: 'pod-changed', change: 'deleted', podId, name }                -- soft delete
//
// On 'created' / 'updated' with a full `pod` field → apply the snapshot
// (only if scope='global' OR projectId matches the active project).
// On 'updated' without a `pod` field → refetch (a nested mutation changed
// updatedAt of the pod row, so the "edited Xmin ago" indicator needs to refresh).
// On 'deleted' → drop the row from the map.

import { useEffect, useMemo, useRef, useState } from 'react';

import type { Project, ULID } from '@/features/projects/client';
import { agentsApi, type Pod } from '@/features/agents/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';

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
  const [map, setMap] = useState<Map<ULID, Pod>>(() => new Map());
  const lastProcessedIdx = useRef<number>(0);

  // Initial fetch + project switch.
  useEffect(() => {
    if (!project) {
      setMap(new Map());
      lastProcessedIdx.current = 0;
      return;
    }
    let cancelled = false;
    void agentsApi.listPods(project.id).then((list) => {
      if (cancelled) return;
      setMap(new Map(list.map((p) => [p.id, p])));
    });
    lastProcessedIdx.current = events.length;
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  // Scan new envelopes since lastProcessedIdx; apply each in order.
  useEffect(() => {
    if (!project || events.length === 0) {
      lastProcessedIdx.current = events.length;
      return;
    }
    if (events.length < lastProcessedIdx.current) {
      // Buffer shrank (rare reset path) — re-scan from 0.
      lastProcessedIdx.current = 0;
    }
    const start = lastProcessedIdx.current;
    if (start >= events.length) return;

    let needsRefetch = false;
    const upserts: Pod[] = [];
    const deletes: ULID[] = [];

    for (let i = start; i < events.length; i++) {
      const env = events[i];
      if (!env || env.type !== 'pod-changed') continue;
      const e = env as PodChangedEnvelope;
      if (e.change === 'deleted') {
        if (e.podId) deletes.push(e.podId);
        continue;
      }
      if (e.pod) {
        // Filter to rows visible to this project: globals + this project's
        // project-scope rows. Other projects' rows arrive on the broadcast
        // because broadcastAll() is app-wide; ignore them.
        if (e.pod.scope === 'global' || e.pod.projectId === project.id) {
          upserts.push(e.pod);
        }
      } else {
        // Nested-mutation envelope: row's updatedAt advanced but we don't
        // have the snapshot. Refetch to keep "edited Xmin ago" honest.
        needsRefetch = true;
      }
    }
    lastProcessedIdx.current = events.length;

    if (upserts.length > 0 || deletes.length > 0) {
      setMap((prev) => {
        const next = new Map(prev);
        for (const pod of upserts) next.set(pod.id, pod);
        for (const id of deletes) next.delete(id);
        return next;
      });
    }

    if (needsRefetch) {
      void agentsApi.listPods(project.id).then((list) => {
        setMap(new Map(list.map((p) => [p.id, p])));
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, project?.id]);

  const pods = useMemo(
    () => Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name)),
    [map],
  );

  return {
    pods,
    refetch: () => {
      if (!project) return;
      void agentsApi.listPods(project.id).then((list) => {
        setMap(new Map(list.map((p) => [p.id, p])));
      });
    },
  };
}
