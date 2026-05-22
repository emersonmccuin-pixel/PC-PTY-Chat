// Section 17d.2 — Pods are GLOBAL (not per-project). Hook subscribes to
// `pod-changed` envelopes on the active project's WS — they're broadcast
// app-wide by broadcastAll() so any connected project's WS sees every
// mutation.
//
// Envelope shapes:
//   { type: 'pod-changed', change: 'created' | 'updated', pod: Pod }       -- agent CRUD
//   { type: 'pod-changed', change: 'updated', podId, name }                -- nested mutation (knowledge/secret/mcp)
//   { type: 'pod-changed', change: 'deleted', podId, name }                -- soft delete
//
// On 'created' / 'updated' with a full `pod` field → apply the snapshot.
// On 'updated' without a `pod` field → refetch (a nested mutation changed
// updatedAt of the pod row, so the "edited Xmin ago" indicator needs to refresh).
// On 'deleted' → drop the row from the map.

import { useEffect, useMemo, useRef, useState } from 'react';

import type { Pod, Project, ULID } from '@/api/client';
import { api } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';

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
    void api.listPods().then((list) => {
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
        upserts.push(e.pod);
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
      void api.listPods().then((list) => {
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
      void api.listPods().then((list) => {
        setMap(new Map(list.map((p) => [p.id, p])));
      });
    },
  };
}
